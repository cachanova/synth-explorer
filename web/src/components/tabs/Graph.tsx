import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiRequestError, getCone, getLineCone, getNetlist } from '../../api'
import { contextRootsFor } from '../../lib/graphContext'
import { MAX_GRAPH_RENDER_NODES } from '../../lib/graphLimits'
import { mergeSubgraphs } from '../../lib/mergeSubgraph'
import { isDisplayedDesignCurrent, isDisplayedRequestCurrent } from '../../lib/graphOwnership'
import { layoutSubgraph, type LaidOutGraph } from '../../lib/layout'
import { sourceProbePresentation } from '../../lib/sourceProbe'
import { controlLabel } from '../../lib/symbols'
import type { GraphNode, LineConeStatus, Subgraph } from '../../types'
import { shallowEqual, useStore } from '../../useStore'
import { GraphView } from '../GraphView'
import { NodeCard } from '../NodeCard'

interface FetchedSubgraph {
  designId: string
  requestKey: string
  graph: Subgraph
  relevantIds: number[]
  overlayIds: number[]
  contextRoots: number[]
}

interface ContextSubgraph {
  requestKey: string
  graph: Subgraph
}

interface ExpansionState {
  graph: Subgraph
  droppedNodes: number
  droppedEdges: number
}

interface DisplayedGraph {
  designId: string
  requestKey: string
  subgraph: Subgraph
  graph: LaidOutGraph
  relevantIds: number[]
  overlayIds: number[]
}

interface FullGraphCacheEntry {
  baseKey: string
  key: string
  ownerKey: string
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

  const [fetchedSubgraph, setFetchedSubgraph] = useState<FetchedSubgraph | null>(null)
  // Neighborhoods accumulated from double-click expansions, merged on top of the
  // base subgraph before layout. Reset whenever a new base subgraph is fetched.
  const [contextSubgraph, setContextSubgraph] = useState<ContextSubgraph | null>(null)
  const [expansionState, setExpansionState] = useState<ExpansionState | null>(null)
  const [displayedGraph, setDisplayedGraph] = useState<DisplayedGraph | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<GraphNode | null>(null)
  const [sourceStatus, setSourceStatus] = useState<LineConeStatus | null>(null)
  const [sourceControl, setSourceControl] = useState(false)
  const [fitNonce, setFitNonce] = useState(0)
  const reqSeq = useRef(0)
  const expansionControllers = useRef(new Set<AbortController>())
  const loadedRequestKey = useRef<string | null>(null)
  const laidOutSubgraph = useRef<Subgraph | null>(null)
  const displayedGraphRef = useRef<DisplayedGraph | null>(null)
  // One context projection, whether in flight or resolved, is enough for all
  // toggles of the current selection. The single-entry cache bounds memory and
  // is replaced when the relevant roots or server options change.
  const fullGraphCache = useRef<FullGraphCacheEntry | null>(null)

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

  // Every option here changes what the server returns, so a change refetches.
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

