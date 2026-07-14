import type { DesignFile, Mode, SynthesizeRequest, SynthTool } from '../types'
import { boundedRetryDelayMs } from './retry'
import { buildSynthesizeRequest } from './synthesize'

export interface SourceSelection {
  file: string
  startLine: number
  endLine: number
}

export interface SynthesisInput {
  request: SynthesizeRequest
  key: string
  revision: number
}

export type SynthesisOrigin = 'manual' | 'automatic'

export interface QueuedSynthesis extends SynthesisInput {
  origin: SynthesisOrigin
}

export interface AutomaticSynthesisRetry {
  input: SynthesisInput
  delayMs: number
  generation: number
}

// This identity is exact but O(total source bytes). Callers deliberately
// materialize it only for a manual or debounced synthesis, never per edit.
export function synthesisInput(
  files: DesignFile[],
  top: string,
  mode: Mode,
  extraArgs: string,
  revision = 0,
  tool: SynthTool = 'yosys',
  target = '',
): SynthesisInput {
  const request = buildSynthesizeRequest(files, top, mode, extraArgs, tool, target)
  return { request, key: JSON.stringify(request), revision }
}

export function normalizeSourceSelection(
  file: string,
  startLine: number,
  endLine: number,
): SourceSelection {
  const start = Math.max(1, Math.min(startLine, endLine))
  const end = Math.max(start, Math.max(startLine, endLine))
  return { file, startLine: start, endLine: end }
}

/**
 * Keep a bounded synthesis queue aligned with the editor's current input.
 * A queued request becomes obsolete as soon as the input changes again; the
 * normal idle debounce decides whether the replacement should be enqueued.
 */
export function retainQueuedSynthesis(
  queued: QueuedSynthesis | null,
  currentRevision: number,
): QueuedSynthesis | null {
  return queued?.revision === currentRevision ? queued : null
}

/** The running request already covers a reverted input, so no follow-up is needed. */
export function queuedSynthesisForRequest(
  runningKey: string | null,
  requested: SynthesisInput,
  origin: SynthesisOrigin,
  queued: QueuedSynthesis | null = null,
): QueuedSynthesis | null {
  if (runningKey === requested.key) return null
  // An automatic request for the same input must not downgrade work that the
  // user explicitly queued. This lets pausing auto synthesis preserve it.
  if (
    origin === 'automatic' &&
    queued?.origin === 'manual' &&
    queued.key === requested.key
  ) {
    return queued
  }
  return { ...requested, origin }
}

/** Pausing auto synthesis cancels only idle-triggered work that has not started. */
export function clearAutomaticQueuedSynthesis(
  queued: QueuedSynthesis | null,
): QueuedSynthesis | null {
  return queued?.origin === 'automatic' ? null : queued
}

export function shouldRunAutomaticRetry(
  retry: AutomaticSynthesisRetry,
  current: SynthesisInput,
  autoEnabled: boolean,
  designKey: string | null,
  currentGeneration: number,
): boolean {
  return (
    autoEnabled &&
    retry.generation === currentGeneration &&
    retry.input.revision === current.revision &&
    retry.input.key === current.key &&
    designKey !== current.key
  )
}

/** Synchronously invalidates timers and in-flight automatic attempts from an older intent. */
export function supersedeAutomaticRetryGeneration(generation: number): number {
  return generation + 1
}

export function automaticRetryForFailure(
  input: SynthesisInput,
  origin: SynthesisOrigin,
  status: number,
  retryAfterMs: number | undefined,
  current: SynthesisInput,
  autoEnabled: boolean,
  designKey: string | null,
  attemptGeneration: number,
  currentGeneration: number,
): AutomaticSynthesisRetry | null {
  const retry = {
    input,
    delayMs: boundedRetryDelayMs(retryAfterMs),
    generation: attemptGeneration,
  }
  return origin === 'automatic' && status === 503 &&
    shouldRunAutomaticRetry(
      retry,
      current,
      autoEnabled,
      designKey,
      currentGeneration,
    )
    ? retry
    : null
}

export function analysisNeedsRefresh(
  currentKey: string,
  designKey: string | null,
  runningKey: string | null,
): boolean {
  return designKey !== currentKey || (runningKey != null && runningKey !== currentKey)
}
