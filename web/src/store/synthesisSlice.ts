import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react'
import * as designClient from '../lib/designClient'
import {
  queuedSynthesisForRequest,
  retainQueuedSynthesis,
  synthesisInput,
  type QueuedSynthesis,
  type SynthesisInput,
} from '../lib/synthesis/liveAnalysis'
import {
  firstYosysSourceError,
  type SynthesisDiagnostic,
} from '../lib/synthesis/yosysDiagnostics'
import { isAbortError } from '../lib/synthesis/synthesisError'
import type {
  DesignFile,
  Mode,
  SynthTool,
  SynthesizeResponse,
  VivadoBridgeStatus,
} from '../types'

export type AnalysisState =
  | 'none'
  | 'current'
  | 'stale'
  | 'refreshing'
  | 'error'

export interface StoreError {
  message: string
  log?: string
  status?: number
  kind?: designClient.DesignRequestFailureKind
  diagnostic?: SynthesisDiagnostic
}

type ResolvedInputIdentity = Pick<SynthesisInput, 'key' | 'revision'>

interface SynthesisQueueCallbacks {
  getCurrentRevision: () => number
  onRunningChange: (running: boolean) => void
  onAttemptStart: () => void
  onSuccess: (response: SynthesizeResponse, input: QueuedSynthesis) => void
  onError: (error: unknown, input: QueuedSynthesis) => void
}

export interface SynthesisQueue {
  request(input: QueuedSynthesis): Promise<void>
  invalidate(): void
  abort(): void
}

export function createSynthesisQueue(
  callbacks: SynthesisQueueCallbacks,
): SynthesisQueue {
  let running = false
  let runningKey: string | null = null
  let queued: QueuedSynthesis | null = null
  let abortController: AbortController | null = null

  return {
    async request(requested) {
      if (running) {
        // One bounded slot, always replaced by the newest complete input. A
        // revert to the running input clears an obsolete queued edit.
        queued = queuedSynthesisForRequest(runningKey, requested)
        return
      }

      running = true
      callbacks.onRunningChange(true)
      let next: QueuedSynthesis | null = requested
      try {
        while (next) {
          const current: QueuedSynthesis = next
          const controller = new AbortController()
          next = null
          queued = null
          runningKey = current.key
          abortController = controller
          callbacks.onAttemptStart()
          try {
            const response = await designClient.synthesize(
              current.request,
              controller.signal,
            )
            callbacks.onSuccess(response, current)
          } catch (error) {
            if (!isAbortError(error)) {
              callbacks.onError(error, current)
            }
          } finally {
            if (abortController === controller) abortController = null
          }

          // The queue may be replaced by another invocation while the request
          // is awaiting. Only the latest input that is still current survives.
          queued = retainQueuedSynthesis(queued, callbacks.getCurrentRevision())
          if (queued && queued.key !== current.key) next = queued
        }
      } finally {
        runningKey = null
        running = false
        callbacks.onRunningChange(false)
      }
    },
    invalidate() {
      queued = null
      abortController?.abort()
    },
    abort() {
      queued = null
      abortController?.abort()
    },
  }
}

interface SynthesisInputRefs {
  files: RefObject<DesignFile[]>
  top: RefObject<string>
  mode: RefObject<Mode>
  synthTool: RefObject<SynthTool>
  extraArgs: RefObject<string>
  vivadoStatus: RefObject<VivadoBridgeStatus | null>
  vivadoTarget: RefObject<string>
  vivadoExtraArgs: RefObject<string>
}

