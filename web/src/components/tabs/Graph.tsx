import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiRequestError, getCone, getNetlist } from '../../api'
import { analyzeSourceInBrowser } from '../../lib/sourceSelectionClient'
import { MAX_GRAPH_RENDER_NODES } from '../../lib/graphLimits'
import { graphProjection } from '../../lib/graphProjection'
import { mergeSubgraphs } from '../../lib/mergeSubgraph'
import { isDisplayedDesignCurrent } from '../../lib/graphOwnership'
import {
  layoutSubgraph,
  prewarmLayoutWorker,
  type LaidOutGraph,
} from '../../lib/layout'
import { sourceProbePresentation } from '../../lib/sourceProbe'
import { controlLabel } from '../../lib/symbols'
import type { GraphNode, SourceSelectionStatus, Subgraph } from '../../types'
import { shallowEqual, useStore } from '../../useStore'
import { BubbleLoader } from '../BubbleLoader'
import { GraphView } from '../GraphView'
import { NodeCard } from '../NodeCard'

interface FullSubgraph {
  designId: string
  key: string
  graph: Subgraph
}

interface RelevantSubgraph {
  designId: string
  requestKey: string
  graph: Subgraph
  relevantIds: number[]
  overlayIds: number[]
}

interface ExpansionState {
  ownerKey: string
  graph: Subgraph
  droppedNodes: number
  droppedEdges: number
}

interface DisplayedGraph {
  designId: string
  projectionKey: string
  subgraph: Subgraph
  graph: LaidOutGraph
}

interface FullGraphCacheEntry {
  key: string
  controller: AbortController
  promise: Promise<Subgraph>
}

