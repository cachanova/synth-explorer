import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import * as api from './api'
import { DEFAULT_FILE, defaultWorkspace } from './data/defaultWorkspace'
import { StoreContext } from './storeContext'
import { DEFAULT_GRAPH_MAX_NODES } from './lib/graphLimits'
import {
  createSourceProbeDebouncer,
  normalizeSourceSelection,
  queuedSynthesisForRequest,
  retainQueuedSynthesis,
  synthesisInput,
  type QueuedSynthesis,
  type SourceSelection,
  type SynthesisInput,
} from './lib/liveAnalysis'
import { displayNodeName } from './lib/prettyType'
import { createLatestGuard } from './lib/latest'
import { mergeComputerFiles } from './lib/computerFiles'
import { designSrcSpans, type SrcSpan } from './lib/src'
import {
  firstYosysSourceError,
  type SynthesisDiagnostic,
} from './lib/yosysDiagnostics'
import {
  loadEditorKeymapPreference,
  loadResetConfirmationPreference,
  markWorkspaceResetPending,
  saveEditorKeymapPreference,
  saveResetConfirmationPreference,
  saveWorkspace,
  type EditorKeymap,
  type WorkspaceState,
} from './lib/workspaceStorage'
import {
  clampAutoSynthesisDelay,
  loadSynthesisSettings,
  saveSynthesisSettings,
} from './lib/synthesisSettings'
import {
  flagsForModeTransition,
  type ModeFlagMemory,
} from './lib/flagRegistry'
import type {
  DesignFile,
  Example,
  ExampleVariant,
  Mode,
  SynthesizeResponse,
  TimingPath,
} from './types'

export type TabId =
  | 'overview'
  | 'endpoints'
  | 'paths'
  | 'fanout'
  | 'graph'

export interface ConeGraphRequest {
  kind: 'cone'
  designId: string
  node: number // primary root (nodes[0]); drives root highlighting
  nodes: number[] // all cone roots (>= 1); union under one budget
  dir: 'fanin' | 'fanout'
  label: string // human description for the graph header
  // node ids to highlight (e.g. a path); empty for plain cones
  highlight: number[]
  nonce: number // force re-render even if identical request
}

export interface SourceGraphRequest {
  kind: 'source'
  file: string
  startLine: number
  endLine: number
  selectionTruncated: boolean
  label: string
  highlight: number[]
  nonce: number
}

export type GraphRequest =
  | ConeGraphRequest
  | SourceGraphRequest

export interface GraphOptions {
  maxDepth: number
  maxNodes: number
  hideControl: boolean
  hideConst: boolean
  focus: boolean
  groupVectors: boolean
}

export interface EditorHighlight {
  spans: SrcSpan[]
  primary: number
  nonce: number
}

export type AnalysisState =
  | 'none'
  | 'current'
  | 'stale'
  | 'refreshing'
  | 'error'

type ResolvedInputIdentity = Pick<SynthesisInput, 'key' | 'revision'>

const MAX_SOURCE_LINES = 200

const DEFAULT_GRAPH_OPTIONS: GraphOptions = {
  maxDepth: 64,
  maxNodes: DEFAULT_GRAPH_MAX_NODES,
  hideControl: true,
  hideConst: true,
  focus: true,
  groupVectors: true,
}

function sourceGraphRequest(
  selection: SourceSelection,
  nonce: number,
): SourceGraphRequest {
  const endLine = Math.min(
    selection.endLine,
    selection.startLine + MAX_SOURCE_LINES - 1,
  )
  const lineLabel =
    selection.startLine === endLine
      ? `line ${selection.startLine}`
      : `lines ${selection.startLine}–${endLine}`
  return {
    kind: 'source',
    file: selection.file,
    startLine: selection.startLine,
    endLine,
    selectionTruncated: endLine !== selection.endLine,
    label: `${selection.file}:${lineLabel}`,
    highlight: [],
    nonce,
  }
}