export function useSynthesisSlice({
  refs,
  afterSynthesis,
  clearVivadoConnection,
}: {
  refs: SynthesisInputRefs
  afterSynthesis: () => void
  clearVivadoConnection: (options: { markChanged?: boolean }) => void
}) {
  const [inputRevision, setInputRevision] = useState(0)
  const [resolvedInputIdentity, setResolvedInputIdentity] =
    useState<ResolvedInputIdentity | null>(null)
  const [synthesizing, setSynthesizing] = useState(false)
  const [design, setDesign] = useState<SynthesizeResponse | null>(null)
  const [designRevision, setDesignRevision] = useState(0)
  const [designInputKey, setDesignInputKey] = useState<string | null>(null)
  const [error, setError] = useState<StoreError | null>(null)

  const inputRevisionRef = useRef(inputRevision)
  inputRevisionRef.current = inputRevision
  const resolvedInputRef = useRef<SynthesisInput | null>(null)
  const requestedRevisionRef = useRef<number | null>(null)
  const designRef = useRef(design)
  designRef.current = design

  const materializeCurrentInput = useCallback((): SynthesisInput => {
    const revision = inputRevisionRef.current
    const cached = resolvedInputRef.current
    if (cached?.revision === revision) return cached

    const selectedPart = refs.vivadoStatus.current?.parts.find(
      (part) => part.name === refs.vivadoTarget.current,
    )
    const resolved = synthesisInput(
      refs.files.current,
      refs.top.current,
      refs.mode.current,
      refs.synthTool.current === 'vivado'
        ? refs.vivadoExtraArgs.current
        : refs.extraArgs.current,
      revision,
      refs.synthTool.current,
      refs.synthTool.current === 'vivado' && selectedPart && refs.vivadoStatus.current
        ? {
            name: selectedPart.name,
            family: selectedPart.family,
            speed: selectedPart.speed,
            version: `${refs.vivadoStatus.current.vivado_version}; bridge ${refs.vivadoStatus.current.bridge_version}`,
          }
        : undefined,
    )
    resolvedInputRef.current = resolved
    setResolvedInputIdentity((current) =>
      current?.revision === revision && current.key === resolved.key
        ? current
        : { revision, key: resolved.key },
    )
    return resolved
  }, [refs])

  const callbacksRef = useRef<SynthesisQueueCallbacks | null>(null)
  callbacksRef.current = {
    getCurrentRevision: () => inputRevisionRef.current,
    onRunningChange: setSynthesizing,
    onAttemptStart: () => setError(null),
    onSuccess: (response, running) => {
      setDesign(response)
      setDesignRevision((revision) => revision + 1)
      setDesignInputKey(running.key)
      afterSynthesis()
    },
    onError: (caught, running) => {
      const failure = caught as designClient.DesignRequestError
      setError({
        message: failure.message,
        log: failure.log,
        kind: failure.kind,
        diagnostic: firstYosysSourceError(
          failure.log,
          running.request.files.map((file) => file.name),
        ),
      })
      if (running.request.tool === 'vivado' && failure.kind === 'bridge') {
        clearVivadoConnection({ markChanged: false })
      }
    },
  }

  const queueRef = useRef<SynthesisQueue | null>(null)
  if (!queueRef.current) {
    queueRef.current = createSynthesisQueue({
      getCurrentRevision: () => callbacksRef.current!.getCurrentRevision(),
      onRunningChange: (running) =>
        callbacksRef.current!.onRunningChange(running),
      onAttemptStart: () => callbacksRef.current!.onAttemptStart(),
      onSuccess: (response, input) =>
        callbacksRef.current!.onSuccess(response, input),
      onError: (caught, input) => callbacksRef.current!.onError(caught, input),
    })
  }

  const markInputChanged = useCallback(() => {
    const revision = inputRevisionRef.current + 1
    inputRevisionRef.current = revision
    queueRef.current!.invalidate()
    setError(null)
    setInputRevision(revision)
  }, [])

  const requestSynthesis = useCallback(async () => {
    // Materializing the full request (and JSON-keying source content) happens
    // only after the auto-synthesis debounce, never per keystroke.
    const requested = materializeCurrentInput()
    requestedRevisionRef.current = requested.revision
    await queueRef.current!.request(requested)
  }, [materializeCurrentInput])

  const resetAnalysis = useCallback(() => {
    designRef.current = null
    setDesign(null)
    setDesignInputKey(null)
    setResolvedInputIdentity(null)
    setError(null)
  }, [])

  const resolvedCurrentInput =
    resolvedInputIdentity?.revision === inputRevision
      ? resolvedInputIdentity
      : null

  const analysisState: AnalysisState = synthesizing
    ? 'refreshing'
    : design == null
      ? error
        ? 'error'
        : 'none'
      : designInputKey === resolvedCurrentInput?.key
        ? 'current'
        : error
          ? 'error'
          : 'stale'
  const analysisStateRef = useRef<AnalysisState>(analysisState)
  analysisStateRef.current = analysisState

  return {
    inputRevision,
    inputRevisionRef,
    requestedRevisionRef,
    synthesizing,
    design,
    designRef,
    designRevision,
    analysisState,
    analysisStateRef,
    error,
    setError,
    markInputChanged,
    requestSynthesis,
    resetAnalysis,
    queue: queueRef.current,
  }
}

export function useSynthesisEffects({
  autoSynthesize,
  delayMs,
  synthTool,
  inputRevision,
  inputRevisionRef,
  requestedRevisionRef,
  requestSynthesis,
  queue,
}: {
  autoSynthesize: boolean
  delayMs: number
  synthTool: SynthTool
  inputRevision: number
  inputRevisionRef: RefObject<number>
  requestedRevisionRef: RefObject<number | null>
  requestSynthesis: () => Promise<void>
  queue: SynthesisQueue
}) {
  useEffect(() => {
    if (
      !autoSynthesize ||
      synthTool !== 'yosys' ||
      requestedRevisionRef.current === inputRevision
    ) {
      return
    }
    const scheduledRevision = inputRevision
    const timer = window.setTimeout(() => {
      if (
        inputRevisionRef.current === scheduledRevision &&
        requestedRevisionRef.current !== scheduledRevision
      ) {
        void requestSynthesis()
      }
    }, delayMs)
    return () => window.clearTimeout(timer)
  }, [
    autoSynthesize,
    delayMs,
    inputRevision,
    inputRevisionRef,
    requestSynthesis,
    requestedRevisionRef,
    synthTool,
  ])

  useEffect(() => () => queue.abort(), [queue])
}
