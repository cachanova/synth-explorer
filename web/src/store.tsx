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
import { displayNodeName } from './lib/prettyType'
import type { SrcSpan } from './lib/src'
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
  node: number
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
}

export interface EditorHighlight {
  spans: SrcSpan[]
  primary: number
  nonce: number
}

export interface SourceSelection {
  file: string
  startLine: number
  endLine: number
}

export type AnalysisState =
  | 'none'
  | 'current'
  | 'stale'
  | 'refreshing'
  | 'error'

interface SynthesisInput {
  request: import('./types').SynthesizeRequest
  key: string
}

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
  maxNodes: 300,
  hideControl: true,
  hideConst: true,
  showInfrastructure: false,
}

export function synthesisInput(
  files: DesignFile[],
  top: string,
  mode: Mode,
  extraArgs: string,
): SynthesisInput {
  const request = {
    files,
    top: top.trim() || undefined,
    mode,
    extra_args: extraArgs.trim() || undefined,
  }
  return { request, key: JSON.stringify(request) }
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
  openCone: (opts: { node: number; dir: 'fanin' | 'fanout'; label: string }) => void
  openControlCone: (opts: { node: number; label: string }) => void
  showPathInGraph: (path: TimingPath) => void
  openNetlist: () => void

  // cross-probe: graph node src -> editor highlight
  editorHighlight: EditorHighlight | null
  highlightSrc: (span: SrcSpan) => void
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
  const [top, setTop] = useState('')
  const [mode, setMode] = useState<Mode>('gates')
  const [extraArgs, setExtraArgs] = useState('')
  const [examples, setExamples] = useState<Example[]>([])

  const [synthesizing, setSynthesizing] = useState(false)
  const [design, setDesign] = useState<SynthesizeResponse | null>(null)
  const [designInputKey, setDesignInputKey] = useState<string | null>(null)
  const [autoSynthesize, setAutoSynthesize] = useState(true)
  const [error, setError] = useState<Store['error']>(null)

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

  const currentInput = useMemo(
    () => synthesisInput(files, top, mode, extraArgs),
    [files, top, mode, extraArgs],
  )
  const currentInputRef = useRef(currentInput)
  currentInputRef.current = currentInput
  const synthesisRunningRef = useRef(false)
  const synthesisKeyRef = useRef<string | null>(null)
  const queuedInputRef = useRef<SynthesisInput | null>(null)

  const analysisState: AnalysisState = synthesizing
    ? 'refreshing'
    : design == null
      ? error
        ? 'error'
        : 'none'
      : designInputKey === currentInput.key
        ? 'current'
        : error
          ? 'error'
          : 'stale'

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

  const updateFileContent = useCallback((name: string, content: string) => {
    setFiles((fs) => fs.map((f) => (f.name === name ? { ...f, content } : f)))
  }, [])

  const addFile = useCallback(() => {
    setFiles((fs) => {
      let i = fs.length
      let name = `file${i}.sv`
      const names = new Set(fs.map((f) => f.name))
      while (names.has(name)) {
        i += 1
        name = `file${i}.sv`
      }
      setActiveFileNameState(name)
      setSourceSelectionState({ file: name, startLine: 1, endLine: 1 })
      return [...fs, { name, content: '' }]
    })
  }, [])

  const renameFile = useCallback(
    (oldName: string, newName: string) => {
      const clean = newName.trim()
      if (!clean || !/^[A-Za-z0-9._-]+$/.test(clean)) return
      setFiles((fs) => {
        if (fs.some((f) => f.name === clean && f.name !== oldName)) return fs
        return fs.map((f) => (f.name === oldName ? { ...f, name: clean } : f))
      })
      setActiveFileNameState((cur) => (cur === oldName ? clean : cur))
      setSourceSelectionState((cur) =>
        cur.file === oldName ? { ...cur, file: clean } : cur,
      )
    },
    [],
  )

  const deleteFile = useCallback((name: string) => {
    setFiles((fs) => {
      if (fs.length <= 1) return fs
      const next = fs.filter((f) => f.name !== name)
      setActiveFileNameState((cur) => (cur === name ? next[0].name : cur))
      setSourceSelectionState((cur) =>
        cur.file === name
          ? { file: next[0].name, startLine: 1, endLine: 1 }
          : cur,
      )
      return next
    })
  }, [])

  const loadExample = useCallback((ex: Example) => {
    setFiles(ex.files.length ? ex.files : [DEFAULT_FILE])
    const firstFile = ex.files[0]?.name ?? DEFAULT_FILE.name
    setActiveFileNameState(firstFile)
    setSourceSelectionState({ file: firstFile, startLine: 1, endLine: 1 })
    setTop(ex.top ?? '')
  }, [])

  const synthesize = useCallback(async () => {
    const requested = currentInputRef.current
    if (synthesisRunningRef.current) {
      if (synthesisKeyRef.current !== requested.key) {
        // One bounded slot, always replaced by the newest complete input.
        queuedInputRef.current = requested
      }
      return
    }

    synthesisRunningRef.current = true
    setSynthesizing(true)
    let next: SynthesisInput | null = requested
    try {
      while (next) {
        const running: SynthesisInput = next
        next = null
        queuedInputRef.current = null
        synthesisKeyRef.current = running.key
        setError(null)
        try {
          const res = await api.synthesize(running.request)
          setDesign(res)
          setDesignInputKey(running.key)
          designInputKeyRef.current = running.key
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
          // Preserve the last valid design and graph. Their input key remains
          // unchanged, so source cross-probing stays disabled while stale.
        }

        // The ref may be replaced by another invocation while the request is
        // awaiting; TypeScript cannot observe that asynchronous mutation.
        const queued = queuedInputRef.current as SynthesisInput | null
        if (queued && queued.key !== running.key) next = queued
      }
    } finally {
      synthesisKeyRef.current = null
      synthesisRunningRef.current = false
      setSynthesizing(false)
    }
  }, [])

  // Source/top/mode/argument/example changes make the prior analysis stale.
  // Cursor movement is deliberately absent from this dependency list.
  useEffect(() => {
    if (!autoSynthesize) return
    const timer = window.setTimeout(() => {
      if (designInputKeyRef.current !== currentInputRef.current.key) {
        void synthesize()
      }
    }, AUTO_SYNTH_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [autoSynthesize, currentInput.key, synthesize])

  const setGraphOptions = useCallback((patch: Partial<GraphOptions>) => {
    setGraphOptionsState((o) => ({ ...o, ...patch }))
  }, [])

  const openCone = useCallback(
    (opts: { node: number; dir: 'fanin' | 'fanout'; label: string }) => {
      setConeReq({
        kind: 'cone',
        node: opts.node,
        dir: opts.dir,
        label: opts.label,
        highlight: [],
        nonce: nextNonce(),
      })
      setActiveTab('graph')
    },
    [],
  )

  const showPathInGraph = useCallback((path: TimingPath) => {
    setConeReq({
      kind: 'cone',
      node: path.endpoint.id,
      dir: 'fanin',
      label: `Path → ${displayNodeName(path.endpoint)} (depth ${path.depth})`,
      highlight: path.nodes.map((n) => n.id),
      nonce: nextNonce(),
    })
    setActiveTab('graph')
  }, [])

  const openControlCone = useCallback(
    ({ node, label }: { node: number; label: string }) => {
      setGraphOptionsState((options) => ({ ...options, hideControl: false }))
      setConeReq({
        kind: 'cone',
        node,
        dir: 'fanout',
        label: `${label} (control fanout)`,
        highlight: [],
        nonce: nextNonce(),
      })
      setActiveTab('graph')
    },
    [],
  )

  const openNetlist = useCallback(() => {
    setConeReq({
      kind: 'netlist',
      label: 'Full netlist',
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
    const submittedNames = new Set(
      currentInputRef.current.request.files.map((f) => f.name),
    )
    const primary = spans.findIndex((span) => submittedNames.has(span.file))
    const primaryIndex = primary >= 0 ? primary : 0
    const primarySpan = spans[primaryIndex]
    setActiveFileNameState((cur) => (primarySpan.file ? primarySpan.file : cur))
    setEditorHighlight({ spans, primary: primaryIndex, nonce: nextNonce() })
  }, [])

  const highlightSrc = useCallback(
    (span: SrcSpan) => highlightSources([span]),
    [highlightSources],
  )

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
      setConeReq(sourceGraphRequest(sourceSelectionRef.current, nextNonce()))
    }
  }, [])

  const takeSnapshot = useCallback(
    async (slot: 'A' | 'B') => {
      if (!design) return
      try {
        const [paths, fanout] = await Promise.all([
          api.getPaths(design.design_id, { limit: 10 }),
          api.getFanout(design.design_id, 10),
        ])
        const snap: Snapshot = {
          design_id: design.design_id,
          top: design.top,
          mode: design.mode,
          stats: design.stats,
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
    [design],
  )

  const value = useMemo<Store>(
    () => ({
      files,
      activeFileName,
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
      highlightSrc,
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
      top,
      mode,
      extraArgs,
      examples,
      setActiveFileName,
      updateFileContent,
      addFile,
      renameFile,
      deleteFile,
      loadExample,
      synthesizing,
      design,
      analysisState,
      autoSynthesize,
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
      highlightSrc,
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