export interface Store {
  // editor / inputs
  files: DesignFile[]
  activeFileName: string
  /** Bumped when file content is replaced outside the editor (example load). */
  docRevision: number
  top: string
  mode: Mode
  extraArgs: string
  examples: Example[]

  setActiveFileName: (name: string) => void
  updateFileContent: (name: string, content: string) => void
  addFile: () => void
  importFiles: (files: DesignFile[]) => void
  renameFile: (oldName: string, newName: string) => void
  deleteFile: (name: string) => void
  resetWorkspace: () => void
  setTop: (t: string) => void
  setMode: (m: Mode) => void
  setExtraArgs: (a: string) => void
  loadExample: (variant: ExampleVariant) => void
  confirmWorkspaceReset: boolean
  setConfirmWorkspaceReset: (enabled: boolean) => void
  editorKeymap: EditorKeymap
  setEditorKeymap: (keymap: EditorKeymap) => void
  autoSynthesize: boolean
  setAutoSynthesize: (enabled: boolean) => void
  autoSynthesisDelayMs: number
  setAutoSynthesisDelayMs: (delayMs: number) => void

  // synthesis
  synthesizing: boolean
  synthesize: () => Promise<void>
  design: SynthesizeResponse | null
  analysisState: AnalysisState
  error: {
    message: string
    log?: string
    status?: number
    diagnostic?: SynthesisDiagnostic
  } | null

  // tabs
  activeTab: TabId
  setActiveTab: (t: TabId) => void

  // graph
  coneReq: GraphRequest | null
  graphOptions: GraphOptions
  setGraphOptions: (patch: Partial<GraphOptions>) => void
  openCone: (opts: {
    node?: number
    nodes?: number[]
    dir: 'fanin' | 'fanout'
    label: string
    highlight?: number[]
  }) => void
  openControlCone: (opts: {
    node: number
    label: string
    generated?: boolean
  }) => void
  showPathInGraph: (path: TimingPath) => void
  clearGraphSelection: () => void

  // cross-probe: graph node src -> editor highlight
  editorHighlight: EditorHighlight | null
  highlightSources: (spans: SrcSpan[]) => void
  highlightNodeSources: (src?: string | null) => void

  // cross-probe: editor -> graph nodes
  sourceSelection: SourceSelection
  setSourceSelection: (file: string, startLine: number, endLine: number) => void
}

export interface StoreApi {
  getSnapshot(): Store
  publish(next: Store): void
  subscribe(listener: () => void): () => void
}

