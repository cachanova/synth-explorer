import type { ValidatedSynthesis } from './yosysScript'
import {
  GHDL_VERSION,
  YOSYS_CACHE_SCHEMA,
  YOSYS_VERSION,
} from './yosysScript'
import type { YosysWorkerResult } from '../workers/yosys.worker'

const databaseName = 'synth-explorer'
const storeName = 'syntheses'
const maxEntries = 24
const maxEstimatedBytes = 128 * 1024 * 1024
const maxAgeMs = 30 * 24 * 60 * 60 * 1_000
const encoder = new TextEncoder()

export interface SynthesisArtifact {
  schema: number
  producer: string
  key: string
  input: ValidatedSynthesis
  profile: string
  memoriesAbstracted: boolean
  output: YosysWorkerResult
}

export interface CachedSynthesis extends SynthesisArtifact {
  createdAt: number
  lastAccessedAt: number
  estimatedBytes: number
}

type SynthesisArtifactInput = Omit<SynthesisArtifact, 'schema' | 'producer'>

export async function synthesisKey(input: ValidatedSynthesis): Promise<string> {
  const canonical = JSON.stringify({
    schema: YOSYS_CACHE_SCHEMA,
    yosys: YOSYS_VERSION,
    ghdl: input.language === 'vhdl' ? GHDL_VERSION : null,
    mode: input.mode,
    top: input.top ?? null,
    extraArgs: input.extraArgs,
    files: input.files,
  })
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(canonical))
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export async function getCachedSynthesis(
  key: string,
  expectedInput: ValidatedSynthesis,
): Promise<CachedSynthesis | null> {
  try {
    const database = await openDatabase()
    const record = await request<CachedSynthesis | undefined>(
      database.transaction(storeName).objectStore(storeName).get(key),
    )
    if (!record) return null
    if (!isValidRecord(record, key, expectedInput)) {
      await deleteRecord(database, key)
      return null
    }
    record.lastAccessedAt = Date.now()
    const transaction = database.transaction(storeName, 'readwrite')
    transaction.objectStore(storeName).put(record)
    await complete(transaction)
    return record
  } catch {
    return null
  }
}

export async function putCachedSynthesis(
  record: SynthesisArtifactInput,
) {
  try {
    const database = await openDatabase()
    const now = Date.now()
    const completeRecord: CachedSynthesis = {
      ...record,
      schema: YOSYS_CACHE_SCHEMA,
      producer: synthesisProducer(record.input),
      createdAt: now,
      lastAccessedAt: now,
      estimatedBytes: estimateBytes(record),
    }
    if (completeRecord.estimatedBytes > maxEstimatedBytes) return
    const transaction = database.transaction(storeName, 'readwrite')
    transaction.objectStore(storeName).put(completeRecord)
    await complete(transaction)
    await prune(database)
  } catch {
    // IndexedDB can be unavailable in private mode or under quota pressure.
  }
}

export async function clearLocalSynthesisCache(): Promise<void> {
  const database = await openDatabase()
  const transaction = database.transaction(storeName, 'readwrite')
  transaction.objectStore(storeName).clear()
  await complete(transaction)
}

export async function deleteCachedSynthesis(key: string): Promise<void> {
  const database = await openDatabase()
  await deleteRecord(database, key)
}

async function prune(database: IDBDatabase) {
  const records = await request<CachedSynthesis[]>(
    database.transaction(storeName).objectStore(storeName).getAll(),
  )
  records.sort((left, right) => right.lastAccessedAt - left.lastAccessedAt)
  let retainedBytes = 0
  const remove = new Set<string>()
  for (const [index, record] of records.entries()) {
    if (!isStructurallyValid(record) || Date.now() - record.lastAccessedAt > maxAgeMs) {
      remove.add(record.key)
      continue
    }
    retainedBytes += record.estimatedBytes
    if (index >= maxEntries || retainedBytes > maxEstimatedBytes) remove.add(record.key)
  }
  if (remove.size === 0) return
  const transaction = database.transaction(storeName, 'readwrite')
  for (const key of remove) transaction.objectStore(storeName).delete(key)
  await complete(transaction)
}

