import type {
  EndpointsResponse,
  ExplorationSnapshot,
  FanoutResponse,
  NodesResponse,
  PathsResponse,
  SourceMapResponse,
  Subgraph,
  SynthesizeRequest,
  SynthesizeResponse,
  TimingRequest,
  TimingResponse,
} from '../types'
import type { ConeOptions, NetlistOptions } from '../api'
import type { YosysWorkerResult } from '../workers/yosys.worker'
import { initializeAnalysis, queryAnalysis } from './analysisClient'
import { getCachedSynthesis, putCachedSynthesis } from './designCache'
import {
  YOSYS_CACHE_SCHEMA,
  YOSYS_VERSION,
  defaultDelayProfile,
  validateSynthesisRequest,
  type MemoryHandling,
  type ValidatedSynthesis,
} from './yosysScript'

interface AnalysisSummary {
  design_id: string
  top: string
  delay_profile: SynthesizeResponse['delay_profile']
  stats: SynthesizeResponse['stats']
  warnings: string[]
}

interface YosysWorkerResponse {
  ok: boolean
  result?: YosysWorkerResult
  error?: string
  log?: string
}

const encoder = new TextEncoder()

export async function synthesizeLocally(request: SynthesizeRequest): Promise<SynthesizeResponse> {
  const input = validateSynthesisRequest(request)
  const key = await synthesisKey(input)
  const designId = key.slice(0, 12)
  const cached = await getCachedSynthesis(key, input)
  let output: YosysWorkerResult
  let memoriesAbstracted: boolean
  let profile: string

  if (cached) {
    output = cached.output
    memoriesAbstracted = cached.memoriesAbstracted
    profile = cached.profile
  } else {
    const generated = await withSynthesisLock(key, async () => {
      const coordinated = await getCachedSynthesis(key, input)
      if (coordinated) return coordinated
      const generatedProfile = defaultDelayProfile(input)
      let generatedOutput: YosysWorkerResult
      let generatedMemoriesAbstracted = false
      try {
        generatedOutput = await runYosys(input, 'map')
      } catch (error) {
        if (!isResourceFailure(error) || !isGeneric(input.mode)) throw error
        generatedOutput = await runYosys(input, 'abstract')
        generatedMemoriesAbstracted = true
      }
      await putCachedSynthesis({
        key,
        input,
        profile: generatedProfile,
        memoriesAbstracted: generatedMemoriesAbstracted,
        output: generatedOutput,
      })
      return {
        profile: generatedProfile,
        memoriesAbstracted: generatedMemoriesAbstracted,
        output: generatedOutput,
      }
    })
    output = generated.output
    memoriesAbstracted = generated.memoriesAbstracted
    profile = generated.profile
  }

  const summary = await initializeAnalysis<AnalysisSummary>({
    designId,
    netlistJson: output.netlistJson,
    sourceNetlistJson: output.sourceNetlistJson,
    filesJson: JSON.stringify(input.files),
    mode: input.mode,
    profile,
  })
  return {
    design_id: summary.design_id,
    top: summary.top,
    tool: 'yosys',
    mode: input.mode,
    delay_profile: summary.delay_profile,
    stats: summary.stats,
    warnings: summary.warnings,
    log: output.log,
    memories_abstracted: memoriesAbstracted || undefined,
  }
}

function withSynthesisLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  if (!navigator.locks) return action()
  return navigator.locks.request(`synth-explorer:${key}`, action)
}

export function localEndpoints(_id: string): Promise<EndpointsResponse> {
  return queryAnalysis('endpoints')
}

export function localTiming(_id: string, request: TimingRequest): Promise<TimingResponse> {
  return queryAnalysis('timing', request)
}

export function localPaths(
  _id: string,
  options: Parameters<typeof import('../api').getPaths>[1] = {},
): Promise<PathsResponse> {
  return queryAnalysis('paths', options)
}

export function localCone(
  _id: string,
  options: ConeOptions,
  signal?: AbortSignal,
): Promise<Subgraph> {
  const nodes = options.nodes?.length ? options.nodes : [options.node]
  return abortable(queryAnalysis('cone', { ...options, nodes }), signal)
}

export function localFanout(_id: string, limit = 50): Promise<FanoutResponse> {
  return queryAnalysis('fanout', limit)
}

export function localNetlist(
  _id: string,
  options: NetlistOptions = {},
  signal?: AbortSignal,
): Promise<Subgraph> {
  return abortable(
    queryAnalysis('netlist', { ...options, around: options.around ?? [] }),
    signal,
  )
}

export function localSourceMap(_id: string): Promise<SourceMapResponse> {
  return queryAnalysis('sourceMap')
}

export function localNodes(_id: string, ids: number[]): Promise<NodesResponse> {
  return queryAnalysis('nodes', ids.slice(0, 200))
}

export function localExploration(_id: string): Promise<ExplorationSnapshot> {
  return queryAnalysis('exploration')
}

async function synthesisKey(input: ValidatedSynthesis): Promise<string> {
  const canonical = JSON.stringify({
    schema: YOSYS_CACHE_SCHEMA,
    yosys: YOSYS_VERSION,
    mode: input.mode,
    top: input.top ?? null,
    extraArgs: input.extraArgs,
    files: input.files,
  })
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(canonical))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function runYosys(input: ValidatedSynthesis, memory: MemoryHandling): Promise<YosysWorkerResult> {
  const worker = new Worker(new URL('../workers/yosys.worker.ts', import.meta.url), {
    type: 'module',
  })
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      worker.terminate()
      reject(new LocalSynthesisError('yosys timed out', ''))
    }, 60_000)
    worker.onmessage = (event: MessageEvent<YosysWorkerResponse>) => {
      clearTimeout(timeout)
      worker.terminate()
      const response = event.data
      if (response.ok && response.result) resolve(response.result)
      else reject(new LocalSynthesisError(response.error ?? 'yosys failed', response.log ?? ''))
    }
    worker.onerror = (event) => {
      clearTimeout(timeout)
      worker.terminate()
      reject(new LocalSynthesisError(event.message || 'yosys worker failed', ''))
    }
    worker.postMessage({ input, memory })
  })
}

function isGeneric(mode: ValidatedSynthesis['mode']): boolean {
  return mode === 'gates' || mode === 'lut4' || mode === 'lut6'
}

function isResourceFailure(error: unknown): boolean {
  if (!(error instanceof LocalSynthesisError)) return false
  const detail = `${error.message}\n${error.log}`
  return /timed out|bad_alloc|out of memory|memory access out of bounds/i.test(detail)
}

export class LocalSynthesisError extends Error {
  readonly log: string

  constructor(message: string, log: string) {
    super(message)
    this.name = 'LocalSynthesisError'
    this.log = log
  }
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError())
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

function abortError(): Error {
  return new DOMException('The operation was aborted', 'AbortError')
}
