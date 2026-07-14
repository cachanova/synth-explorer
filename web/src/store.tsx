import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import * as api from './api'
import { DEFAULT_GRAPH_MAX_NODES } from './lib/graphLimits'
import {
  analysisNeedsRefresh,
  automaticRetryForFailure,
  clearAutomaticQueuedSynthesis,
  normalizeSourceSelection,
  queuedSynthesisForRequest,
  retainQueuedSynthesis,
  shouldRunAutomaticRetry,
  supersedeAutomaticRetryGeneration,
  synthesisInput,
  type AutomaticSynthesisRetry,
  type QueuedSynthesis,
  type SourceSelection,
  type SynthesisInput,
  type SynthesisOrigin,
} from './lib/liveAnalysis'
import { displayNodeName } from './lib/prettyType'
import type { SrcSpan } from './lib/src'
import { stripInvalidFlags } from './lib/flagRegistry'
import type {
  DesignFile,
  Example,
  Mode,
  Stats,
  SynthesizeResponse,
  TimingPath,
} from './types'

export type TabId =
  | 'overview'
  | 'endpoints'
  | 'paths'
  | 'fanout'
  | 'graph'
  | 'compare'

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

export interface NetlistGraphRequest {
  kind: 'netlist'
  label: string
  highlight: number[]
  nonce: number
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
  | NetlistGraphRequest
  | SourceGraphRequest

export interface GraphOptions {
  maxDepth: number
  maxNodes: number
  hideControl: boolean
  hideConst: boolean
  showInfrastructure: boolean
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
const AUTO_SYNTH_DELAY_MS = 3000

export interface Snapshot {
  design_id: string
  top: string
  mode: string
  stats: Stats
  paths: TimingPath[]
  fanout: import('./types').FanoutDriver[]
}

const DEFAULT_FILE: DesignFile = {
  name: 'design.sv',
  content: `module top (
  input  wire       clk,
  input  wire       rst,
  input  wire [7:0] a,
  input  wire [7:0] b,
  input  wire       sel,
  output reg  [7:0] q
);
  wire [7:0] sum = a + b;
  always @(posedge clk) begin
    if (rst) q <= 8'd0;
    else     q <= sel ? sum : a;
  end
endmodule
`,
}

const DEFAULT_GRAPH_OPTIONS: GraphOptions = {
  maxDepth: 64,
  maxNodes: DEFAULT_GRAPH_MAX_NODES,
  hideControl: true,
  hideConst: true,
  showInfrastructure: false,
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
  renameFile: (oldName: string, newName: string) => void
  deleteFile: (name: string) => void
  setTop: (t: string) => void
  setMode: (m: Mode) => void
  setExtraArgs: (a: string) => void
  loadExample: (ex: Example) => void

  // synthesis
  synthesizing: boolean
  design: SynthesizeResponse | null
  analysisState: AnalysisState
  autoSynthesize: boolean
  setAutoSynthesize: (enabled: boolean) => void
  error: { message: string; log?: string; status?: number } | null
  synthesize: () => Promise<void>

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
  openNetlist: (label?: string) => void

  // cross-probe: graph node src -> editor highlight
  editorHighlight: EditorHighlight | null
  highlightSources: (spans: SrcSpan[]) => void

  // cross-probe: editor -> graph nodes
  sourceSelection: SourceSelection
  setSourceSelection: (file: string, startLine: number, endLine: number) => void
  // compare
  snapshotA: Snapshot | null
  snapshotB: Snapshot | null
  takeSnapshot: (slot: 'A' | 'B') => Promise<void>
}

const StoreContext = createContext<Store | null>(null)

export function useStore(): Store {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore must be used within StoreProvider')
  return ctx
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [files, setFiles] = useState<DesignFile[]>([DEFAULT_FILE])
  const [activeFileName, setActiveFileNameState] = useState(DEFAULT_FILE.name)
  const [docRevision, setDocRevision] = useState(0)
  const [top, setTopState] = useState('')
  const [mode, setModeState] = useState<Mode>('gates')
  const [extraArgs, setExtraArgsState] = useState('')
  const [inputRevision, setInputRevision] = useState(0)
  const [resolvedInputIdentity, setResolvedInputIdentity] =
    useState<ResolvedInputIdentity | null>(null)
  const [examples, setExamples] = useState<Example[]>([])

  const [synthesizing, setSynthesizing] = useState(false)
  const [design, setDesign] = useState<SynthesizeResponse | null>(null)
  const [designInputKey, setDesignInputKey] = useState<string | null>(null)
  const [autoSynthesize, setAutoSynthesizeState] = useState(true)
  const [error, setError] = useState<Store['error']>(null)
  const [automaticRetry, setAutomaticRetry] =
    useState<AutomaticSynthesisRetry | null>(null)

  const [activeTab, setActiveTab] = useState<TabId>('overview')

  const [coneReq, setConeReq] = useState<GraphRequest | null>(null)
  const [graphOptions, setGraphOptionsState] = useState<GraphOptions>(
    DEFAULT_GRAPH_OPTIONS,
  )

  const [editorHighlight, setEditorHighlight] = useState<EditorHighlight | null>(
    null,
  )
  const [sourceSelection, setSourceSelectionState] = useState<SourceSelection>({
    file: DEFAULT_FILE.name,
    startLine: 1,
    endLine: 1,
  })
  const [snapshotA, setSnapshotA] = useState<Snapshot | null>(null)
  const [snapshotB, setSnapshotB] = useState<Snapshot | null>(null)

  const nonceRef = useRef(0)
  const nextNonce = () => ++nonceRef.current
  const activeTabRef = useRef(activeTab)
  activeTabRef.current = activeTab
  const sourceSelectionRef = useRef(sourceSelection)
  sourceSelectionRef.current = sourceSelection
  const designInputKeyRef = useRef(designInputKey)
  designInputKeyRef.current = designInputKey
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
  const inputRevisionRef = useRef(inputRevision)
  inputRevisionRef.current = inputRevision
  const autoSynthesizeRef = useRef(autoSynthesize)
  autoSynthesizeRef.current = autoSynthesize
  const resolvedInputRef = useRef<SynthesisInput | null>(null)
  const synthesisRunningRef = useRef(false)
  const synthesisKeyRef = useRef<string | null>(null)
  const queuedInputRef = useRef<QueuedSynthesis | null>(null)
  const retryGenerationRef = useRef(0)
  const mountedRef = useRef(true)

  const supersedeAutomaticRetry = useCallback(() => {
    retryGenerationRef.current = supersedeAutomaticRetryGeneration(
      retryGenerationRef.current,
    )
    setAutomaticRetry(null)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      retryGenerationRef.current = supersedeAutomaticRetryGeneration(
        retryGenerationRef.current,
      )
      mountedRef.current = false
    }
  }, [])

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
    supersedeAutomaticRetry()
    setInputRevision(revision)
  }, [supersedeAutomaticRetry])

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
        /* backend may be down; examples optional */
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
    const current = filesRef.current
    let i = current.length
    let name = `file${i}.sv`
    const names = new Set(current.map((file) => file.name))
    while (names.has(name)) {
      i += 1
      name = `file${i}.sv`
    }
    const next = [...current, { name, content: '' }]
    filesRef.current = next
    markInputChanged()
    setFiles(next)
    setActiveFileNameState(name)
    setSourceSelectionState({ file: name, startLine: 1, endLine: 1 })
  }, [markInputChanged])

  const renameFile = useCallback(
    (oldName: string, newName: string) => {
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
    [markInputChanged],
  )

  const deleteFile = useCallback(
    (name: string) => {
      const current = filesRef.current
      if (current.length <= 1 || !current.some((file) => file.name === name)) return
      const next = current.filter((file) => file.name !== name)
      filesRef.current = next
      markInputChanged()
      setFiles(next)
      setActiveFileNameState((cur) => (cur === name ? next[0].name : cur))
      setSourceSelectionState((cur) =>
        cur.file === name
          ? { file: next[0].name, startLine: 1, endLine: 1 }
          : cur,
      )
    },
    [markInputChanged],
  )

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
      modeRef.current = value
      // Synthesis flags are mode-specific, so drop any that the new mode's pass
      // would reject (keeping shared and free-form flags). Free-form tokens the
      // registry doesn't know about are preserved.
      const stripped = stripInvalidFlags(extraArgsRef.current, value)
      if (stripped !== extraArgsRef.current) {
        extraArgsRef.current = stripped
        setExtraArgsState(stripped)
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
    (ex: Example) => {
      const nextFiles = ex.files.length ? ex.files : [DEFAULT_FILE]
      const nextTop = ex.top ?? ''
      filesRef.current = nextFiles
      topRef.current = nextTop
      markInputChanged()
      setFiles(nextFiles)
      // Reloading the already-active example changes content without changing
      // the active file name, so the editor needs an explicit reset signal.
      setDocRevision((r) => r + 1)
      const firstFile = ex.files[0]?.name ?? DEFAULT_FILE.name
      setActiveFileNameState(firstFile)
      setSourceSelectionState({ file: firstFile, startLine: 1, endLine: 1 })
      setTopState(nextTop)
    },
    [markInputChanged],
  )

  const requestSynthesis = useCallback(async (origin: SynthesisOrigin) => {
    // Materializing the full request (and JSON-keying source content) happens
    // only on manual synthesis or after the idle debounce, never per keystroke.
    const requested = materializeCurrentInput()
    if (synthesisRunningRef.current) {
      // One bounded slot, always replaced by the newest complete input. A
      // revert to the running input clears an obsolete queued edit.
      queuedInputRef.current = queuedSynthesisForRequest(
        synthesisKeyRef.current,
        requested,
        origin,
        queuedInputRef.current,
      )
      return
    }

    synthesisRunningRef.current = true
    setSynthesizing(true)
    let next: QueuedSynthesis | null = { ...requested, origin }
    try {
      while (next) {
        const running: QueuedSynthesis = next
        next = null
        queuedInputRef.current = null
        synthesisKeyRef.current = running.key
        const attemptGeneration = retryGenerationRef.current
        setError(null)
        try {
          const res = await api.synthesize(running.request)
          setDesign(res)
          setDesignInputKey(running.key)
          designInputKeyRef.current = running.key
          supersedeAutomaticRetry()
          // A source graph tracks the selected lines across synthesis. Other
          // explicit cones remain stable until the user asks to replace them.
          setConeReq((request) =>
            request?.kind === 'source'
              ? sourceGraphRequest(sourceSelectionRef.current, nextNonce())
              : request,
          )
        } catch (e) {
          const err = e as api.ApiRequestError
          setError({ message: err.message, log: err.log, status: err.status })
          if (
            running.origin === 'automatic' &&
            err.status === 503 &&
            mountedRef.current
          ) {
            const retry = automaticRetryForFailure(
              running,
              running.origin,
              err.status,
              err.retryAfterMs,
              materializeCurrentInput(),
              autoSynthesizeRef.current,
              designInputKeyRef.current,
              attemptGeneration,
              retryGenerationRef.current,
            )
            if (retry) setAutomaticRetry(retry)
          }
          // Preserve the last valid design and graph. Their input key remains
          // unchanged, so source cross-probing stays disabled while stale.
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
  }, [materializeCurrentInput, supersedeAutomaticRetry])

  const synthesize = useCallback(
    () => {
      // This synchronous generation change wins even if React has not yet
      // committed the state clear and an older timer callback is already queued.
      supersedeAutomaticRetry()
      return requestSynthesis('manual')
    },
    [requestSynthesis, supersedeAutomaticRetry],
  )

  useEffect(() => {
    if (!automaticRetry || !autoSynthesize) return
    const timer = window.setTimeout(() => {
      if (!mountedRef.current) return
      const current = materializeCurrentInput()
      if (
        !shouldRunAutomaticRetry(
          automaticRetry,
          current,
          autoSynthesizeRef.current,
          designInputKeyRef.current,
          retryGenerationRef.current,
        )
      ) {
        setAutomaticRetry(null)
        return
      }

      // Another exact-input automatic attempt already covers this timer. A
      // manual attempt cannot reach this branch because it synchronously
      // supersedes the retry generation before entering requestSynthesis.
      if (
        synthesisRunningRef.current &&
        synthesisKeyRef.current === automaticRetry.input.key
      ) {
        setAutomaticRetry({ ...automaticRetry })
        return
      }

      setAutomaticRetry(null)
      void requestSynthesis('automatic')
    }, automaticRetry.delayMs)
    return () => window.clearTimeout(timer)
  }, [automaticRetry, autoSynthesize, materializeCurrentInput, requestSynthesis])

  const setAutoSynthesize = useCallback((enabled: boolean) => {
    autoSynthesizeRef.current = enabled
    if (!enabled) {
      queuedInputRef.current = clearAutomaticQueuedSynthesis(queuedInputRef.current)
      supersedeAutomaticRetry()
    }
    setAutoSynthesizeState(enabled)
  }, [supersedeAutomaticRetry])

  // Source/top/mode/argument/example changes make the prior analysis stale.
  // Cursor movement is deliberately absent from this dependency list.
  useEffect(() => {
    queuedInputRef.current = retainQueuedSynthesis(
      queuedInputRef.current,
      inputRevision,
    )
    const timer = window.setTimeout(() => {
      const current = materializeCurrentInput()
      if (
        autoSynthesize &&
        analysisNeedsRefresh(
          current.key,
          designInputKeyRef.current,
          synthesisRunningRef.current ? synthesisKeyRef.current : null,
        )
      ) {
        void requestSynthesis('automatic')
      }
    }, AUTO_SYNTH_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [autoSynthesize, inputRevision, materializeCurrentInput, requestSynthesis])

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
    [],
  )

  const showPathInGraph = useCallback((path: TimingPath) => {
    if (analysisStateRef.current !== 'current') return
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
  }, [])

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
    [],
  )

  const openNetlist = useCallback((label = 'Full netlist') => {
    setConeReq({
      kind: 'netlist',
      label,
      highlight: [],
      nonce: nextNonce(),
    })
    setActiveTab('graph')
  }, [])

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
  }, [])

  const setSourceSelection = useCallback(
    (file: string, startLine: number, endLine: number) => {
      const selection = normalizeSourceSelection(file, startLine, endLine)
      sourceSelectionRef.current = selection
      setSourceSelectionState(selection)
      if (activeTabRef.current === 'graph') {
        setConeReq(sourceGraphRequest(selection, nextNonce()))
      }
    },
    [],
  )

  const setActiveFileName = useCallback(
    (name: string) => {
      setActiveFileNameState(name)
      setSourceSelection(name, 1, 1)
    },
    [setSourceSelection],
  )

  const setActiveTabForUser = useCallback((tab: TabId) => {
    setActiveTab(tab)
    activeTabRef.current = tab
    if (tab === 'graph') {
      // Explicit path/node cones retain their local pan/zoom state. A source
      // probe catches up to cursor movement that happened on another tab.
      setConeReq((request) =>
        request && request.kind !== 'source'
          ? request
          : sourceGraphRequest(sourceSelectionRef.current, nextNonce()),
      )
    }
  }, [])

  const takeSnapshot = useCallback(
    async (slot: 'A' | 'B') => {
      if (analysisStateRef.current !== 'current') return
      const currentDesign = designRef.current
      if (!currentDesign) return
      try {
        const [paths, fanout] = await Promise.all([
          api.getPaths(currentDesign.design_id, { limit: 10 }),
          api.getFanout(currentDesign.design_id, 10),
        ])
        if (
          analysisStateRef.current !== 'current' ||
          designRef.current?.design_id !== currentDesign.design_id
        ) {
          return
        }
        const snap: Snapshot = {
          design_id: currentDesign.design_id,
          top: currentDesign.top,
          mode: currentDesign.mode,
          stats: currentDesign.stats,
          paths: paths.paths,
          fanout: fanout.drivers,
        }
        if (slot === 'A') setSnapshotA(snap)
        else setSnapshotB(snap)
      } catch (e) {
        const err = e as api.ApiRequestError
        setError({ message: err.message, log: err.log, status: err.status })
      }
    },
    [],
  )

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
      renameFile,
      deleteFile,
      setTop,
      setMode,
      setExtraArgs,
      loadExample,
      synthesizing,
      design,
      analysisState,
      autoSynthesize,
      setAutoSynthesize,
      error,
      synthesize,
      activeTab,
      setActiveTab: setActiveTabForUser,
      coneReq,
      graphOptions,
      setGraphOptions,
      openCone,
      openControlCone,
      showPathInGraph,
      openNetlist,
      editorHighlight,
      highlightSources,
      sourceSelection,
      setSourceSelection,
      snapshotA,
      snapshotB,
      takeSnapshot,
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
      renameFile,
      deleteFile,
      setTop,
      setMode,
      setExtraArgs,
      loadExample,
      synthesizing,
      design,
      analysisState,
      autoSynthesize,
      setAutoSynthesize,
      error,
      synthesize,
      activeTab,
      setActiveTabForUser,
      coneReq,
      graphOptions,
      setGraphOptions,
      openCone,
      openControlCone,
      showPathInGraph,
      openNetlist,
      editorHighlight,
      highlightSources,
      sourceSelection,
      setSourceSelection,
      snapshotA,
      snapshotB,
      takeSnapshot,
    ],
  )

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}
