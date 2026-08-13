import type {
  EndpointsResponse,
  FanoutResponse,
  GroupExpansion,
  GroupExpansionOptions,
  NetlistOptions,
  PathsOptions,
  PathsResponse,
  ConeOptions,
  Subgraph,
  SynthesizeRequest,
  SynthesizeResponse,
  TimingRequest,
  TimingResponse,
} from '../../types'
import type { YosysWorkerResult } from '../engines/yosysProtocol'
import { initializeAnalysis, queryAnalysis } from '../analysisClient'
import { runGhdl } from '../engines/ghdlWorkerClient'
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
  type ValidatedSynthesis,
} from './yosysScript'
import { translatedYosysInput } from './vhdl'
import type { SynthEngine } from '../engines/types'
import { vivadoEngine } from '../engines/vivadoEngine'
import { yosysEngine } from '../engines/yosysEngine'
import {
  RequestValidationError,
  abortError,
  isAbortError,
} from './synthesisError'

interface AnalysisSummary {
  design_id: string
  top: string
  delay_profile: SynthesizeResponse['delay_profile']
  stats: SynthesizeResponse['stats']
  warnings: string[]
}

export async function synthesizeLocally(
  request: SynthesizeRequest,
  signal?: AbortSignal,
): Promise<SynthesizeResponse> {
  return synthesizeLocallyWithFallback(request, signal, true)
}

async function synthesizeLocallyWithFallback(
  request: SynthesizeRequest,
  signal: AbortSignal | undefined,
  allowReuse: boolean,
): Promise<SynthesizeResponse> {
  signal?.throwIfAborted()
  let input: ValidatedSynthesis
  try {
    input = validateSynthesisRequest(request)
  } catch (error) {
    throw new RequestValidationError(
      error instanceof Error ? error.message : String(error),
    )
  }
  const key = await synthesisKey(input)
  const designId = key.slice(0, 12)
  const cached = allowReuse ? await getCachedSynthesis(key, input) : null
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
      const coordinated = allowReuse ? await getCachedSynthesis(key, input) : null
      if (coordinated) return { ...coordinated, reused: true }
      const precomputed = allowReuse && input.tool !== 'vivado'
        ? await getPrecomputedSynthesis(key, input, signal)
        : null
      signal?.throwIfAborted()
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
      let yosysInput = input
      let ghdlLog = ''
      if (input.language === 'vhdl') {
        const translation = await runGhdl(input, signal)
        yosysInput = translatedYosysInput(input, translation)
        ghdlLog = translation.log
      }
      const engine: SynthEngine = input.tool === 'vivado' ? vivadoEngine : yosysEngine
      const produced = await engine.produce({ input, yosysInput, ghdlLog }, signal)
      generatedOutput = produced.output
      generatedMemoriesAbstracted = produced.memoriesAbstracted
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
      flatSourceNetlistJson: output.flatSourceNetlistJson,
      filesJson: JSON.stringify(input.files),
      mode: input.mode,
      tool: input.tool ?? 'yosys',
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
      // The recovery run below bypasses cache reads, so deletion is best-effort.
    }
    return synthesizeLocallyWithFallback(request, signal, false)
  }
  return {
    design_id: summary.design_id,
    top: summary.top,
    tool: input.tool ?? 'yosys',
    mode: input.mode,
    delay_profile: summary.delay_profile,
    target: input.target,
    stats: summary.stats,
    warnings: summary.warnings,
    log: output.log,
    vivado_timing: output.vivadoTiming,
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

export function localEndpoints(): Promise<EndpointsResponse> {
  return queryAnalysis('endpoints')
}

export function localTiming(request: TimingRequest): Promise<TimingResponse> {
  return queryAnalysis('timing', request)
}

export function localPaths(
  options: PathsOptions = {},
): Promise<PathsResponse> {
  return queryAnalysis('paths', options)
}

export function localCone(
  options: ConeOptions,
  signal?: AbortSignal,
): Promise<Subgraph> {
  const nodes = options.nodes?.length ? options.nodes : [options.node]
  return abortable(queryAnalysis('cone', { ...options, nodes }), signal)
}

export function localFanout(limit = 50): Promise<FanoutResponse> {
  return queryAnalysis('fanout', limit)
}

export function localNetlist(
  options: NetlistOptions = {},
  signal?: AbortSignal,
): Promise<Subgraph> {
  return abortable(
    queryAnalysis('netlist', { ...options, around: options.around ?? [] }),
    signal,
  )
}

export function localExpandGroup(
  options: GroupExpansionOptions,
  signal?: AbortSignal,
): Promise<GroupExpansion> {
  return abortable(queryAnalysis('expandGroup', options), signal)
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