export function Graph({ active }: { active: boolean }) {
  const store = useStore(
    ({
      analysisState,
      design,
      coneReq,
      graphOptions,
      clearGraphSelection,
      highlightNodeSources,
      openControlCone,
    }) => ({
      analysisState,
      design,
      coneReq,
      graphOptions,
      clearGraphSelection,
      highlightNodeSources,
      openControlCone,
    }),
    shallowEqual,
  )
  const {
    analysisState,
    design,
    coneReq,
    graphOptions,
    clearGraphSelection,
    highlightNodeSources,
    openControlCone,
  } = store

  const [fullSubgraph, setFullSubgraph] = useState<FullSubgraph | null>(null)
  const [relevantSubgraph, setRelevantSubgraph] =
    useState<RelevantSubgraph | null>(null)
  // Neighborhoods accumulated from double-click expansions, merged on top of the
  // active projection before layout. The owner keeps full-view expansions stable
  // while non-focus selections update only their highlights.
  const [expansionState, setExpansionState] = useState<ExpansionState | null>(null)
  const [displayedGraph, setDisplayedGraph] = useState<DisplayedGraph | null>(null)
  const [fetchingFull, setFetchingFull] = useState(false)
  const [fetchingRelevant, setFetchingRelevant] = useState(false)
  const [layingOut, setLayingOut] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<GraphNode | null>(null)
  const [sourceStatus, setSourceStatus] = useState<SourceSelectionStatus | null>(null)
  const [sourceControl, setSourceControl] = useState(false)
  const [fitNonce, setFitNonce] = useState(0)
  const reqSeq = useRef(0)
  const expansionControllers = useRef(new Set<AbortController>())
  const loadedFullGraphKey = useRef<string | null>(null)
  const laidOutSubgraph = useRef<Subgraph | null>(null)
  const displayedGraphRef = useRef<DisplayedGraph | null>(null)
  const layoutCache = useRef(new WeakMap<Subgraph, LaidOutGraph>())
  // The full projection is independent of source/cone selection. Reusing this
  // single entry keeps non-focus selection changes free of netlist refetches.
  const fullGraphCache = useRef<FullGraphCacheEntry | null>(null)

  // ELK is a large module and this graph surface stays mounted across tabs.
  // Start its reusable worker once at mount so module startup can overlap the
  // editor's initial idle/debounce window instead of the first real layout.
  useEffect(() => {
    prewarmLayoutWorker()
  }, [])

  useEffect(() => {
    if (!active) return
    const clearSelection = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      setSelected(null)
      clearGraphSelection()
    }
    window.addEventListener('keydown', clearSelection)
    return () => window.removeEventListener('keydown', clearSelection)
  }, [active, clearGraphSelection])

  // Every option changes a graph projection. Source projections are local;
  // full and node-cone projections still come from the analysis worker.
  const optsKey = `${graphOptions.maxDepth}|${graphOptions.maxNodes}|${graphOptions.hideControl}|${graphOptions.hideConst}|${graphOptions.groupVectors}`
  const fullGraphKey = design
    ? `${design.design_id}|${graphOptions.maxNodes}|${graphOptions.groupVectors}|${graphOptions.hideControl}|${graphOptions.hideConst}`
    : null
  const currentRequestKey = design
    ? `${design.design_id}|${coneReq?.nonce ?? 'full'}|${optsKey}`
    : null
  const requestDesignMismatch = Boolean(
    design && coneReq?.kind === 'cone' && coneReq.designId !== design.design_id,
  )

  // The full projection changes only with the design or analysis options.
  useEffect(() => {
    const cached = fullGraphCache.current
    if (cached && cached.key !== fullGraphKey) {
      cached.controller.abort()
      fullGraphCache.current = null
    }
  }, [fullGraphKey])
  useEffect(
    () => () => {
      fullGraphCache.current?.controller.abort()
      fullGraphCache.current = null
      for (const inFlight of expansionControllers.current) inFlight.abort()
      expansionControllers.current.clear()
    },
    [],
  )

  const fetchFullGraph = useCallback(
    (requestDesignId: string) => {
      if (fullGraphKey == null) return Promise.reject(new Error('missing graph cache key'))
      const cached = fullGraphCache.current
      if (cached?.key === fullGraphKey) return cached.promise
      cached?.controller.abort()
      const fullController = new AbortController()
      let entry: FullGraphCacheEntry
      // Let the selection effect in this commit post its bounded query first.
      // The analysis worker is synchronous, so queueing a whole-netlist scan
      // first would otherwise head-of-line block the responsive source result.
      const promise = Promise.resolve()
        .then(() => {
          fullController.signal.throwIfAborted()
          return getNetlist(
            requestDesignId,
            {
              max_nodes: graphOptions.maxNodes,
              show_infrastructure: false,
              group_vectors: graphOptions.groupVectors,
              hide_control: graphOptions.hideControl,
              hide_const: graphOptions.hideConst,
            },
            fullController.signal,
          )
        })
        .catch((error) => {
          if (fullGraphCache.current === entry) fullGraphCache.current = null
          throw error
        })
      entry = { key: fullGraphKey, controller: fullController, promise }
      fullGraphCache.current = entry
      return promise
    },
    [
      fullGraphKey,
      graphOptions.groupVectors,
      graphOptions.hideConst,
      graphOptions.hideControl,
      graphOptions.maxNodes,
    ],
  )

  // Fetch the capped full schematic independently of selection. It is the
  // stable non-focus geometry and is also ready when Focus is turned off.
  useEffect(() => {
    if (!design || fullGraphKey == null) {
      setFullSubgraph(null)
      setRelevantSubgraph(null)
      setExpansionState(null)
      setDisplayedGraph(null)
      displayedGraphRef.current = null
      loadedFullGraphKey.current = null
      laidOutSubgraph.current = null
      return
    }
    if (!active || analysisState !== 'current') return
    if (loadedFullGraphKey.current === fullGraphKey) return

    const requestDesignId = design.design_id
    const ownerKey = fullGraphKey
    let cancelled = false
    setFetchingFull(true)
    setError(null)
    fetchFullGraph(requestDesignId)
      .then((graph) => {
        if (cancelled || fullGraphCache.current?.key !== ownerKey) return
        loadedFullGraphKey.current = ownerKey
        setFullSubgraph({ designId: requestDesignId, key: ownerKey, graph })
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof ApiRequestError ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setFetchingFull(false)
      })
    return () => {
      cancelled = true
      setFetchingFull(false)
    }
  }, [active, analysisState, design, fetchFullGraph, fullGraphKey])

  // Source/cone requests compute relevance and overlays. They do not replace
  // the rendered graph unless Focus is on.
  useEffect(() => {
    setSourceStatus(null)
    setSourceControl(false)
    setRelevantSubgraph(null)
    if (!design || !coneReq || currentRequestKey == null || requestDesignMismatch) {
      setFetchingRelevant(false)
      return
    }
    if (!active || analysisState !== 'current') return

    const requestDesignId = design.design_id
    const request = coneReq
    const requestKey = currentRequestKey
    const myReq = ++reqSeq.current
    const controller = new AbortController()
    setFetchingRelevant(true)
    setError(null)
    if (request.kind !== 'source') setSelected(null)
    const fetchRelevantGraph =
      request.kind === 'source'
        ? analyzeSourceInBrowser(requestDesignId, {
            file: request.file,
            startLine: request.startLine,
            endLine: request.endLine,
          }, {
            maxNodes: graphOptions.maxNodes,
            hideControl: graphOptions.hideControl,
            hideConst: graphOptions.hideConst,
            groupVectors: graphOptions.groupVectors,
          }, controller.signal).then((response) => ({
            graph: response.graph,
            status: response.status,
            control: response.control,
            directIds: response.directIds,
          }))
        : getCone(requestDesignId, {
            node: request.node,
            nodes: request.nodes.length > 1 ? request.nodes : undefined,
            dir: request.dir,
            max_depth: graphOptions.maxDepth,
            max_nodes: graphOptions.maxNodes,
            hide_control: graphOptions.hideControl,
            hide_const: graphOptions.hideConst,
            show_infrastructure: false,
            group_vectors: graphOptions.groupVectors,
            root_port: request.rootPort,
            root_port_bit: request.rootPortBit,
            root_port_bits: request.rootPortBits,
          }, controller.signal).then((graph) => ({
            graph,
            status: null,
            control: false,
            directIds: [],
          }))
    fetchRelevantGraph
      .then(({ graph, status, control, directIds }) => {
        if (controller.signal.aborted || myReq !== reqSeq.current) return
        setSourceControl(control)
        const presentation = sourceProbePresentation(status)
        if (presentation.acceptReturnedGraph) {
          setSourceStatus(status)
          setRelevantSubgraph({
            designId: requestDesignId,
            requestKey,
            graph,
            relevantIds: graph.nodes.map((node) => node.id),
            overlayIds: [
              ...request.highlight,
              ...(request.kind === 'source' && presentation.showDirectSelection
                ? directIds
                : []),
            ],
          })
          if (status != null) setSelected(null)
        } else {
          clearGraphSelection()
        }
      })
      .catch((e) => {
        if (controller.signal.aborted || myReq !== reqSeq.current) return
        setError(e instanceof ApiRequestError ? e.message : String(e))
      })
      .finally(() => {
        if (!controller.signal.aborted && myReq === reqSeq.current) {
          setFetchingRelevant(false)
        }
      })
    return () => {
      controller.abort()
      setFetchingRelevant(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    active,
    analysisState,
    design?.design_id,
    coneReq?.nonce,
    optsKey,
    requestDesignMismatch,
  ])

  const relevantRequestCurrent =
    currentRequestKey != null && relevantSubgraph?.requestKey === currentRequestKey
  const focusActive = Boolean(graphOptions.focus && coneReq)
  const projectionKey = focusActive ? currentRequestKey : fullGraphKey
  const projectedSubgraph = graphProjection(
    fullSubgraph?.key === fullGraphKey ? fullSubgraph.graph : null,
    relevantRequestCurrent ? relevantSubgraph.graph : null,
    focusActive,
  )
  const activeExpansion =
    expansionState?.ownerKey === projectionKey ? expansionState : null

  // The selected projection is merged only with expansions that belong to it.
  // In non-focus mode, selection changes leave both inputs identical and skip
  // layout entirely.
  const combined = useMemo(() => {
    if (!projectedSubgraph) return null
    const expanded = mergeSubgraphs(
      projectedSubgraph,
      activeExpansion?.graph ?? null,
      MAX_GRAPH_RENDER_NODES,
    )
    return {
      graph: expanded.graph,
      expansionDroppedNodes:
        (activeExpansion?.droppedNodes ?? 0) + expanded.droppedNodes,
      expansionDroppedEdges:
        (activeExpansion?.droppedEdges ?? 0) + expanded.droppedEdges,
    }
  }, [activeExpansion, projectedSubgraph])
  const combinedSubgraph = combined?.graph ?? null

  // Lay out only while visible, and retain a completed layout across tabs.
  useEffect(() => {
    if (!active) return
    if (!combinedSubgraph || projectionKey == null) return
    if (laidOutSubgraph.current === combinedSubgraph) return
    const ownerDesignId = focusActive
      ? relevantSubgraph?.designId
      : fullSubgraph?.designId
    if (ownerDesignId == null) return
    const toLayout = combinedSubgraph
    const previousDisplay = displayedGraphRef.current
    const sameProjection =
      previousDisplay?.designId === ownerDesignId &&
      previousDisplay.projectionKey === projectionKey
    const cachedLayout = layoutCache.current.get(toLayout)
    if (cachedLayout) {
      const nextDisplay = {
        designId: ownerDesignId,
        projectionKey,
        subgraph: toLayout,
        graph: cachedLayout,
      }
      displayedGraphRef.current = nextDisplay
      setDisplayedGraph(nextDisplay)
      laidOutSubgraph.current = toLayout
      if (!sameProjection) setFitNonce((n) => n + 1)
      return
    }
    let cancelled = false
    const controller = new AbortController()
    setLayingOut(true)
    // Every expanded projection gets a fresh optimal ELK layout. Reusing the
    // previous coordinates makes a focused subset inherit the full schematic's
    // spacing and leaves large, awkward gaps. GraphView separately preserves a
    // retained node's viewport position so the relayout does not feel like a jump.
    layoutSubgraph(toLayout, controller.signal)
      .then((g) => {
        if (cancelled) return
        const nextDisplay = {
          designId: ownerDesignId,
          projectionKey,
          subgraph: toLayout,
          graph: g,
        }
        layoutCache.current.set(toLayout, g)
        displayedGraphRef.current = nextDisplay
        setDisplayedGraph(nextDisplay)
        laidOutSubgraph.current = toLayout
        setLayingOut(false)
        if (!sameProjection) setFitNonce((n) => n + 1)
      })
      .catch((e) => {
        if (cancelled || controller.signal.aborted) return
        setError(String(e instanceof Error ? e.message : e))
        laidOutSubgraph.current = null
        setLayingOut(false)
      })
    return () => {
      cancelled = true
      controller.abort()
      setLayingOut(false)
    }
  }, [
    active,
    combinedSubgraph,
    focusActive,
    fullSubgraph?.designId,
    projectionKey,
    relevantSubgraph?.designId,
  ])

  const displayedDesignCurrent = isDisplayedDesignCurrent(
    design?.design_id,
    displayedGraph?.designId,
  )
  // Keep completed layouts cached, but never render a schematic for stale
  // synthesis inputs or while the replacement design is still being laid out.
  const visibleDisplayedGraph =
    analysisState === 'current' && displayedDesignCurrent ? displayedGraph : null
  const sub = visibleDisplayedGraph?.subgraph ?? null
  const laid = visibleDisplayedGraph?.graph ?? null
  const sourcePresentation = sourceProbePresentation(sourceStatus)
  const displayedProjectionCurrent =
    projectionKey != null && displayedGraph?.projectionKey === projectionKey
  const graphInteractive =
    analysisState === 'current' && displayedDesignCurrent && displayedProjectionCurrent
  const relevantIds = useMemo(
    () =>
      new Set<number>(
        [
          ...(relevantRequestCurrent ? (relevantSubgraph?.relevantIds ?? []) : []),
          ...(activeExpansion?.graph.nodes.map((node) => node.id) ?? []),
        ],
      ),
    [activeExpansion, relevantRequestCurrent, relevantSubgraph?.relevantIds],
  )
  const overlayIds = useMemo(() => {
    const ids = new Set<number>(
      relevantRequestCurrent ? (relevantSubgraph?.overlayIds ?? []) : [],
    )
    // A grouped bus node collapses per-bit ids the highlight set names, so it
    // must highlight when any of its members does (e.g. a path through a bus).
    for (const node of sub?.nodes ?? []) {
      if (node.members?.some((member) => ids.has(member))) ids.add(node.id)
    }
    return ids
  }, [relevantRequestCurrent, relevantSubgraph?.overlayIds, sub])
  const rootId =
    relevantRequestCurrent && coneReq?.kind === 'cone' ? coneReq.node : -1

  // Net driven by the selected node (first outgoing edge) — lets the detail
  // card show a readable identity for hidden-name cells.
  const selectedNet = useMemo(() => {
    if (!sub || !selected) return null
    return sub.edges.find((e) => e.from === selected.id)?.net_name ?? null
  }, [sub, selected])

  // Double-click a node to additively pull in its immediate fanin and fanout
  // neighbors. Grouped nodes expand around their member bits so the neighborhood
  // comes back grouped and its synthetic ids line up with the base graph.
  const designId = design?.design_id
  const onExpand = useCallback(
    (node: GraphNode) => {
      if (!designId || !graphInteractive || !displayedGraph?.projectionKey) return
      setError(null)
      // Group projections expose a stable synthetic id. The grouped API
      // contract resolves that id in the worker, avoiding unbounded messages
      // and the public 200-root limit for wide vectors.
      const ids = [node.id]
      const ownerKey = displayedGraph.projectionKey
      const controller = new AbortController()
      expansionControllers.current.add(controller)
      const shared = {
        node: ids[0],
        nodes: ids.length > 1 ? ids : undefined,
        max_depth: 1,
        max_nodes: graphOptions.maxNodes,
        hide_control: graphOptions.hideControl,
        hide_const: graphOptions.hideConst,
        show_infrastructure: false,
        group_vectors: graphOptions.groupVectors,
      }
      Promise.all([
        getCone(designId, { ...shared, dir: 'fanin' }, controller.signal),
        getCone(designId, { ...shared, dir: 'fanout' }, controller.signal),
      ])
        .then(([fanin, fanout]) => {
          // Drop stale results if the rendered projection changed while fetching.
          if (
            controller.signal.aborted ||
            displayedGraphRef.current?.projectionKey !== ownerKey
          ) return
          // A depth-1 neighborhood is deliberately shallow, so its truncated
          // flag (hit the depth limit) is expected and must not mark the whole
          // view truncated — only the base cone and render cap do that.
          const clear = (g: Subgraph): Subgraph => ({ ...g, truncated: false })
          setExpansionState((prev) => {
            const owned = prev?.ownerKey === ownerKey ? prev : null
            const acc = owned?.graph ?? { nodes: [], edges: [], truncated: false }
            const withFanin = mergeSubgraphs(
              acc,
              clear(fanin),
              MAX_GRAPH_RENDER_NODES,
            )
            const withFanout = mergeSubgraphs(
              withFanin.graph,
              clear(fanout),
              MAX_GRAPH_RENDER_NODES,
            )
            return {
              ownerKey,
              graph: withFanout.graph,
              droppedNodes:
                (owned?.droppedNodes ?? 0) +
                withFanin.droppedNodes +
                withFanout.droppedNodes,
              droppedEdges:
                (owned?.droppedEdges ?? 0) +
                withFanin.droppedEdges +
                withFanout.droppedEdges,
            }
          })
        })
        .catch((e) => {
          if (
            controller.signal.aborted ||
            displayedGraphRef.current?.projectionKey !== ownerKey
          ) return
          setError(
            `Could not expand ${node.name || node.id}: ${
              e instanceof ApiRequestError ? e.message : String(e)
            }`,
          )
        })
        .finally(() => expansionControllers.current.delete(controller))
    },
    [
      designId,
      displayedGraph?.projectionKey,
      graphInteractive,
      graphOptions.groupVectors,
      graphOptions.hideConst,
      graphOptions.hideControl,
      graphOptions.maxNodes,
    ],
  )

  const onGraphSelect = useCallback(
    (node: GraphNode | null) => {
      if (!graphInteractive) return
      setSelected(node)
      highlightNodeSources(node?.src)
    },
    [graphInteractive, highlightNodeSources],
  )
  const onControlSelect = useCallback(
    (control: NonNullable<GraphNode['controls']>[number]) => {
      if (!graphInteractive) return
      openControlCone({
        node: control.driver_id,
        label: controlLabel(control),
        generated: control.generated,
      })
    },
    [graphInteractive, openControlCone],
  )
  const focusMode =
    relevantRequestCurrent && relevantIds.size > 0
      ? focusActive
        ? 'on'
        : 'off'
      : undefined
  const loading = fetchingFull || fetchingRelevant || layingOut
  const showLoading = loading || analysisState === 'refreshing'

  if (!design) return <div className="empty-state">No design yet.</div>

  return (
    <div className="graph-tab">
      <GraphToolbar graphInteractive={graphInteractive} />
      <div
        className="graph-stage-wrap"
        data-focus={focusMode}
        style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex' }}
      >
        {laid && laid.nodes.length > 0 ? (
          <GraphView
            graph={laid}
            rootId={rootId}
            relevantIds={relevantIds}
            overlayIds={overlayIds}
            extendOverlayToBoundaryNets={coneReq?.kind === 'source'}
            selectedId={graphInteractive ? (selected?.id ?? null) : null}
            interactive={graphInteractive}
            onSelect={onGraphSelect}
            onControlSelect={graphInteractive ? onControlSelect : undefined}
            onExpand={graphInteractive ? onExpand : undefined}
            active={active}
            fitNonce={fitNonce}
          />
        ) : (
          <div className="graph-stage">
            <div className="empty-state">
              {loading
                ? ''
                : error
                  ? ''
                  : sub && sub.nodes.length === 0
                    ? 'Empty cone — nothing drives/loads this node within the limits.'
                    : 'No schematic.'}
            </div>
          </div>
        )}

        <div className="graph-banner">
          {showLoading && (
            <span className="graph-loading-indicator">
              <BubbleLoader size={32} label="Loading schematic" />
            </span>
          )}
          {error && <span className="msg err">{error}</span>}
          {analysisState === 'stale' && (
            <span className="msg">source changed — synthesize to refresh mapping</span>
          )}
          {requestDesignMismatch && (
            <span className="msg">this cone belongs to the previous synthesis</span>
          )}
          {sourcePresentation.message && (
            <span className="msg">{sourcePresentation.message}</span>
          )}
          {sourceControl && (
            <span className="msg">
              control path selection — reset/clock/enable connectivity is shown
            </span>
          )}
          {coneReq?.kind === 'source' && coneReq.selectionTruncated && (
            <span className="msg">selection capped at 200 source lines</span>
          )}
          {sub?.truncated && (
            <span className="msg">
              truncated — {sub.nodes.length} nodes and {sub.edges.length} edges shown;
              analysis limits omitted additional schematic content
            </span>
          )}
          {(combined?.expansionDroppedNodes ?? 0) > 0 ||
          (combined?.expansionDroppedEdges ?? 0) > 0 ? (
            <span className="msg">
              expansion reached the render cap — {combined?.expansionDroppedNodes ?? 0}{' '}
              nodes and {combined?.expansionDroppedEdges ?? 0} edges omitted
            </span>
          ) : null}
          {sub && !sub.truncated && (
            <span className="graph-count">{sub.nodes.length} nodes · {sub.edges.length} edges</span>
          )}
        </div>

        {selected && graphInteractive && (
          <NodeCard
            node={selected}
            drivingNet={selectedNet}
            onClose={() => setSelected(null)}
            onExpand={() => onExpand(selected)}
          />
        )}
      </div>
    </div>
  )
}

function GraphToolbar({ graphInteractive }: { graphInteractive: boolean }) {
  const store = useStore(
    ({ coneReq, design, graphOptions, setGraphOptions, openCone }) => ({
      coneReq,
      design,
      graphOptions,
      setGraphOptions,
      openCone,
    }),
    shallowEqual,
  )
  const { coneReq, design, graphOptions } = store
  const requestDesignMismatch = Boolean(
    design && coneReq?.kind === 'cone' && coneReq.designId !== design.design_id,
  )
  const setOpt = store.setGraphOptions
  const focusAvailable = coneReq?.kind === 'cone' || coneReq?.kind === 'source'

  const reissue = (dir: 'fanin' | 'fanout') => {
    if (coneReq?.kind !== 'cone') return
    store.openCone({
      nodes: coneReq.nodes,
      dir,
      label: coneReq.label,
      highlight: coneReq.highlight,
      rootPort: dir === 'fanin' ? coneReq.rootPort : undefined,
      rootPortBit: dir === 'fanin' ? coneReq.rootPortBit : undefined,
      rootPortBits: dir === 'fanin' ? coneReq.rootPortBits : undefined,
    })
  }

  return (
    <div className="graph-toolbar">
      {coneReq && (
        <>
          <span
            className="mono"
            style={{ color: 'var(--text-dim)', fontSize: 12 }}
          >
            {coneReq.label}
          </span>
          <span className="sep" />
        </>
      )}

      <label className="toggle" title="Max nodes to request">
        max nodes
        <div className="stepper">
          <button
            onClick={() => setOpt({ maxNodes: Math.max(50, graphOptions.maxNodes - 100) })}
          >
            −
          </button>
          <span className="val">{graphOptions.maxNodes}</span>
          <button
            onClick={() =>
              setOpt({
                maxNodes: Math.min(
                  MAX_GRAPH_RENDER_NODES,
                  graphOptions.maxNodes + 100,
                ),
              })
            }
          >
            +
          </button>
        </div>
      </label>
      <label className="toggle">
        <input
          type="checkbox"
          checked={graphOptions.hideControl}
          onChange={(e) => setOpt({ hideControl: e.target.checked })}
        />
        hide control
      </label>
      <label className="toggle">
        <input
          type="checkbox"
          checked={graphOptions.hideConst}
          onChange={(e) => setOpt({ hideConst: e.target.checked })}
        />
        hide const
      </label>

      <label
        className="toggle"
        title="Collapse bit-parallel vectors into one node per bus"
      >
        <input
          type="checkbox"
          checked={graphOptions.groupVectors}
          onChange={(event) => setOpt({ groupVectors: event.target.checked })}
        />
        group buses
      </label>

      <label
        className="toggle"
        title={
          focusAvailable
            ? graphOptions.focus
              ? 'Show only the logic relevant to this selection'
              : 'Show the full schematic and highlight the relevant logic'
            : graphOptions.focus
              ? 'Turn Focus off before choosing a source selection or cone'
              : 'Focus applies to source selections and cones'
        }
      >
        <input
          type="checkbox"
          checked={graphOptions.focus}
          disabled={!focusAvailable && !graphOptions.focus}
          onChange={(event) => setOpt({ focus: event.target.checked })}
        />
        Focus
      </label>

      {coneReq?.kind === 'cone' && (
        <>
          <div className="stepper" title="Cone direction">
            <button
              className={coneReq.dir === 'fanin' ? 'primary' : ''}
              disabled={requestDesignMismatch || !graphInteractive}
              onClick={() => reissue('fanin')}
            >
              fanin
            </button>
            <button
              className={coneReq.dir === 'fanout' ? 'primary' : ''}
              disabled={requestDesignMismatch || !graphInteractive}
              onClick={() => reissue('fanout')}
            >
              fanout
            </button>
          </div>

          <label className="toggle">
            depth
            <div className="stepper">
              <button onClick={() => setOpt({ maxDepth: Math.max(1, graphOptions.maxDepth - 1) })}>
                −
              </button>
              <span className="val">{graphOptions.maxDepth}</span>
              <button onClick={() => setOpt({ maxDepth: graphOptions.maxDepth + 1 })}>+</button>
            </div>
          </label>
        </>
      )}
    </div>
  )
}
