import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react'
import { boundaryPathPinSelection } from '../lib/graph/endpointCone'
import {
  loadGraphOptions,
  saveGraphOptions,
  type GraphOptions,
} from '../lib/graph/graphSettings'
import {
  graphRequestAfterSynthesis,
  sourceGraphRequest,
} from '../lib/graph/graphRequest'
import { displayNodeName } from '../lib/graph/prettyType'
import { createLatestGuard } from '../lib/latest'
import type { SrcSpan } from '../lib/source/src'
import {
  createSourceTierSelectionController,
  type SourceTierSelection,
} from '../lib/source/sourceTierSelection'
import type {
  SourceNetSelection,
  SourceTierSpan,
} from '../lib/source/sourceTiers'
import {
  createSourceProbeDebouncer,
  normalizeSourceSelection,
  type SourceSelection,
} from '../lib/synthesis/liveAnalysis'
import type { DesignFile, SynthesizeResponse, TimingPath } from '../types'
import type { AnalysisState, StoreError } from './synthesisSlice'

export type TabId =
  | 'overview'
  | 'endpoints'
  | 'paths'
  | 'fanout'
  | 'graph'

export interface ConeGraphRequest {
  kind: 'cone'
  designId: string
  node: number
  nodes: number[]
  dir: 'fanin' | 'fanout'
  label: string
  highlight: number[]
  rootPort?: string
  rootPortBit?: number
  rootPortBits?: number[]
  nonce: number
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

export type GraphRequest = ConeGraphRequest | SourceGraphRequest

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

function sourceCaret(file: string, line = 1, column = 1): SourceSelection {
  return {
    file,
    startLine: line,
    startColumn: column,
    endLine: line,
    endColumn: column,
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

export function useGraphRequestSlice({
  initialActiveFileName,
  filesRef,
  designRef,
  analysisStateRef,
  setActiveFileNameState,
}: {
  initialActiveFileName: string
  filesRef: RefObject<DesignFile[]>
  designRef: RefObject<SynthesizeResponse | null>
  analysisStateRef: RefObject<AnalysisState>
  setActiveFileNameState: Dispatch<SetStateAction<string>>
}) {
  const [activeTab, setActiveTab] = useState<TabId>('graph')
  const [coneReq, setConeReq] = useState<GraphRequest | null>(null)
  const [graphOptions, setGraphOptionsState] = useState<GraphOptions>(
    loadGraphOptions,
  )
  const [editorHighlight, setEditorHighlight] = useState<EditorHighlight | null>(
    null,
  )
  const [sourceSelection, setSourceSelectionState] = useState<SourceSelection>({
    file: initialActiveFileName,
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
  const graphOptionsRef = useRef(graphOptions)
  graphOptionsRef.current = graphOptions
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
    sourceTierControllerRef.current!({ kind: 'nodes', nodeIds })
  }, [])

  const selectSchematicNets = useCallback((selection: SourceNetSelection) => {
    sourceTierControllerRef.current!({ kind: 'nets', ...selection })
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
        nodeIds: selection.target.kind === 'nodes'
          ? selection.target.nodeIds
          : [],
        exact,
        contributing,
        approximate: selection.response.approximate,
        truncated: selection.response.truncated,
      },
    })
  }

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

  const setGraphOptions = useCallback((patch: Partial<GraphOptions>) => {
    const next = { ...graphOptionsRef.current, ...patch }
    graphOptionsRef.current = next
    saveGraphOptions(next)
    setGraphOptionsState(next)
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
    [analysisStateRef, cancelSourceProbe, designRef, nextNonce],
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
      highlight: path.nodes.map((node) => node.id),
      ...boundaryPathPinSelection(path.endpoint_kind, path.endpoint_port, path.bits),
      nonce: nextNonce(),
    })
    setActiveTab('graph')
  }, [analysisStateRef, cancelSourceProbe, designRef, nextNonce])

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
      const roots = [...new Set(
        requestedNodes?.length ? requestedNodes : node == null ? [] : [node],
      )]
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
    [analysisStateRef, cancelSourceProbe, designRef, nextNonce],
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
    sourceTierControllerRef.current!({ kind: 'nodes', nodeIds: [] })
    if (spans.length === 0) return
    if (analysisStateRef.current !== 'current') return
    const submittedNames = new Set(filesRef.current.map((file) => file.name))
    const primary = spans.findIndex((span) => submittedNames.has(span.file))
    const primaryIndex = primary >= 0 ? primary : 0
    const primarySpan = spans[primaryIndex]
    setActiveFileNameState((current) =>
      primarySpan.file ? primarySpan.file : current,
    )
    setEditorHighlight({ spans, primary: primaryIndex, nonce: nextNonce() })
  }, [analysisStateRef, filesRef, nextNonce, setActiveFileNameState])

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

  const resetSourceSelection = useCallback((file: string) => {
    const selection = sourceCaret(file)
    sourceSelectionRef.current = selection
    sourceSelectionActiveRef.current = false
    setSourceSelectionState(selection)
    setConeReq((request) => (request?.kind === 'source' ? null : request))
  }, [])

  const renameSourceFile = useCallback((oldName: string, newName: string) => {
    setSourceSelectionState((current) =>
      current.file === oldName ? { ...current, file: newName } : current,
    )
  }, [])

  const deleteSourceFile = useCallback((name: string, fallbackFile: string) => {
    if (sourceSelectionRef.current.file === name) {
      const selection = sourceCaret(fallbackFile)
      sourceSelectionRef.current = selection
      sourceSelectionActiveRef.current = false
      setConeReq((request) => (request?.kind === 'source' ? null : request))
    }
    setSourceSelectionState((current) =>
      current.file === name ? sourceCaret(fallbackFile) : current,
    )
  }, [])

  const clearForWorkspaceReset = useCallback(() => {
    setConeReq(null)
    selectSchematicNodes([])
  }, [selectSchematicNodes])

  const afterSynthesis = useCallback(() => {
    // A source graph tracks the selected lines across synthesis. Cones and
    // paths belong to the previous netlist and start deselected.
    setConeReq((request) =>
      graphRequestAfterSynthesis(
        request,
        sourceSelectionRef.current,
        nextNonce(),
      ),
    )
  }, [nextNonce])

  const setActiveFileName = useCallback((name: string) => {
    cancelSourceProbe()
    setActiveFileNameState(name)
    resetSourceSelection(name)
  }, [cancelSourceProbe, resetSourceSelection, setActiveFileNameState])

  const setActiveTabForUser = useCallback((tab: TabId) => {
    cancelSourceProbe()
    setActiveTab(tab)
    activeTabRef.current = tab
    if (tab === 'graph') {
      setConeReq((request) =>
        request?.kind === 'cone'
          ? request
          : sourceSelectionActiveRef.current
            ? sourceGraphRequest(sourceSelectionRef.current, nextNonce())
            : null,
      )
    }
  }, [cancelSourceProbe, nextNonce])

  return {
    activeTab,
    coneReq,
    graphOptions,
    editorHighlight,
    sourceSelection,
    setActiveTab: setActiveTabForUser,
    setGraphOptions,
    openCone,
    openControlCone,
    showPathInGraph,
    clearGraphSelection,
    registerGraphProbeReset,
    highlightSources,
    selectSchematicNodes,
    selectSchematicNets,
    setSourceSelection,
    setActiveFileName,
    cancelSourceProbe,
    resetSourceSelection,
    renameSourceFile,
    deleteSourceFile,
    clearForWorkspaceReset,
    afterSynthesis,
  }
}

export function useGraphRequestCleanup(cancelSourceProbe: () => void) {
  useEffect(() => () => cancelSourceProbe(), [cancelSourceProbe])
}

export function useAnalysisStateEffect({
  analysisState,
  selectSchematicNodes,
  setError,
}: {
  analysisState: AnalysisState
  selectSchematicNodes: (nodeIds: number[]) => void
  setError: (error: StoreError | null) => void
}) {
  useEffect(() => {
    if (analysisState !== 'current') {
      selectSchematicNodes([])
    } else {
      // A failure report is obsolete once the current input has a live
      // analysis (e.g. the failing edit was undone, restoring the last good
      // input).
      setError(null)
    }
  }, [analysisState, selectSchematicNodes, setError])
}