function estimateBytes(record: SynthesisArtifactInput) {
  const sourceBytes = record.input.files.reduce(
    (total, file) => total + file.name.length + file.content.length,
    0,
  )
  return (
    2 *
    (sourceBytes +
      record.output.netlistJson.length +
      record.output.sourceNetlistJson.length +
      record.output.log.length)
  )
}

function isValidRecord(
  record: unknown,
  key: string,
  expectedInput: ValidatedSynthesis,
): record is CachedSynthesis {
  return (
    isStructurallyValid(record) &&
    isValidSynthesisArtifact(record, key, expectedInput) &&
    Date.now() - record.lastAccessedAt <= maxAgeMs &&
    record.createdAt <= record.lastAccessedAt
  )
}

export function isValidSynthesisArtifact(
  record: unknown,
  key: string,
  expectedInput: ValidatedSynthesis,
): record is SynthesisArtifact {
  return (
    isStructurallyValidArtifact(record) &&
    record.key === key &&
    record.schema === YOSYS_CACHE_SCHEMA &&
    record.producer === synthesisProducer(expectedInput) &&
    JSON.stringify(record.input) === JSON.stringify(expectedInput)
  )
}

export function synthesisProducer(input: ValidatedSynthesis): string {
  return input.language === 'vhdl'
    ? `${YOSYS_VERSION}+ghdl-${GHDL_VERSION}`
    : YOSYS_VERSION
}

function isStructurallyValid(record: unknown): record is CachedSynthesis {
  if (!isStructurallyValidArtifact(record)) return false
  const candidate = record as Partial<CachedSynthesis>
  return (
    typeof candidate.createdAt === 'number' &&
    typeof candidate.lastAccessedAt === 'number' &&
    typeof candidate.estimatedBytes === 'number' &&
    candidate.estimatedBytes >= 0
  )
}

function isStructurallyValidArtifact(
  record: unknown,
): record is SynthesisArtifact {
  if (typeof record !== 'object' || record === null) return false
  const candidate = record as Partial<SynthesisArtifact>
  return (
    typeof candidate.key === 'string' &&
    typeof candidate.schema === 'number' &&
    typeof candidate.producer === 'string' &&
    typeof candidate.profile === 'string' &&
    typeof candidate.memoriesAbstracted === 'boolean' &&
    typeof candidate.input === 'object' &&
    candidate.input !== null &&
    typeof candidate.output === 'object' &&
    candidate.output !== null &&
    typeof candidate.output.netlistJson === 'string' &&
    typeof candidate.output.sourceNetlistJson === 'string' &&
    typeof candidate.output.log === 'string'
  )
}

async function deleteRecord(database: IDBDatabase, key: string): Promise<void> {
  const transaction = database.transaction(storeName, 'readwrite')
  transaction.objectStore(storeName).delete(key)
  await complete(transaction)
}

let databasePromise: Promise<IDBDatabase> | null = null

function openDatabase(): Promise<IDBDatabase> {
  databasePromise ??= new Promise((resolve, reject) => {
    const open = indexedDB.open(databaseName, 1)
    open.onupgradeneeded = () => {
      const database = open.result
      if (!database.objectStoreNames.contains(storeName)) {
        database.createObjectStore(storeName, { keyPath: 'key' })
      }
    }
    open.onsuccess = () => resolve(open.result)
    open.onerror = () => reject(open.error)
    open.onblocked = () => reject(new Error('synthesis cache upgrade is blocked'))
  })
  return databasePromise
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result)
    value.onerror = () => reject(value.error)
  })
}

function complete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
    transaction.onerror = () => reject(transaction.error)
  })
}