  // A selection-only request may share an in-flight full projection. Abort it
  // only when the design or an actual /netlist option changes, or on unmount.
  useEffect(() => {
    const cached = fullGraphCache.current
    if (cached && cached.baseKey !== fullGraphKey) {
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
    (requestDesignId: string, around: number[] = [], ownerKey = currentRequestKey) => {
      if (fullGraphKey == null) return Promise.reject(new Error('missing graph cache key'))
      if (ownerKey == null) return Promise.reject(new Error('missing graph request owner'))
      const key = `${fullGraphKey}|${around.join(',')}`
      const cached = fullGraphCache.current
      if (cached?.key === key && cached.ownerKey === ownerKey) return cached.promise
      cached?.controller.abort()
      const fullController = new AbortController()
      let entry: FullGraphCacheEntry
      const promise = getNetlist(
        requestDesignId,
        {
          max_nodes: graphOptions.maxNodes,
          show_infrastructure: false,
          group_vectors: graphOptions.groupVectors,
          hide_control: graphOptions.hideControl,
          hide_const: graphOptions.hideConst,
          around,
        },
        fullController.signal,
      ).catch((error) => {
        if (fullGraphCache.current === entry) fullGraphCache.current = null
        throw error
      })
      entry = { baseKey: fullGraphKey, key, ownerKey, controller: fullController, promise }
      fullGraphCache.current = entry
      return promise
    },
    [
      fullGraphKey,
      currentRequestKey,
      graphOptions.groupVectors,
      graphOptions.hideConst,
      graphOptions.hideControl,
      graphOptions.maxNodes,
    ],
  )

  // A request can change while analysis is stale. Clear the previous source
  // classification immediately instead of showing it for the new selection.
  useEffect(() => {
    setSourceStatus(null)
    setSourceControl(false)
  }, [analysisState, coneReq?.nonce])

  // Fetch subgraphs only while Graph is visible. A completed request key is
  // retained across tab switches so returning to Graph does not refetch or
  // disturb its local view state.
  useEffect(() => {
    if (!active) return
    if (!design || fullGraphKey == null) {
      setFetchedSubgraph(null)
      setContextSubgraph(null)
      setExpansionState(null)
      setDisplayedGraph(null)
      displayedGraphRef.current = null
      loadedRequestKey.current = null
      laidOutSubgraph.current = null
      return
    }
    if (analysisState !== 'current') return
    if (requestDesignMismatch) return
    const requestDesignId = design.design_id
    const request = coneReq
    const requestKey = currentRequestKey
    if (requestKey == null) return
    if (loadedRequestKey.current === requestKey) return

    const myReq = ++reqSeq.current
    for (const inFlight of expansionControllers.current) inFlight.abort()
    expansionControllers.current.clear()
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    setContextSubgraph(null)
    setExpansionState(null)
    setSourceStatus(null)
    setSourceControl(false)
    if (request?.kind !== 'source') setSelected(null)
    const fetchRelevantGraph =
      request?.kind === 'source'
        ? getLineCone(requestDesignId, {
            file: request.file,
            start_line: request.startLine,
            end_line: request.endLine,
            max_nodes: graphOptions.maxNodes,
            hide_control: graphOptions.hideControl,
            hide_const: graphOptions.hideConst,
            show_infrastructure: false,
            group_vectors: graphOptions.groupVectors,
          }, controller.signal).then((response) => ({
            graph: response.graph,
            status: response.status,
            control: response.control,
            highlight: response.highlight,
          }))
        : request?.kind === 'cone'
          ? getCone(requestDesignId, {
              node: request.node,
              nodes: request.nodes.length > 1 ? request.nodes : undefined,
              dir: request.dir,
              max_depth: graphOptions.maxDepth,
              max_nodes: graphOptions.maxNodes,
              hide_control: graphOptions.hideControl,
              hide_const: graphOptions.hideConst,
              show_infrastructure: false,
              group_vectors: graphOptions.groupVectors,
            }, controller.signal).then((graph) => ({
              graph,
              status: null,
              control: false,
              highlight: [],
            }))
          : null
    const fetchP =
      fetchRelevantGraph == null
        ? fetchFullGraph(requestDesignId).then((graph) => ({
            graph,
            status: null,
            control: false,
            highlight: [],
          }))
        : fetchRelevantGraph
    fetchP
      .then(({ graph, status, control, highlight }) => {
        if (controller.signal.aborted || myReq !== reqSeq.current) return
        loadedRequestKey.current = requestKey
        setSourceControl(control)
        const presentation = sourceProbePresentation(status)
        // A partial mapping is still useful and replaces the prior selection.
        if (presentation.acceptReturnedGraph) {
          setSourceStatus(status)
          const overlayIds = [
            ...(request?.highlight ?? []),
            ...(request?.kind === 'source' && presentation.highlightSelection
              ? highlight
              : []),
          ]
          setFetchedSubgraph({
            designId: requestDesignId,
            requestKey,
            graph,
            relevantIds: request == null ? [] : graph.nodes.map((node) => node.id),
            overlayIds,
            contextRoots: request == null ? [] : contextRootsFor(request, graph, highlight),
          })
          if (status != null) setSelected(null)
        }
        // Nothing synthesizable maps to this selection — fall back to the full
        // netlist instead of a bare message, keeping a schematic on screen.
        // Clear the status here so the unmapped message never flashes over the
        // netlist we are about to open.
        else {
          setSourceStatus(null)
          setLoading(false)
          clearGraphSelection()
        }
      })
      .catch((e) => {
        if (controller.signal.aborted || myReq !== reqSeq.current) return
        setError(e instanceof ApiRequestError ? e.message : String(e))
        setLoading(false)
      })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, analysisState, design?.design_id, coneReq?.nonce, optsKey, requestDesignMismatch, fullGraphKey, fetchFullGraph])

  // Context is loaded at most once for a relevant request, the first time the
  // user turns Focus off. It is retained thereafter so toggles are CSS-only.
  useEffect(() => {
    if (!active || graphOptions.focus || analysisState !== 'current') return
    if (!design || !fetchedSubgraph || fetchedSubgraph.relevantIds.length === 0) return
    if (fetchedSubgraph.requestKey !== currentRequestKey) return
    if (contextSubgraph?.requestKey === fetchedSubgraph.requestKey) return
    const owner = fetchedSubgraph
    let cancelled = false
    fetchFullGraph(design.design_id, owner.contextRoots, owner.requestKey)
      .then((graph) => {
        if (cancelled) return
        if (loadedRequestKey.current !== owner.requestKey) return
        setContextSubgraph({ requestKey: owner.requestKey, graph })
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof ApiRequestError ? e.message : String(e))
      })
    return () => {
      cancelled = true
      const cached = fullGraphCache.current
      if (cached?.ownerKey === owner.requestKey) {
        cached.controller.abort()
        fullGraphCache.current = null
      }
    }
  }, [
    active,
    analysisState,
    contextSubgraph?.requestKey,
    currentRequestKey,
    design,
    fetchedSubgraph,
    fetchFullGraph,
    graphOptions.focus,
  ])

  // The rendered subgraph is the fetched base with every double-click expansion
  // merged on top. Memoized so a tab switch does not rebuild it and force a
  // needless relayout.
  const combined = useMemo(() => {
    if (!fetchedSubgraph) return null
    const context =
      contextSubgraph?.requestKey === fetchedSubgraph.requestKey
        ? contextSubgraph.graph
        : null
    const contextual = mergeSubgraphs(
      fetchedSubgraph.graph,
      context,
      graphOptions.maxNodes,
    )
    const expanded = mergeSubgraphs(
      contextual.graph,
      expansionState?.graph ?? null,
      MAX_GRAPH_RENDER_NODES,
    )
    return {
      graph: expanded.graph,
      relevantIds: [
        ...fetchedSubgraph.relevantIds,
        ...(expansionState?.graph.nodes.map((node) => node.id) ?? []),
      ],
      expansionDroppedNodes:
        (expansionState?.droppedNodes ?? 0) + expanded.droppedNodes,
      expansionDroppedEdges:
        (expansionState?.droppedEdges ?? 0) + expanded.droppedEdges,
    }
  }, [contextSubgraph, expansionState, fetchedSubgraph, graphOptions.maxNodes])
  const combinedSubgraph = combined?.graph ?? null

  // Lay out only while visible, and retain a completed layout across tabs.
  useEffect(() => {
    if (!active) return
    if (!fetchedSubgraph || !combinedSubgraph) return
    if (fetchedSubgraph.requestKey !== currentRequestKey) return
    if (laidOutSubgraph.current === combinedSubgraph) return
    const owner = fetchedSubgraph
    const toLayout = combinedSubgraph
    const previousDisplay = displayedGraphRef.current
    const additive =
      previousDisplay?.designId === owner.designId &&
      previousDisplay.requestKey === owner.requestKey
    const previousLayout = additive ? previousDisplay.graph : undefined
    let cancelled = false
    const controller = new AbortController()
    setLoading(true)
    layoutSubgraph(toLayout, controller.signal, previousLayout)
      .then((g) => {
        if (cancelled) return
        const nextDisplay = {
          designId: owner.designId,
          requestKey: owner.requestKey,
          subgraph: toLayout,
          graph: g,
          relevantIds: combined?.relevantIds ?? owner.relevantIds,
          overlayIds: owner.overlayIds,
        }
        displayedGraphRef.current = nextDisplay
        setDisplayedGraph(nextDisplay)
        laidOutSubgraph.current = toLayout
        setLoading(false)
        if (!additive) setFitNonce((n) => n + 1)
      })
      .catch((e) => {
        if (cancelled || controller.signal.aborted) return
        setError(String(e instanceof Error ? e.message : e))
        laidOutSubgraph.current = null
        setLoading(false)
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [active, fetchedSubgraph, combined, combinedSubgraph, currentRequestKey])

  const sub = displayedGraph?.subgraph ?? null
  const laid = displayedGraph?.graph ?? null
  const displayedDesignCurrent = isDisplayedDesignCurrent(
    design?.design_id,
    displayedGraph?.designId,
  )
  const displayedDesignMismatch = Boolean(displayedGraph && !displayedDesignCurrent)
  const sourcePresentation = sourceProbePresentation(sourceStatus)
  const displayedRequestCurrent = isDisplayedRequestCurrent(
    currentRequestKey,
    fetchedSubgraph?.requestKey,
    displayedGraph?.requestKey,
  )
  const graphInteractive =
    analysisState === 'current' && displayedDesignCurrent && displayedRequestCurrent
  const relevantIds = useMemo(
    () =>
      new Set<number>(
        displayedRequestCurrent ? (displayedGraph?.relevantIds ?? []) : [],
      ),
    [displayedGraph?.relevantIds, displayedRequestCurrent],
  )
  const overlayIds = useMemo(() => {
    const ids = new Set<number>(
      displayedRequestCurrent ? (displayedGraph?.overlayIds ?? []) : [],
    )
    // A grouped bus node collapses per-bit ids the highlight set names, so it
    // must highlight when any of its members does (e.g. a path through a bus).
    for (const node of sub?.nodes ?? []) {
      if (node.members?.some((member) => ids.has(member))) ids.add(node.id)
    }
    return ids
  }, [displayedGraph?.overlayIds, displayedRequestCurrent, sub])
  const rootId =
    displayedRequestCurrent && coneReq?.kind === 'cone' ? coneReq.node : -1

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
      if (!designId || !graphInteractive || !displayedGraph?.requestKey) return
      setError(null)
      // Group projections expose a stable synthetic id. The grouped API
      // contract resolves that id server-side, avoiding unbounded query strings
      // and the public 200-root limit for wide vectors.
      const ids = [node.id]
      // Guard on the last-started request sequence (bumped when a new base
      // fetch begins), not the last-completed key — otherwise an expansion that
      // resolves while a new base cone is still in-flight would leak stale nodes
      // into it, and clearing expansion state at fetch start would not stop it.
      const owner = reqSeq.current
      const ownerKey = displayedGraph.requestKey
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
          // Drop stale results if a new base fetch started while fetching.
          if (
            controller.signal.aborted ||
            reqSeq.current !== owner ||
            currentRequestKey !== ownerKey ||
            loadedRequestKey.current !== ownerKey
          ) return
          // A depth-1 neighborhood is deliberately shallow, so its truncated
          // flag (hit the depth limit) is expected and must not mark the whole
          // view truncated — only the base cone and render cap do that.
          const clear = (g: Subgraph): Subgraph => ({ ...g, truncated: false })
          setExpansionState((prev) => {
            const acc = prev?.graph ?? { nodes: [], edges: [], truncated: false }
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
              graph: withFanout.graph,
              droppedNodes:
                (prev?.droppedNodes ?? 0) +
                withFanin.droppedNodes +
                withFanout.droppedNodes,
              droppedEdges:
                (prev?.droppedEdges ?? 0) +
                withFanin.droppedEdges +
                withFanout.droppedEdges,
            }
          })
        })
        .catch((e) => {
          if (
            controller.signal.aborted ||
            reqSeq.current !== owner ||
            currentRequestKey !== ownerKey ||
            loadedRequestKey.current !== ownerKey
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
      currentRequestKey,
      displayedGraph?.requestKey,
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
    displayedRequestCurrent && relevantIds.size > 0
      ? graphOptions.focus
        ? 'on'
        : 'off'
      : undefined

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
                ? 'Laying out cone…'
                : error
                  ? ''
                  : sub && sub.nodes.length === 0
                    ? 'Empty cone — nothing drives/loads this node within the limits.'
                    : 'No schematic.'}
            </div>
          </div>
        )}

        <div className="graph-banner">
          {loading && (
            <span className="msg" style={{ background: 'var(--bg-2)', borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}>
              <span className="spinner" /> loading…
            </span>
          )}
          {error && <span className="msg err">{error}</span>}
          {analysisState === 'stale' && (
            <span className="msg">source changed — synthesize to refresh mapping</span>
          )}
          {analysisState === 'refreshing' && (
            <span className="msg">refreshing analysis… showing the last valid schematic</span>
          )}
          {analysisState === 'error' && (
            <span className="msg err">analysis is stale; the last synthesis failed</span>
          )}
          {displayedDesignMismatch && (
            <span className="msg">
              showing a schematic snapshot from the previous synthesis — interactions are disabled
            </span>
          )}
          {requestDesignMismatch && !displayedDesignMismatch && (
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
              : 'Show nearby context dimmed around the relevant logic'
            : 'Focus applies to source selections and cones'
        }
      >
        <input
          type="checkbox"
          checked={graphOptions.focus}
          disabled={!focusAvailable}
          onChange={(event) => setOpt({ focus: event.target.checked })}
        />
        Focus
      </label>
    </div>
  )
}
