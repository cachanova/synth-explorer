import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import * as api from './api'
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

export interface ConeRequest {
  node: number
  dir: 'fanin' | 'fanout'
  label: string // human description for the graph header
  // node ids to highlight (e.g. a path); empty for plain cones
  highlight: number[]
  // request the full netlist instead of a cone
  netlist: boolean
  nonce: number // force re-render even if identical request
}

export interface GraphOptions {
  maxDepth: number
  maxNodes: number
  hideControl: boolean
  hideConst: boolean
}

export interface EditorHighlight {
  span: SrcSpan
  nonce: number
}

export interface Snapshot {
  design_id: string
  top: string
  mode: string
  stats: Stats
  paths: TimingPath[]
  fanout: import('./types').FanoutDriver[]
}

export interface ProbeState {
  file: string
  line: number
  nodeIds: number[]
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
  error: { message: string; log?: string; status?: number } | null
  synthesize: () => Promise<void>

  // tabs
  activeTab: TabId
  setActiveTab: (t: TabId) => void

  // graph
  coneReq: ConeRequest | null
  graphOptions: GraphOptions
  setGraphOptions: (patch: Partial<GraphOptions>) => void
  openCone: (opts: { node: number; dir: 'fanin' | 'fanout'; label: string }) => void
  showPathInGraph: (path: TimingPath) => void
  openNetlist: () => void

  // cross-probe: graph node src -> editor highlight
  editorHighlight: EditorHighlight | null
  highlightSrc: (span: SrcSpan) => void

  // cross-probe: editor -> graph nodes
  cursor: { file: string; line: number }
  setCursor: (file: string, line: number) => void
  probe: ProbeState | null
  runProbe: () => Promise<void>
  clearProbe: () => void

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
  const [activeFileName, setActiveFileName] = useState(DEFAULT_FILE.name)
  const [top, setTop] = useState('')
  const [mode, setMode] = useState<Mode>('gates')
  const [extraArgs, setExtraArgs] = useState('')
  const [examples, setExamples] = useState<Example[]>([])

  const [synthesizing, setSynthesizing] = useState(false)
  const [design, setDesign] = useState<SynthesizeResponse | null>(null)
  const [error, setError] = useState<Store['error']>(null)

  const [activeTab, setActiveTab] = useState<TabId>('overview')

  const [coneReq, setConeReq] = useState<ConeRequest | null>(null)
  const [graphOptions, setGraphOptionsState] = useState<GraphOptions>(
    DEFAULT_GRAPH_OPTIONS,
  )

  const [editorHighlight, setEditorHighlight] = useState<EditorHighlight | null>(
    null,
  )
  const [cursor, setCursorState] = useState({ file: DEFAULT_FILE.name, line: 1 })
  const [probe, setProbe] = useState<ProbeState | null>(null)

  const [snapshotA, setSnapshotA] = useState<Snapshot | null>(null)
  const [snapshotB, setSnapshotB] = useState<Snapshot | null>(null)

  const nonceRef = useRef(0)
  const nextNonce = () => ++nonceRef.current

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
      setActiveFileName(name)
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
      setActiveFileName((cur) => (cur === oldName ? clean : cur))
    },
    [],
  )

  const deleteFile = useCallback((name: string) => {
    setFiles((fs) => {
      if (fs.length <= 1) return fs
      const next = fs.filter((f) => f.name !== name)
      setActiveFileName((cur) => (cur === name ? next[0].name : cur))
      return next
    })
  }, [])

  const loadExample = useCallback((ex: Example) => {
    setFiles(ex.files.length ? ex.files : [DEFAULT_FILE])
    setActiveFileName(ex.files[0]?.name ?? DEFAULT_FILE.name)
    setTop(ex.top ?? '')
  }, [])

  const synthesize = useCallback(async () => {
    setSynthesizing(true)
    setError(null)
    try {
      const res = await api.synthesize({
        files,
        top: top.trim() || undefined,
        mode,
        extra_args: extraArgs.trim() || undefined,
      })
      setDesign(res)
      setConeReq(null)
      setProbe(null)
      setActiveTab('overview')
    } catch (e) {
      const err = e as api.ApiRequestError
      setError({ message: err.message, log: err.log, status: err.status })
      setDesign(null)
    } finally {
      setSynthesizing(false)
    }
  }, [files, top, mode, extraArgs])

  const setGraphOptions = useCallback((patch: Partial<GraphOptions>) => {
    setGraphOptionsState((o) => ({ ...o, ...patch }))
  }, [])

  const openCone = useCallback(
    (opts: { node: number; dir: 'fanin' | 'fanout'; label: string }) => {
      setConeReq({
        node: opts.node,
        dir: opts.dir,
        label: opts.label,
        highlight: [],
        netlist: false,
        nonce: nextNonce(),
      })
      setActiveTab('graph')
    },
    [],
  )

  const showPathInGraph = useCallback((path: TimingPath) => {
    setConeReq({
      node: path.endpoint.id,
      dir: 'fanin',
      label: `Path → ${path.endpoint.name} (depth ${path.depth})`,
      highlight: path.nodes.map((n) => n.id),
      netlist: false,
      nonce: nextNonce(),
    })
    setActiveTab('graph')
  }, [])

  const openNetlist = useCallback(() => {
    setConeReq({
      node: -1,
      dir: 'fanin',
      label: 'Full netlist',
      highlight: [],
      netlist: true,
      nonce: nextNonce(),
    })
    setActiveTab('graph')
  }, [])

  const highlightSrc = useCallback((span: SrcSpan) => {
    setActiveFileName((cur) => (span.file ? span.file : cur))
    setEditorHighlight({ span, nonce: nextNonce() })
  }, [])

  const setCursor = useCallback((file: string, line: number) => {
    setCursorState({ file, line })
  }, [])

  const runProbe = useCallback(async () => {
    if (!design) return
    try {
      const map = await api.getSourceMap(design.design_id)
      const key = `${cursor.file}:${cursor.line}`
      const ids = map.by_line[key] ?? []
      setProbe({ file: cursor.file, line: cursor.line, nodeIds: ids })
    } catch (e) {
      const err = e as api.ApiRequestError
      setError({ message: err.message, log: err.log, status: err.status })
    }
  }, [design, cursor])

  const clearProbe = useCallback(() => setProbe(null), [])

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
      error,
      synthesize,
      activeTab,
      setActiveTab,
      coneReq,
      graphOptions,
      setGraphOptions,
      openCone,
      showPathInGraph,
      openNetlist,
      editorHighlight,
      highlightSrc,
      cursor,
      setCursor,
      probe,
      runProbe,
      clearProbe,
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
      updateFileContent,
      addFile,
      renameFile,
      deleteFile,
      loadExample,
      synthesizing,
      design,
      error,
      synthesize,
      activeTab,
      coneReq,
      graphOptions,
      setGraphOptions,
      openCone,
      showPathInGraph,
      openNetlist,
      editorHighlight,
      highlightSrc,
      cursor,
      setCursor,
      probe,
      runProbe,
      clearProbe,
      snapshotA,
      snapshotB,
      takeSnapshot,
    ],
  )

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}
