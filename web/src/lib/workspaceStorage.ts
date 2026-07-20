import type { DesignFile, Mode } from '../types'

const DATABASE_NAME = 'synth-explorer-workspace'
const STORE_NAME = 'drafts'
const CURRENT_WORKSPACE_KEY = 'current'
const WORKSPACE_SCHEMA = 1
const RESET_CONFIRMATION_KEY = 'synthexplorer.confirmResetWorkspace.v1'
const RESET_PENDING_KEY = 'synthexplorer.workspaceResetPending.v1'
const EDITOR_KEYMAP_KEY = 'synthexplorer.editorKeymap.v1'
const EDITOR_LINE_NUMBERS_KEY = 'synthexplorer.editorLineNumbers.v1'

export type EditorKeymap = 'standard' | 'vim'
export type EditorLineNumbers = 'regular' | 'relative' | 'hybrid'

const MODES = new Set<Mode>([
  'rtl',
  'gates',
  'lut4',
  'lut6',
  'ice40',
  'ecp5',
  'xilinx',
])

export interface WorkspaceState {
  files: DesignFile[]
  activeFileName: string
  top: string
  mode: Mode
  extraArgs: string
}

interface StoredWorkspace extends WorkspaceState {
  schema: typeof WORKSPACE_SCHEMA
}

let workspaceSaveQueue: Promise<void> = Promise.resolve()

export function parseStoredWorkspace(value: unknown): WorkspaceState | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.schema !== WORKSPACE_SCHEMA) return null
  if (!Array.isArray(record.files) || record.files.length === 0) return null

  const files: DesignFile[] = []
  const names = new Set<string>()
  for (const value of record.files) {
    if (!value || typeof value !== 'object') return null
    const file = value as Record<string, unknown>
    if (
      typeof file.name !== 'string' ||
      typeof file.content !== 'string' ||
      !file.name ||
      file.name.includes('..') ||
      !/^[A-Za-z0-9._-]+$/.test(file.name) ||
      names.has(file.name)
    ) {
      return null
    }
    names.add(file.name)
    files.push({ name: file.name, content: file.content })
  }

  if (
    typeof record.activeFileName !== 'string' ||
    !names.has(record.activeFileName) ||
    typeof record.top !== 'string' ||
    typeof record.mode !== 'string' ||
    !MODES.has(record.mode as Mode) ||
    typeof record.extraArgs !== 'string'
  ) {
    return null
  }

  return {
    files,
    activeFileName: record.activeFileName,
    top: record.top,
    mode: record.mode as Mode,
    extraArgs: record.extraArgs,
  }
}

export async function loadWorkspace(): Promise<WorkspaceState | null> {
  let database: IDBDatabase | null = null
  try {
    database = await openDatabase()
    const pendingReset = readPendingWorkspaceReset()
    if (pendingReset.present) {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      if (pendingReset.workspace) {
        const stored: StoredWorkspace = {
          schema: WORKSPACE_SCHEMA,
          ...pendingReset.workspace,
        }
        transaction.objectStore(STORE_NAME).put(stored, CURRENT_WORKSPACE_KEY)
      } else {
        transaction.objectStore(STORE_NAME).delete(CURRENT_WORKSPACE_KEY)
      }
      await complete(transaction)
      clearWorkspaceResetPending()
      return pendingReset.workspace
    }
    const value = await request<unknown>(
      database.transaction(STORE_NAME).objectStore(STORE_NAME).get(CURRENT_WORKSPACE_KEY),
    )
    const workspace = parseStoredWorkspace(value)
    if (!workspace && value !== undefined) {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      transaction.objectStore(STORE_NAME).delete(CURRENT_WORKSPACE_KEY)
      await complete(transaction)
    }
    return workspace
  } catch {
    return null
  } finally {
    database?.close()
  }
}

export function saveWorkspace(
  workspace: WorkspaceState,
  completesReset = false,
): Promise<void> {
  const operation = workspaceSaveQueue.then(() =>
    writeWorkspace(workspace, completesReset),
  )
  workspaceSaveQueue = operation.catch(() => {})
  return operation
}

async function writeWorkspace(
  workspace: WorkspaceState,
  completesReset: boolean,
): Promise<void> {
  let database: IDBDatabase | null = null
  try {
    if (readPendingWorkspaceReset().present && !completesReset) return
    database = await openDatabase()
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    const stored: StoredWorkspace = { schema: WORKSPACE_SCHEMA, ...workspace }
    transaction.objectStore(STORE_NAME).put(stored, CURRENT_WORKSPACE_KEY)
    await complete(transaction)
    if (completesReset) clearWorkspaceResetPending()
  } catch {
    // Storage can be unavailable in private mode or under quota pressure.
    // The in-memory editor remains fully usable.
  } finally {
    database?.close()
  }
}

export function markWorkspaceResetPending(workspace: WorkspaceState): void {
  try {
    const stored: StoredWorkspace = { schema: WORKSPACE_SCHEMA, ...workspace }
    localStorage.setItem(RESET_PENDING_KEY, JSON.stringify(stored))
  } catch {
    // The immediate IndexedDB write remains the fallback when storage is blocked.
  }
}

export function loadResetConfirmationPreference(): boolean {
  try {
    return localStorage.getItem(RESET_CONFIRMATION_KEY) !== 'false'
  } catch {
    return true
  }
}

export function saveResetConfirmationPreference(enabled: boolean): void {
  try {
    localStorage.setItem(RESET_CONFIRMATION_KEY, String(enabled))
  } catch {
    // Keep the preference for this session when local storage is unavailable.
  }
}

export function loadEditorKeymapPreference(): EditorKeymap {
  try {
    return localStorage.getItem(EDITOR_KEYMAP_KEY) === 'vim' ? 'vim' : 'standard'
  } catch {
    return 'standard'
  }
}

export function saveEditorKeymapPreference(keymap: EditorKeymap): void {
  try {
    localStorage.setItem(EDITOR_KEYMAP_KEY, keymap)
  } catch {
    // Keep the preference for this session when local storage is unavailable.
  }
}

export function loadEditorLineNumbersPreference(): EditorLineNumbers {
  try {
    const stored = localStorage.getItem(EDITOR_LINE_NUMBERS_KEY)
    return stored === 'relative' || stored === 'hybrid' ? stored : 'regular'
  } catch {
    return 'regular'
  }
}

export function saveEditorLineNumbersPreference(mode: EditorLineNumbers): void {
  try {
    localStorage.setItem(EDITOR_LINE_NUMBERS_KEY, mode)
  } catch {
    // Keep the preference for this session when local storage is unavailable.
  }
}

function readPendingWorkspaceReset(): {
  present: boolean
  workspace: WorkspaceState | null
} {
  try {
    const raw = localStorage.getItem(RESET_PENDING_KEY)
    if (raw == null) return { present: false, workspace: null }
    return { present: true, workspace: parseStoredWorkspace(JSON.parse(raw)) }
  } catch {
    return { present: false, workspace: null }
  }
}

function clearWorkspaceResetPending(): void {
  try {
    localStorage.removeItem(RESET_PENDING_KEY)
  } catch {
    // Nothing else relies on this marker when local storage is unavailable.
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DATABASE_NAME, 1)
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STORE_NAME)) {
        open.result.createObjectStore(STORE_NAME)
      }
    }
    open.onsuccess = () => resolve(open.result)
    open.onerror = () => reject(open.error)
    open.onblocked = () => reject(new Error('workspace database is blocked'))
  })
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
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}