function createStoreApi(initial: Store): StoreApi {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    publish(next) {
      if (Object.is(snapshot, next)) return
      snapshot = next
      for (const listener of listeners) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export function StoreProvider({
  children,
  initialWorkspace,
}: {
  children: ReactNode
  initialWorkspace?: WorkspaceState | null
}) {
  const initial = initialWorkspace ?? defaultWorkspace()
  const [files, setFiles] = useState<DesignFile[]>(initial.files)
  const [activeFileName, setActiveFileNameState] = useState(initial.activeFileName)
  const [docRevision, setDocRevision] = useState(0)
  const [top, setTopState] = useState(initial.top)
  const [mode, setModeState] = useState<Mode>(initial.mode)
  const [extraArgs, setExtraArgsState] = useState(initial.extraArgs)
  const [confirmWorkspaceReset, setConfirmWorkspaceResetState] = useState(
    loadResetConfirmationPreference,
  )
  const [editorKeymap, setEditorKeymapState] = useState(
    loadEditorKeymapPreference,
  )
  const [synthesisSettings, setSynthesisSettings] = useState(
    loadSynthesisSettings,
  )
  const [inputRevision, setInputRevision] = useState(0)
  const [resolvedInputIdentity, setResolvedInputIdentity] =
    useState<ResolvedInputIdentity | null>(null)
  const [examples, setExamples] = useState<Example[]>([])

  const [synthesizing, setSynthesizing] = useState(false)
  const [design, setDesign] = useState<SynthesizeResponse | null>(null)
  const [designInputKey, setDesignInputKey] = useState<string | null>(null)
  const [error, setError] = useState<Store['error']>(null)

  const setAutoSynthesize = useCallback((enabled: boolean) => {
    setSynthesisSettings((current) =>
      current.autoSynthesize === enabled
        ? current
        : { ...current, autoSynthesize: enabled },
    )
  }, [])
  const setAutoSynthesisDelayMs = useCallback((delayMs: number) => {
    const clamped = clampAutoSynthesisDelay(delayMs)
    setSynthesisSettings((current) =>
      current.delayMs === clamped ? current : { ...current, delayMs: clamped },
    )
  }, [])

  useEffect(() => saveSynthesisSettings(synthesisSettings), [synthesisSettings])

  const [activeTab, setActiveTab] = useState<TabId>('graph')

  const [coneReq, setConeReq] = useState<GraphRequest | null>(null)
  const [graphOptions, setGraphOptionsState] = useState<GraphOptions>(
    DEFAULT_GRAPH_OPTIONS,
  )

  const [editorHighlight, setEditorHighlight] = useState<EditorHighlight | null>(
    null,
  )
  const [sourceSelection, setSourceSelectionState] = useState<SourceSelection>({
    file: initial.activeFileName,
    startLine: 1,
    endLine: 1,
  })

  const nonceGuardRef = useRef<ReturnType<typeof createLatestGuard> | null>(null)
  if (!nonceGuardRef.current) nonceGuardRef.current = createLatestGuard()
  const nextNonce = useCallback(() => nonceGuardRef.current!.begin(), [])
  const activeTabRef = useRef(activeTab)
  activeTabRef.current = activeTab
  const sourceSelectionRef = useRef(sourceSelection)
  sourceSelectionRef.current = sourceSelection
  const sourceSelectionActiveRef = useRef(false)
  const designRef = useRef(design)
  designRef.current = design
  const filesRef = useRef(files)
  filesRef.current = files
  const topRef = useRef(top)
  topRef.current = top
  const modeRef = useRef(mode)
  modeRef.current = mode
  const extraArgsRef = useRef(extraArgs)
  extraArgsRef.current = extraArgs
  // Historical flags for inactive modes stay session-local. The active mode
  // and its exact flags are part of the persisted workspace.
  const modeFlagMemoryRef = useRef<ModeFlagMemory>({})
  const inputRevisionRef = useRef(inputRevision)
  inputRevisionRef.current = inputRevision
  const resolvedInputRef = useRef<SynthesisInput | null>(null)
  const synthesisRunningRef = useRef(false)
  const synthesisKeyRef = useRef<string | null>(null)
  const queuedInputRef = useRef<QueuedSynthesis | null>(null)
  const synthesisAbortRef = useRef<AbortController | null>(null)
  const workspaceSaveTimerRef = useRef<number | null>(null)
  const workspaceSnapshotRef = useRef<WorkspaceState>(initial)
  const materializeCurrentInput = useCallback((): SynthesisInput => {
    const revision = inputRevisionRef.current
    const cached = resolvedInputRef.current
    if (cached?.revision === revision) return cached

    const resolved = synthesisInput(
      filesRef.current,
      topRef.current,
      modeRef.current,
      extraArgsRef.current,
      revision,
    )
    resolvedInputRef.current = resolved
    setResolvedInputIdentity((current) =>
      current?.revision === revision && current.key === resolved.key
        ? current
        : { revision, key: resolved.key },
    )
    return resolved
  }, [])

  const markInputChanged = useCallback(() => {
    const revision = inputRevisionRef.current + 1
    inputRevisionRef.current = revision
    queuedInputRef.current = null
    synthesisAbortRef.current?.abort()
    setError(null)
    setInputRevision(revision)
  }, [])

  workspaceSnapshotRef.current = {
    files,
    activeFileName,
    top,
    mode,
    extraArgs,
  }

  const cancelScheduledWorkspaceSave = useCallback(() => {
    if (workspaceSaveTimerRef.current == null) return
    window.clearTimeout(workspaceSaveTimerRef.current)
    workspaceSaveTimerRef.current = null
  }, [])

  useEffect(() => {
    cancelScheduledWorkspaceSave()
    workspaceSaveTimerRef.current = window.setTimeout(() => {
      workspaceSaveTimerRef.current = null
      void saveWorkspace(workspaceSnapshotRef.current)
    }, 250)
    return cancelScheduledWorkspaceSave
  }, [
    activeFileName,
    cancelScheduledWorkspaceSave,
    extraArgs,
    files,
    mode,
    top,
  ])

  useEffect(() => {
    const flush = () => {
      cancelScheduledWorkspaceSave()
      void saveWorkspace(workspaceSnapshotRef.current)
    }
    const flushWhenHidden = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', flushWhenHidden)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', flushWhenHidden)
    }
  }, [cancelScheduledWorkspaceSave])

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

  const sourceProbeDebouncerRef = useRef<
    ReturnType<typeof createSourceProbeDebouncer> | null
  >(null)
  if (!sourceProbeDebouncerRef.current) {
    sourceProbeDebouncerRef.current = createSourceProbeDebouncer((selection) => {
      if (
        activeTabRef.current !== 'graph' ||
        !sourceSelectionActiveRef.current
      ) {
        return
      }
      setConeReq(sourceGraphRequest(selection, nextNonce()))
    })
  }
  const cancelSourceProbe = useCallback(() => {
    sourceProbeDebouncerRef.current?.cancel()
  }, [])
  useEffect(() => () => cancelSourceProbe(), [cancelSourceProbe])

  useEffect(() => {
    if (analysisState !== 'current') {
      setEditorHighlight(null)
    } else {
      // A failure report is obsolete once the current input has a live
      // analysis (e.g. the failing edit was undone, restoring the last good
      // input).
      setError(null)
    }
  }, [analysisState])

  // Load examples once.
  const loadedExamples = useRef(false)
  if (!loadedExamples.current) {
    loadedExamples.current = true
    api
      .getExamples()
      .then((r) => setExamples(r.examples))
      .catch(() => {
        /* bundled examples are optional; keep the editor usable if they fail to load */
      })
  }

  const updateFileContent = useCallback(
    (name: string, content: string) => {
      const current = filesRef.current
      const existing = current.find((file) => file.name === name)
      if (!existing || existing.content === content) return
      const next = current.map((file) =>
        file.name === name ? { ...file, content } : file,
      )
      filesRef.current = next
      markInputChanged()
      setFiles(next)
    },
    [markInputChanged],
  )

  const addFile = useCallback(() => {
    cancelSourceProbe()
    const current = filesRef.current
    const activeName = workspaceSnapshotRef.current.activeFileName
    const extension = activeName.endsWith('.vhd') || activeName.endsWith('.vhdl')
      ? '.vhdl'
      : '.sv'
    let i = current.length
    let name = `file${i}${extension}`
    const names = new Set(current.map((file) => file.name))
    while (names.has(name)) {
      i += 1
      name = `file${i}${extension}`
    }
    const next = [...current, { name, content: '' }]
    filesRef.current = next
    markInputChanged()
    setFiles(next)
    setActiveFileNameState(name)
    const selection = { file: name, startLine: 1, endLine: 1 }
    sourceSelectionRef.current = selection
    sourceSelectionActiveRef.current = false
    setSourceSelectionState(selection)
    setConeReq((request) => (request?.kind === 'source' ? null : request))
  }, [cancelSourceProbe, markInputChanged])

  const importFiles = useCallback(
    (imported: DesignFile[]) => {
      if (imported.length === 0) return
      cancelSourceProbe()
      const current = filesRef.current
      const next = mergeComputerFiles(current, imported)
      const contentChanged =
        next.length !== current.length ||
        next.some(
          (file, index) =>
            file.name !== current[index]?.name ||
            file.content !== current[index]?.content,
        )
      filesRef.current = next
      if (contentChanged) {
        markInputChanged()
        setFiles(next)
      }
      setDocRevision((revision) => revision + 1)
      const active = imported[0].name
      setActiveFileNameState(active)
      const selection = { file: active, startLine: 1, endLine: 1 }
      sourceSelectionRef.current = selection
      sourceSelectionActiveRef.current = false
      setSourceSelectionState(selection)
      setConeReq((request) => (request?.kind === 'source' ? null : request))
    },
    [cancelSourceProbe, markInputChanged],
  )

  const renameFile = useCallback(
    (oldName: string, newName: string) => {
      cancelSourceProbe()
      const clean = newName.trim()
      if (!clean || !/^[A-Za-z0-9._-]+$/.test(clean)) return
      const current = filesRef.current
      if (
        clean === oldName ||
        !current.some((file) => file.name === oldName) ||
        current.some((file) => file.name === clean && file.name !== oldName)
      ) {
        return
      }
      const next = current.map((file) =>
        file.name === oldName ? { ...file, name: clean } : file,
      )
      filesRef.current = next
      markInputChanged()
      setFiles(next)
      setActiveFileNameState((cur) => (cur === oldName ? clean : cur))
      setSourceSelectionState((cur) =>
        cur.file === oldName ? { ...cur, file: clean } : cur,
      )
    },
    [cancelSourceProbe, markInputChanged],
  )

  const deleteFile = useCallback(
    (name: string) => {
      cancelSourceProbe()
      const current = filesRef.current
      if (current.length <= 1 || !current.some((file) => file.name === name)) return
      const next = current.filter((file) => file.name !== name)
      filesRef.current = next
      markInputChanged()
      setFiles(next)
      setActiveFileNameState((cur) => (cur === name ? next[0].name : cur))
      if (sourceSelectionRef.current.file === name) {
        const selection = { file: next[0].name, startLine: 1, endLine: 1 }
        sourceSelectionRef.current = selection
        sourceSelectionActiveRef.current = false
        setConeReq((request) => (request?.kind === 'source' ? null : request))
      }
      setSourceSelectionState((cur) =>
        cur.file === name
          ? { file: next[0].name, startLine: 1, endLine: 1 }
          : cur,
      )
    },
    [cancelSourceProbe, markInputChanged],
  )

  const resetWorkspace = useCallback(() => {
    cancelSourceProbe()
    cancelScheduledWorkspaceSave()
    const next: WorkspaceState = {
      files: [{ ...DEFAULT_FILE }],
      activeFileName: DEFAULT_FILE.name,
      top: '',
      mode: modeRef.current,
      extraArgs: extraArgsRef.current,
    }
    filesRef.current = next.files
    topRef.current = next.top
    workspaceSnapshotRef.current = next
    markWorkspaceResetPending(next)
    markInputChanged()
    setFiles(next.files)
    setActiveFileNameState(next.activeFileName)
    setDocRevision((revision) => revision + 1)
    setTopState(next.top)
    const selection = { file: DEFAULT_FILE.name, startLine: 1, endLine: 1 }
    sourceSelectionRef.current = selection
    sourceSelectionActiveRef.current = false
    setSourceSelectionState(selection)
    designRef.current = null
    setDesign(null)
    setDesignInputKey(null)
    setResolvedInputIdentity(null)
    setError(null)
    setConeReq(null)
    setEditorHighlight(null)
    void saveWorkspace(next, true)
  }, [cancelScheduledWorkspaceSave, cancelSourceProbe, markInputChanged])

  const setConfirmWorkspaceReset = useCallback((enabled: boolean) => {
    setConfirmWorkspaceResetState(enabled)
    saveResetConfirmationPreference(enabled)
  }, [])

  const setEditorKeymap = useCallback((keymap: EditorKeymap) => {
    setEditorKeymapState(keymap)
    saveEditorKeymapPreference(keymap)
  }, [])

  const setTop = useCallback(
    (value: string) => {
      if (topRef.current === value) return
      topRef.current = value
      markInputChanged()
      setTopState(value)
    },
    [markInputChanged],
  )

  const setMode = useCallback(
    (value: Mode) => {
      if (modeRef.current === value) return
      const transition = flagsForModeTransition(
        extraArgsRef.current,
        modeRef.current,
        value,
        modeFlagMemoryRef.current,
      )
      modeFlagMemoryRef.current = transition.memory
      modeRef.current = value
      const nextFlags = transition.flags
      if (nextFlags !== extraArgsRef.current) {
        extraArgsRef.current = nextFlags
        setExtraArgsState(nextFlags)
      }
      markInputChanged()
      setModeState(value)
    },
    [markInputChanged],
  )

  const setExtraArgs = useCallback(
    (value: string) => {
      if (extraArgsRef.current === value) return
      extraArgsRef.current = value
      markInputChanged()
      setExtraArgsState(value)
    },
    [markInputChanged],
  )

  const loadExample = useCallback(
    (variant: ExampleVariant) => {
      cancelSourceProbe()
      const nextFiles = variant.files.length ? variant.files : [DEFAULT_FILE]
      const nextTop = variant.top ?? ''
      filesRef.current = nextFiles
      topRef.current = nextTop
      markInputChanged()
      setFiles(nextFiles)
      // Reloading the already-active example changes content without changing
      // the active file name, so the editor needs an explicit reset signal.
      setDocRevision((r) => r + 1)
      const firstFile = variant.files[0]?.name ?? DEFAULT_FILE.name
      setActiveFileNameState(firstFile)
      const selection = { file: firstFile, startLine: 1, endLine: 1 }
      sourceSelectionRef.current = selection
      sourceSelectionActiveRef.current = false
      setSourceSelectionState(selection)
      setConeReq((request) => (request?.kind === 'source' ? null : request))
      setTopState(nextTop)
    },
    [cancelSourceProbe, markInputChanged],
  )

  const requestSynthesis = useCallback(async () => {
    // Materializing the full request (and JSON-keying source content) happens
    // only after the auto-synthesis debounce, never per keystroke.
    const requested = materializeCurrentInput()
    if (synthesisRunningRef.current) {
      // One bounded slot, always replaced by the newest complete input. A
      // revert to the running input clears an obsolete queued edit.
      queuedInputRef.current = queuedSynthesisForRequest(
        synthesisKeyRef.current,
        requested,
      )
      return
    }

    synthesisRunningRef.current = true
    setSynthesizing(true)
    let next: QueuedSynthesis | null = requested
    try {
      while (next) {
        const running: QueuedSynthesis = next
        const controller = new AbortController()
        next = null
        queuedInputRef.current = null
        synthesisKeyRef.current = running.key
        synthesisAbortRef.current = controller
        setError(null)
        try {
          const res = await api.synthesize(running.request, controller.signal)
          setDesign(res)
          setDesignInputKey(running.key)
          // A source graph tracks the selected lines across synthesis. Other
          // explicit cones remain stable until the user asks to replace them.
          setConeReq((request) =>
            request?.kind === 'source'
              ? sourceGraphRequest(sourceSelectionRef.current, nextNonce())
              : request,
          )
        } catch (e) {
          if (!(e instanceof DOMException && e.name === 'AbortError')) {
            const err = e as api.ApiRequestError
            setError({
              message: err.message,
              log: err.log,
              status: err.status,
              diagnostic: firstYosysSourceError(
                err.log,
                running.request.files.map((file) => file.name),
              ),
            })
            // Preserve the last valid design and graph. Their input key remains
            // unchanged, so source cross-probing stays disabled while stale.
          }
        } finally {
          if (synthesisAbortRef.current === controller) {
            synthesisAbortRef.current = null
          }
        }

        // The ref may be replaced by another invocation while the request is
        // awaiting; TypeScript cannot observe that asynchronous mutation.
        const queued = retainQueuedSynthesis(
          queuedInputRef.current as QueuedSynthesis | null,
          inputRevisionRef.current,
        )
        queuedInputRef.current = queued
        if (queued && queued.key !== running.key) next = queued
      }
    } finally {
      synthesisKeyRef.current = null
      synthesisRunningRef.current = false
      setSynthesizing(false)
    }
  }, [materializeCurrentInput, nextNonce])

  useEffect(() => {
    if (!synthesisSettings.autoSynthesize) return
    const timer = window.setTimeout(() => {
      void requestSynthesis()
    }, synthesisSettings.delayMs)
    return () => window.clearTimeout(timer)
  }, [inputRevision, requestSynthesis, synthesisSettings])

  useEffect(
    () => () => synthesisAbortRef.current?.abort(),
    [],
  )

  const setGraphOptions = useCallback((patch: Partial<GraphOptions>) => {
    setGraphOptionsState((o) => ({ ...o, ...patch }))
  }, [])

  const openCone = useCallback(
    (opts: {
      node?: number
      nodes?: number[]
      dir: 'fanin' | 'fanout'
      label: string
      highlight?: number[]
    }) => {
      if (analysisStateRef.current !== 'current') return
      cancelSourceProbe()
      sourceSelectionActiveRef.current = false
      const nodes =
        opts.nodes && opts.nodes.length > 0
          ? opts.nodes
          : opts.node != null
            ? [opts.node]
            : []
      if (nodes.length === 0) return
      setConeReq({
        kind: 'cone',
        designId: designRef.current?.design_id ?? '',
        node: nodes[0],
        nodes,
        dir: opts.dir,
        label: opts.label,
        highlight: opts.highlight ?? [],
        nonce: nextNonce(),
      })
      setActiveTab('graph')
    },
    [cancelSourceProbe, nextNonce],
  )

  const showPathInGraph = useCallback((path: TimingPath) => {
    if (analysisStateRef.current !== 'current') return
    cancelSourceProbe()
    sourceSelectionActiveRef.current = false
    setConeReq({
      kind: 'cone',
      designId: designRef.current?.design_id ?? '',
      node: path.endpoint.id,
      nodes: [path.endpoint.id],
      dir: 'fanin',
      label: `Path → ${displayNodeName(path.endpoint)} (depth ${path.depth})`,
      highlight: path.nodes.map((n) => n.id),
      nonce: nextNonce(),
    })
    setActiveTab('graph')
  }, [cancelSourceProbe, nextNonce])

  const openControlCone = useCallback(
    ({
      node,
      label,
      generated,
    }: {
      node: number
      label: string
      generated?: boolean
    }) => {
      if (analysisStateRef.current !== 'current') return
      cancelSourceProbe()
      sourceSelectionActiveRef.current = false
      const dir = generated ? 'fanin' : 'fanout'
      setGraphOptionsState((options) => ({ ...options, hideControl: false }))
      setConeReq({
        kind: 'cone',
        designId: designRef.current?.design_id ?? '',
        node,
        nodes: [node],
        dir,
        label: `${label} (${generated ? 'generated control fanin' : 'control fanout'})`,
        highlight: [],
        nonce: nextNonce(),
      })
      setActiveTab('graph')
    },
    [cancelSourceProbe, nextNonce],
  )

  const clearGraphSelection = useCallback(() => {
    cancelSourceProbe()
    sourceSelectionActiveRef.current = false
    setConeReq(null)
  }, [cancelSourceProbe])

  const highlightSources = useCallback((spans: SrcSpan[]) => {
    if (spans.length === 0) {
      setEditorHighlight(null)
      return
    }
    if (analysisStateRef.current !== 'current') return
    const submittedNames = new Set(filesRef.current.map((file) => file.name))
    const primary = spans.findIndex((span) => submittedNames.has(span.file))
    const primaryIndex = primary >= 0 ? primary : 0
    const primarySpan = spans[primaryIndex]
    setActiveFileNameState((cur) => (primarySpan.file ? primarySpan.file : cur))
    setEditorHighlight({ spans, primary: primaryIndex, nonce: nextNonce() })
  }, [nextNonce])

  const highlightNodeSources = useCallback(
    (src?: string | null) => highlightSources(designSrcSpans(src, filesRef.current)),
    [highlightSources],
  )

  const setSourceSelection = useCallback(
    (file: string, startLine: number, endLine: number) => {
      const selection = normalizeSourceSelection(file, startLine, endLine)
      const previous = sourceSelectionRef.current
      if (
        sourceSelectionActiveRef.current &&
        previous.file === selection.file &&
        previous.startLine === selection.startLine &&
        previous.endLine === selection.endLine
      ) {
        return
      }
      sourceSelectionRef.current = selection
      sourceSelectionActiveRef.current = true
      setSourceSelectionState(selection)
      if (activeTabRef.current === 'graph') {
        sourceProbeDebouncerRef.current?.schedule(selection)
      }
    },
    [],
  )

  const setActiveFileName = useCallback(
    (name: string) => {
      cancelSourceProbe()
      setActiveFileNameState(name)
      const selection = { file: name, startLine: 1, endLine: 1 }
      sourceSelectionRef.current = selection
      sourceSelectionActiveRef.current = false
      setSourceSelectionState(selection)
      setConeReq((request) => (request?.kind === 'source' ? null : request))
    },
    [cancelSourceProbe],
  )

  const setActiveTabForUser = useCallback((tab: TabId) => {
    cancelSourceProbe()
    setActiveTab(tab)
    activeTabRef.current = tab
    if (tab === 'graph') {
      // Explicit path/node cones retain their local pan/zoom state. A source
      // probe catches up to cursor movement that happened on another tab.
      setConeReq((request) =>
        request?.kind === 'cone'
          ? request
          : sourceSelectionActiveRef.current
            ? sourceGraphRequest(sourceSelectionRef.current, nextNonce())
            : null,
      )
    }
  }, [cancelSourceProbe, nextNonce])

  const value = useMemo<Store>(
    () => ({
      files,
      activeFileName,
      docRevision,
      top,
      mode,
      extraArgs,
      examples,
      setActiveFileName,
      updateFileContent,
      addFile,
      importFiles,
      renameFile,
      deleteFile,
      resetWorkspace,
      setTop,
      setMode,
      setExtraArgs,
      loadExample,
      confirmWorkspaceReset,
      setConfirmWorkspaceReset,
      editorKeymap,
      setEditorKeymap,
      autoSynthesize: synthesisSettings.autoSynthesize,
      setAutoSynthesize,
      autoSynthesisDelayMs: synthesisSettings.delayMs,
      setAutoSynthesisDelayMs,
      synthesizing,
      synthesize: requestSynthesis,
      design,
      analysisState,
      error,
      activeTab,
      setActiveTab: setActiveTabForUser,
      coneReq,
      graphOptions,
      setGraphOptions,
      openCone,
      openControlCone,
      showPathInGraph,
      clearGraphSelection,
      editorHighlight,
      highlightSources,
      highlightNodeSources,
      sourceSelection,
      setSourceSelection,
    }),
    [
      files,
      activeFileName,
      docRevision,
      top,
      mode,
      extraArgs,
      examples,
      setActiveFileName,
      updateFileContent,
      addFile,
      importFiles,
      renameFile,
      deleteFile,
      resetWorkspace,
      setTop,
      setMode,
      setExtraArgs,
      loadExample,
      confirmWorkspaceReset,
      setConfirmWorkspaceReset,
      editorKeymap,
      setEditorKeymap,
      synthesisSettings,
      setAutoSynthesize,
      setAutoSynthesisDelayMs,
      synthesizing,
      requestSynthesis,
      design,
      analysisState,
      error,
      activeTab,
      setActiveTabForUser,
      coneReq,
      graphOptions,
      setGraphOptions,
      openCone,
      openControlCone,
      showPathInGraph,
      clearGraphSelection,
      editorHighlight,
      highlightSources,
      highlightNodeSources,
      sourceSelection,
      setSourceSelection,
    ],
  )

  const apiRef = useRef<StoreApi | null>(null)
  if (!apiRef.current) apiRef.current = createStoreApi(value)
  const storeApi = apiRef.current
  useLayoutEffect(() => storeApi.publish(value), [storeApi, value])

  return <StoreContext.Provider value={storeApi}>{children}</StoreContext.Provider>
}
