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
import { EngineLoadError } from './engineLoad'
import { getPrecomputedSynthesis } from './precomputedSynthesis'
import {
  deleteCachedSynthesis,
  getCachedSynthesis,
  putCachedSynthesis,
  synthesisKey,
} from './designCache'
import {
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
  kind?: 'load'
  log?: string
}

let idleYosysWorker: Worker | null = null

export async function synthesizeLocally(
  request: SynthesizeRequest,
  signal?: AbortSignal,
): Promise<SynthesizeResponse> {
  return synthesizeLocallyWithFallback(request, signal, true)
}

async function synthesizeLocallyWithFallback(
  request: SynthesizeRequest,
  signal: AbortSignal | undefined,
  allowPrecomputed: boolean,
): Promise<SynthesizeResponse> {
  signal?.throwIfAborted()
  const input = validateSynthesisRequest(request)
  const key = await synthesisKey(input)
  const designId = key.slice(0, 12)
  const cached = await getCachedSynthesis(key, input)
  let output: YosysWorkerResult
  let memoriesAbstracted: boolean
  let profile: string
  let reusedSynthesis = cached !== null

  if (cached) {
    output = cached.output
    memoriesAbstracted = cached.memoriesAbstracted
    profile = cached.profile
  } else {
    const generated = await withSynthesisLock(key, async () => {
      signal?.throwIfAborted()
      const coordinated = await getCachedSynthesis(key, input)
      if (coordinated) return { ...coordinated, reused: true }
      const precomputed = allowPrecomputed
        ? await getPrecomputedSynthesis(key, input)
        : null
      if (precomputed) {
        await putCachedSynthesis({
          key,
          input,
          profile: precomputed.profile,
          memoriesAbstracted: precomputed.memoriesAbstracted,
          output: precomputed.output,
        })
        return { ...precomputed, reused: true }
      }
      const generatedProfile = defaultDelayProfile(input)
      let generatedOutput: YosysWorkerResult
      let generatedMemoriesAbstracted = false
      try {
        generatedOutput = await runYosys(input, 'map', signal)
      } catch (error) {
        if (isAbortError(error)) throw error
        if (!isResourceFailure(error) || !isGeneric(input.mode)) throw error
        generatedOutput = await runYosys(input, 'abstract', signal)
        generatedMemoriesAbstracted = true
      }
      signal?.throwIfAborted()
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
        reused: false,
      }
    }, signal)
    output = generated.output
    memoriesAbstracted = generated.memoriesAbstracted
    profile = generated.profile
    reusedSynthesis = generated.reused
  }

  let summary: AnalysisSummary
  try {
    signal?.throwIfAborted()
    summary = await initializeAnalysis<AnalysisSummary>({
      designId,
      netlistJson: output.netlistJson,
      sourceNetlistJson: output.sourceNetlistJson,
      filesJson: JSON.stringify(input.files),
      mode: input.mode,
      profile,
    })
    signal?.throwIfAborted()
  } catch (error) {
    if (isAbortError(error)) throw error
    // An engine load failure says nothing about the cached synthesis: keep
    // the cache and surface the failure instead of re-running Yosys just to
    // fail the same download again.
    if (!reusedSynthesis || error instanceof EngineLoadError) throw error
    try {
      await deleteCachedSynthesis(key)
    } catch {
      throw error
    }
    return synthesizeLocallyWithFallback(request, signal, false)
  }
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

function withSynthesisLock<T>(
  key: string,
  action: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted()
  if (!navigator.locks) return action()
  return signal
    ? navigator.locks.request(`synth-explorer:${key}`, { signal }, action)
    : navigator.locks.request(`synth-explorer:${key}`, action)
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

function runYosys(
  input: ValidatedSynthesis,
  memory: MemoryHandling,
  signal?: AbortSignal,
): Promise<YosysWorkerResult> {
  const worker = acquireYosysWorker()
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (action: () => void, reusable: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      if (reusable) releaseYosysWorker(worker)
      else discardYosysWorker(worker)
      action()
    }
    const onAbort = () => finish(() => reject(abortError()), false)
    const timeout = setTimeout(() => {
      finish(() => reject(new LocalSynthesisError('yosys timed out', '', 'timeout')), false)
    }, 60_000)
    worker.onmessage = (event: MessageEvent<YosysWorkerResponse>) => {
      const response = event.data
      finish(() => {
        if (response.ok && response.result) resolve(response.result)
        else {
          reject(
            new LocalSynthesisError(response.error ?? 'yosys failed', response.log ?? '', response.kind),
          )
        }
      }, true)
    }
    // run() catches everything inside the worker, so an 'error' event here
    // means the worker script itself failed to load or parse.
    worker.onerror = (event) => {
      finish(
        () =>
          reject(
            new LocalSynthesisError(event.message || 'failed to load the Yosys worker', '', 'load'),
          ),
        false,
      )
    }
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      worker.postMessage({ input, memory })
    } catch (error) {
      finish(() => reject(error), false)
    }
  })
}

function createYosysWorker(): Worker {
  return new Worker(new URL('../workers/yosys.worker.ts', import.meta.url), {
    type: 'module',
  })
}

function acquireYosysWorker(): Worker {
  const worker = idleYosysWorker ?? createYosysWorker()
  idleYosysWorker = null
  return worker
}

function releaseYosysWorker(worker: Worker): void {
  idleYosysWorker?.terminate()
  worker.onmessage = null
  worker.onerror = null
  idleYosysWorker = worker
}

function discardYosysWorker(worker: Worker): void {
  worker.terminate()
  if (!idleYosysWorker) idleYosysWorker = createYosysWorker()
}

function isGeneric(mode: ValidatedSynthesis['mode']): boolean {
  return mode === 'gates' || mode === 'lut4' || mode === 'lut6'
}

export function isResourceFailure(error: unknown): boolean {
  if (!(error instanceof LocalSynthesisError)) return false
  // A load failure is a network problem, not a resource limit: retrying with
  // abstracted memories could cache a degraded synthesis for a design that
  // never exceeded anything.
  if (error.kind === 'load') return false
  if (error.kind === 'timeout') return true
  const detail = `${error.message}\n${error.log}`
  return /bad_alloc|out of memory|memory access out of bounds/i.test(detail)
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export type SynthesisFailureKind = 'load' | 'timeout'

export class LocalSynthesisError extends Error {
  readonly log: string
  readonly kind?: SynthesisFailureKind

  constructor(message: string, log: string, kind?: SynthesisFailureKind) {
    super(message)
    this.name = 'LocalSynthesisError'
    this.log = log
    this.kind = kind
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
