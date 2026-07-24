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
  boundedSourceSelection,
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
import type { SrcSpan } from './lib/src'
import {
  createSourceTierSelectionController,
  type SourceTierSelection,
} from './lib/sourceTierSelection'
import type { SourceTierSpan } from './lib/sourceTiers'
import {
  firstYosysSourceError,
  type SynthesisDiagnostic,
} from './lib/yosysDiagnostics'
import {
  loadEditorKeymapPreference,
  loadEditorLineNumbersPreference,
  loadResetConfirmationPreference,
  markWorkspaceResetPending,
  saveEditorKeymapPreference,
  saveEditorLineNumbersPreference,
  saveResetConfirmationPreference,
  saveWorkspace,
  type EditorKeymap,
  type EditorLineNumbers,
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
import { boundaryPathPinSelection } from './lib/endpointCone'
import {
  connectVivadoBridge,
  VivadoBridgeError,
} from './lib/vivadoBridge'
import type {
  DesignFile,
  Example,
  ExampleVariant,
  Mode,
  SynthTool,
  SynthesizeResponse,
  TimingPath,
  VivadoBridgeStatus,
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
  rootPort?: string
  rootPortBit?: number
  rootPortBits?: number[]
  nonce: number // force re-render even if identical request
}

export interface SourceGraphRequest {
  kind: 'source'
  file: string
  startLine: number
  startColumn?: number
  endLine: number
  endColumn?: number
  fallbackStartColumn?: number
  fallbackEndColumn?: number
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
  groupMemories: boolean
}

export interface EditorHighlight {
  spans: SrcSpan[]
  primary: number
  nonce: number
  sourceTiers?: {
    nodeIds: number[]
    exact: SrcSpan[]
    contributing: SrcSpan[]
    approximate: boolean
    truncated: boolean
  }
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
  groupMemories: true,
}

function sourceCaret(file: string, line = 1, column = 1): SourceSelection {
  return {
    file,
    startLine: line,
    startColumn: column,
    endLine: line,
    endColumn: column,
  }
}

function sourceGraphRequest(
  selection: SourceSelection,
  nonce: number,
): SourceGraphRequest {
  const bounded = boundedSourceSelection(selection, MAX_SOURCE_LINES)
  const { endLine } = bounded
  const lineLabel =
    selection.startLine === endLine
      ? `line ${selection.startLine}`
      : `lines ${selection.startLine}–${endLine}`
  return {
    kind: 'source',
    file: selection.file,
    startLine: bounded.startLine,
    startColumn: bounded.startColumn,
    endLine,
    endColumn: bounded.endColumn,
    fallbackStartColumn: selection.fallbackStartColumn,
    fallbackEndColumn: selection.fallbackEndColumn,
    selectionTruncated: bounded.truncated,
    label: `${selection.file}:${lineLabel}`,
    highlight: [],
    nonce,
  }
}

function sourceTierEditorSpan(span: SourceTierSpan): SrcSpan {
  return {
    file: span.file,
    startLine: span.start_line,
    startCol: span.start_column ?? 1,
    endLine: span.end_line,
    endCol: span.end_column ?? span.start_column ?? 1,
    exact: span.start_column != null && span.end_column != null
      ? true
      : undefined,
  }
}

export interface Store {
  // editor / inputs
  files: DesignFile[]
  activeFileName: string
  /** Bumped when file content is replaced outside the editor (example load). */
  docRevision: number
  top: string
  synthTool: SynthTool
  mode: Mode
  extraArgs: string
  vivadoStatus: VivadoBridgeStatus | null
  vivadoTarget: string
  vivadoExtraArgs: string
  examples: Example[]

  setActiveFileName: (name: string) => void
  updateFileContent: (name: string, content: string) => void
  addFile: () => void
  importFiles: (files: DesignFile[]) => void
  renameFile: (oldName: string, newName: string) => void
  deleteFile: (name: string) => void
  resetWorkspace: () => void
  setTop: (t: string) => void
  setSynthTool: (tool: SynthTool) => void
  setMode: (m: Mode) => void
  setExtraArgs: (a: string) => void
  setVivadoTarget: (target: string) => void
  setVivadoExtraArgs: (args: string) => void
  connectVivado: (vivadoPath?: string) => Promise<{
    connected: boolean
    error?: string
    pathRequired?: boolean
  }>
  disconnectVivado: () => void
  loadExample: (variant: ExampleVariant) => void
  confirmWorkspaceReset: boolean
  setConfirmWorkspaceReset: (enabled: boolean) => void
  editorKeymap: EditorKeymap
  setEditorKeymap: (keymap: EditorKeymap) => void
  editorLineNumbers: EditorLineNumbers
  setEditorLineNumbers: (mode: EditorLineNumbers) => void
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
    kind?: 'load' | 'timeout' | 'bridge'
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
    rootPort?: string
    rootPortBit?: number
    rootPortBits?: number[]
  }) => void
  openControlCone: (opts: {
    node?: number
    nodes?: number[]
    label: string
    generated?: boolean
  }) => void
  showPathInGraph: (path: TimingPath) => void
  clearGraphSelection: () => void
  registerGraphProbeReset: (reset: (() => void) | null) => void

  // cross-probe: graph node src -> editor highlight
  editorHighlight: EditorHighlight | null
  highlightSources: (spans: SrcSpan[]) => void
  selectSchematicNodes: (nodeIds: number[]) => void

  // cross-probe: editor -> graph nodes
  sourceSelection: SourceSelection
  setSourceSelection: (
    file: string,
    startLine: number,
    endLine: number,
    startColumn?: number,
    endColumn?: number,
    fallbackStartColumn?: number,
    fallbackEndColumn?: number,
  ) => void
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
  const [synthTool, setSynthToolState] = useState<SynthTool>('yosys')
  const [mode, setModeState] = useState<Mode>(initial.mode)
  const [extraArgs, setExtraArgsState] = useState(initial.extraArgs)
  const [vivadoStatus, setVivadoStatus] = useState<VivadoBridgeStatus | null>(null)
  const [vivadoTarget, setVivadoTargetState] = useState('')
  const [vivadoExtraArgs, setVivadoExtraArgsState] = useState(initial.vivadoExtraArgs)
  const [confirmWorkspaceReset, setConfirmWorkspaceResetState] = useState(
    loadResetConfirmationPreference,
  )
  const [editorKeymap, setEditorKeymapState] = useState(
    loadEditorKeymapPreference,
  )
  const [synthesisSettings, setSynthesisSettings] = useState(
    loadSynthesisSettings,
  )
  const [editorLineNumbers, setEditorLineNumbersState] = useState(
    loadEditorLineNumbersPreference,
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
    startColumn: 1,
    endLine: 1,
    endColumn: 1,
  })

  const nonceGuardRef = useRef<ReturnType<typeof createLatestGuard> | null>(null)
  if (!nonceGuardRef.current) nonceGuardRef.current = createLatestGuard()
  const nextNonce = useCallback(() => nonceGuardRef.current!.begin(), [])
  const activeTabRef = useRef(activeTab)
  activeTabRef.current = activeTab
  const sourceSelectionRef = useRef(sourceSelection)
  sourceSelectionRef.current = sourceSelection
  const sourceSelectionActiveRef = useRef(false)
  const graphProbeResetRef = useRef<(() => void) | null>(null)
  const designRef = useRef(design)
  designRef.current = design
  const filesRef = useRef(files)
  filesRef.current = files
  const topRef = useRef(top)
  topRef.current = top
  const synthToolRef = useRef(synthTool)
  synthToolRef.current = synthTool
  const modeRef = useRef(mode)
  modeRef.current = mode
  const extraArgsRef = useRef(extraArgs)
  extraArgsRef.current = extraArgs
  const vivadoStatusRef = useRef(vivadoStatus)
  vivadoStatusRef.current = vivadoStatus
  const vivadoTargetRef = useRef(vivadoTarget)
  vivadoTargetRef.current = vivadoTarget
  const vivadoExtraArgsRef = useRef(vivadoExtraArgs)
  vivadoExtraArgsRef.current = vivadoExtraArgs
  // Historical flags for inactive modes stay session-local. The active mode
  // and its exact flags are part of the persisted workspace.
  const modeFlagMemoryRef = useRef<ModeFlagMemory>({})
  const inputRevisionRef = useRef(inputRevision)
  inputRevisionRef.current = inputRevision
  const resolvedInputRef = useRef<SynthesisInput | null>(null)
  const synthesisRequestedRevisionRef = useRef<number | null>(null)
  const synthesisRunningRef = useRef(false)
  const synthesisKeyRef = useRef<string | null>(null)
  const queuedInputRef = useRef<QueuedSynthesis | null>(null)
  const synthesisAbortRef = useRef<AbortController | null>(null)
  const workspaceSaveTimerRef = useRef<number | null>(null)
  const workspaceSnapshotRef = useRef<WorkspaceState>(initial)
  const sourceTierCommitRef = useRef<
    (selection: SourceTierSelection | null) => void
  >(() => {})
  const sourceTierControllerRef = useRef<
    ReturnType<typeof createSourceTierSelectionController> | null
  >(null)
  if (!sourceTierControllerRef.current) {
    sourceTierControllerRef.current = createSourceTierSelectionController(
      (selection) => sourceTierCommitRef.current(selection),
    )
  }
  const selectSchematicNodes = useCallback((nodeIds: number[]) => {
    sourceTierControllerRef.current!(nodeIds)
  }, [])
  sourceTierCommitRef.current = (selection) => {
    if (!selection) {
      setEditorHighlight(null)
      return
    }

    const submittedNames = new Set(filesRef.current.map((file) => file.name))
    const exact = selection.response.exact
      .filter((span) => submittedNames.has(span.file))
      .map(sourceTierEditorSpan)
    const contributing = selection.response.contributing
      .filter((span) => submittedNames.has(span.file))
      .map(sourceTierEditorSpan)
    const primarySpan = exact[0]
    if (primarySpan) setActiveFileNameState(primarySpan.file)
    setEditorHighlight({
      spans: [...exact, ...contributing],
      primary: 0,
      nonce: nextNonce(),
      sourceTiers: {
        nodeIds: selection.nodeIds,
        exact,
        contributing,
        approximate: selection.response.approximate,
        truncated: selection.response.truncated,
      },
    })
  }
  const materializeCurrentInput = useCallback((): SynthesisInput => {
    const revision = inputRevisionRef.current
    const cached = resolvedInputRef.current
    if (cached?.revision === revision) return cached

    const selectedPart = vivadoStatusRef.current?.parts.find(
      (part) => part.name === vivadoTargetRef.current,
    )
    const resolved = synthesisInput(
      filesRef.current,
      topRef.current,
      modeRef.current,
      synthToolRef.current === 'vivado'
        ? vivadoExtraArgsRef.current
        : extraArgsRef.current,
      revision,
      synthToolRef.current,
      synthToolRef.current === 'vivado' && selectedPart && vivadoStatusRef.current
        ? {
            name: selectedPart.name,
            family: selectedPart.family,
            speed: selectedPart.speed,
            version: `${vivadoStatusRef.current.vivado_version}; bridge ${vivadoStatusRef.current.bridge_version}`,
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
    vivadoExtraArgs,
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
    vivadoExtraArgs,
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
      selectSchematicNodes([])
    } else {
      // A failure report is obsolete once the current input has a live
      // analysis (e.g. the failing edit was undone, restoring the last good
      // input).
      setError(null)
    }
  }, [analysisState, selectSchematicNodes])

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
    const selection = sourceCaret(name)
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
      const selection = sourceCaret(active)
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
        const selection = sourceCaret(next[0].name)
        sourceSelectionRef.current = selection
        sourceSelectionActiveRef.current = false
        setConeReq((request) => (request?.kind === 'source' ? null : request))
      }
      setSourceSelectionState((cur) =>
        cur.file === name
          ? sourceCaret(next[0].name)
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
      vivadoExtraArgs: vivadoExtraArgsRef.current,
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
    const selection = sourceCaret(DEFAULT_FILE.name)
    sourceSelectionRef.current = selection
    sourceSelectionActiveRef.current = false
    setSourceSelectionState(selection)
    designRef.current = null
    setDesign(null)
    setDesignInputKey(null)
    setResolvedInputIdentity(null)
    setError(null)
    setConeReq(null)
    selectSchematicNodes([])
    void saveWorkspace(next, true)
  }, [
    cancelScheduledWorkspaceSave,
    cancelSourceProbe,
    markInputChanged,
    selectSchematicNodes,
  ])

  const setConfirmWorkspaceReset = useCallback((enabled: boolean) => {
    setConfirmWorkspaceResetState(enabled)
    saveResetConfirmationPreference(enabled)
  }, [])

  const setEditorKeymap = useCallback((keymap: EditorKeymap) => {
    setEditorKeymapState(keymap)
    saveEditorKeymapPreference(keymap)
  }, [])

  const setEditorLineNumbers = useCallback((mode: EditorLineNumbers) => {
    setEditorLineNumbersState(mode)
    saveEditorLineNumbersPreference(mode)
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

  const setSynthTool = useCallback(
    (value: SynthTool) => {
      if (value === 'vivado' && !vivadoStatusRef.current) return
      if (synthToolRef.current === value) return
      synthToolRef.current = value
      markInputChanged()
      setSynthToolState(value)
    },
    [markInputChanged],
  )

  const clearVivadoConnection = useCallback((options: { markChanged?: boolean } = {}) => {
    vivadoStatusRef.current = null
    setVivadoStatus(null)
    if (synthToolRef.current === 'vivado') {
      synthToolRef.current = 'yosys'
      setSynthToolState('yosys')
      if (options.markChanged !== false) markInputChanged()
    }
  }, [markInputChanged])

  const connectVivado = useCallback(async (vivadoPath?: string) => {
    try {
      const status = await connectVivadoBridge(vivadoPath)
      const target = status.parts.some((part) => part.name === vivadoTargetRef.current)
        ? vivadoTargetRef.current
        : status.parts.find((part) => part.name === 'xc7a35tcpg236-1')?.name ??
          status.parts[0].name
      vivadoStatusRef.current = status
      vivadoTargetRef.current = target
      setVivadoStatus(status)
      setVivadoTargetState(target)
      setError(null)
      return { connected: true }
    } catch (error) {
      const bridgeError = error as VivadoBridgeError
      if (bridgeError.pathRequired) {
        setError(null)
      } else {
        setError({
          message: bridgeError.message,
          log: bridgeError.log,
          status: bridgeError.status || undefined,
        })
      }
      return {
        connected: false,
        error: bridgeError.message,
        pathRequired: bridgeError.pathRequired,
      }
    }
  }, [])

  const disconnectVivado = useCallback(() => {
    clearVivadoConnection()
  }, [clearVivadoConnection])

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

  const setVivadoTarget = useCallback(
    (value: string) => {
      if (!vivadoStatusRef.current?.parts.some((part) => part.name === value)) return
      if (vivadoTargetRef.current === value) return
      vivadoTargetRef.current = value
      markInputChanged()
      setVivadoTargetState(value)
    },
    [markInputChanged],
  )

  const setVivadoExtraArgs = useCallback(
    (value: string) => {
      if (vivadoExtraArgsRef.current === value) return
      vivadoExtraArgsRef.current = value
      markInputChanged()
      setVivadoExtraArgsState(value)
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
      const selection = sourceCaret(firstFile)
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
    synthesisRequestedRevisionRef.current = requested.revision
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
              kind: err.kind,
              diagnostic: firstYosysSourceError(
                err.log,
                running.request.files.map((file) => file.name),
              ),
            })
            if (running.request.tool === 'vivado' && err.kind === 'bridge') {
              clearVivadoConnection({ markChanged: false })
            }
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
  }, [clearVivadoConnection, materializeCurrentInput, nextNonce])

  useEffect(() => {
    if (
      !synthesisSettings.autoSynthesize ||
      synthTool !== 'yosys' ||
      synthesisRequestedRevisionRef.current === inputRevision
    ) {
      return
    }
    const scheduledRevision = inputRevision
    const timer = window.setTimeout(() => {
      if (
        inputRevisionRef.current === scheduledRevision &&
        synthesisRequestedRevisionRef.current !== scheduledRevision
      ) {
        void requestSynthesis()
      }
    }, synthesisSettings.delayMs)
    return () => window.clearTimeout(timer)
  }, [inputRevision, requestSynthesis, synthesisSettings, synthTool])

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
      rootPort?: string
      rootPortBit?: number
      rootPortBits?: number[]
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
        rootPort: opts.rootPort,
        rootPortBit: opts.rootPortBit,
        rootPortBits: opts.rootPortBits,
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
      label: `Path → ${displayNodeName(path.endpoint)}${
        path.endpoint_kind === 'blackbox' ? `.${path.endpoint_port}` : ''
      } (depth ${path.depth})`,
      highlight: path.nodes.map((n) => n.id),
      ...boundaryPathPinSelection(path.endpoint_kind, path.endpoint_port, path.bits),
      nonce: nextNonce(),
    })
    setActiveTab('graph')
  }, [cancelSourceProbe, nextNonce])

  const openControlCone = useCallback(
    ({
      node,
      nodes: requestedNodes,
      label,
      generated,
    }: {
      node?: number
      nodes?: number[]
      label: string
      generated?: boolean
    }) => {
      if (analysisStateRef.current !== 'current') return
      cancelSourceProbe()
      sourceSelectionActiveRef.current = false
      const dir = generated ? 'fanin' : 'fanout'
      const roots = [...new Set(requestedNodes?.length ? requestedNodes : node == null ? [] : [node])]
      if (roots.length === 0) return
      const rootLimit = 200
      const nodes = roots.length <= rootLimit
        ? roots
        : Array.from({ length: rootLimit }, (_, index) =>
            roots[Math.floor(index * (roots.length - 1) / (rootLimit - 1))],
          )
      setGraphOptionsState((options) => ({ ...options, hideControl: false }))
      setConeReq({
        kind: 'cone',
        designId: designRef.current?.design_id ?? '',
        node: nodes[0],
        nodes,
        dir,
        label: `${label} (${generated ? 'generated control fanin' : 'control fanout'}${nodes.length < roots.length ? `; ${nodes.length}/${roots.length} drivers` : ''})`,
        highlight: [],
        nonce: nextNonce(),
      })
      setActiveTab('graph')
    },
    [cancelSourceProbe, nextNonce],
  )

  const clearGraphSelection = useCallback(() => {
    graphProbeResetRef.current?.()
    cancelSourceProbe()
    sourceSelectionActiveRef.current = false
    setConeReq(null)
    selectSchematicNodes([])
  }, [cancelSourceProbe, selectSchematicNodes])

  const registerGraphProbeReset = useCallback((reset: (() => void) | null) => {
    graphProbeResetRef.current = reset
  }, [])

  const highlightSources = useCallback((spans: SrcSpan[]) => {
    sourceTierControllerRef.current!([])
    if (spans.length === 0) {
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

  const setSourceSelection = useCallback(
    (
      file: string,
      startLine: number,
      endLine: number,
      startColumn = 1,
      endColumn = startColumn,
      fallbackStartColumn?: number,
      fallbackEndColumn?: number,
    ) => {
      const selection = normalizeSourceSelection(
        file,
        startLine,
        endLine,
        startColumn,
        endColumn,
        fallbackStartColumn,
        fallbackEndColumn,
      )
      const previous = sourceSelectionRef.current
      graphProbeResetRef.current?.()
      setEditorHighlight(null)
      if (
        sourceSelectionActiveRef.current &&
        previous.file === selection.file &&
        previous.startLine === selection.startLine &&
        previous.startColumn === selection.startColumn &&
        previous.endLine === selection.endLine &&
        previous.endColumn === selection.endColumn &&
        previous.fallbackStartColumn === selection.fallbackStartColumn &&
        previous.fallbackEndColumn === selection.fallbackEndColumn
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
      const selection = sourceCaret(name)
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
      synthTool,
      mode,
      extraArgs,
      vivadoStatus,
      vivadoTarget,
      vivadoExtraArgs,
      examples,
      setActiveFileName,
      updateFileContent,
      addFile,
      importFiles,
      renameFile,
      deleteFile,
      resetWorkspace,
      setTop,
      setSynthTool,
      setMode,
      setExtraArgs,
      setVivadoTarget,
      setVivadoExtraArgs,
      connectVivado,
      disconnectVivado,
      loadExample,
      confirmWorkspaceReset,
      setConfirmWorkspaceReset,
      editorKeymap,
      setEditorKeymap,
      editorLineNumbers,
      setEditorLineNumbers,
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
      registerGraphProbeReset,
      editorHighlight,
      highlightSources,
      selectSchematicNodes,
      sourceSelection,
      setSourceSelection,
    }),
    [
      files,
      activeFileName,
      docRevision,
      top,
      synthTool,
      mode,
      extraArgs,
      vivadoStatus,
      vivadoTarget,
      vivadoExtraArgs,
      examples,
      setActiveFileName,
      updateFileContent,
      addFile,
      importFiles,
      renameFile,
      deleteFile,
      resetWorkspace,
      setTop,
      setSynthTool,
      setMode,
      setExtraArgs,
      setVivadoTarget,
      setVivadoExtraArgs,
      connectVivado,
      disconnectVivado,
      requestSynthesis,
      loadExample,
      confirmWorkspaceReset,
      setConfirmWorkspaceReset,
      editorKeymap,
      setEditorKeymap,
      editorLineNumbers,
      setEditorLineNumbers,
      synthesisSettings,
      setAutoSynthesize,
      setAutoSynthesisDelayMs,
      synthesizing,
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
      registerGraphProbeReset,
      editorHighlight,
      highlightSources,
      selectSchematicNodes,
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
