import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiRequestError, getCone, getLineCone, getNetlist } from '../../api'
import { MAX_GRAPH_RENDER_NODES } from '../../lib/graphLimits'
import { mergeSubgraphs } from '../../lib/mergeSubgraph'
import { isDisplayedDesignCurrent } from '../../lib/graphOwnership'
import { layoutSubgraph, type LaidOutGraph } from '../../lib/layout'
import { designSrcSpans } from '../../lib/src'
import { sourceProbePresentation } from '../../lib/sourceProbe'
import { controlLabel } from '../../lib/symbols'
import { useStore } from '../../store'
import type { GraphNode, LineConeStatus, Subgraph } from '../../types'
import { GraphView } from '../GraphView'
import { NodeCard } from '../NodeCard'

interface FetchedSubgraph {
  designId: string
  requestKey: string
  graph: Subgraph
}

interface DisplayedGraph {
  designId: string
  requestKey: string
  subgraph: Subgraph
  graph: LaidOutGraph
}

export function Graph({ active }: { active: boolean }) {
  const store = useStore()
  const { analysisState, design, coneReq, graphOptions } = store

  const [fetchedSubgraph, setFetchedSubgraph] = useState<FetchedSubgraph | null>(null)
  // Neighborhoods accumulated from double-click expansions, merged on top of the
  // base subgraph before layout. Reset whenever a new base subgraph is fetched.
  const [expansionGraph, setExpansionGraph] = useState<Subgraph | null>(null)
  const [displayedGraph, setDisplayedGraph] = useState<DisplayedGraph | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<GraphNode | null>(null)
  const [sourceStatus, setSourceStatus] = useState<LineConeStatus | null>(null)
  const [sourceControl, setSourceControl] = useState(false)
  const [fitNonce, setFitNonce] = useState(0)
  const reqSeq = useRef(0)
  const loadedRequestKey = useRef<string | null>(null)
  const laidOutSubgraph = useRef<Subgraph | null>(null)

  // Every option here changes what the server returns, so a change refetches.
  const optsKey = `${graphOptions.maxDepth}|${graphOptions.maxNodes}|${graphOptions.hideControl}|${graphOptions.hideConst}|${graphOptions.showInfrastructure}|${graphOptions.groupVectors}`
  const requestDesignMismatch = Boolean(
    design && coneReq?.kind === 'cone' && coneReq.designId !== design.design_id,
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
    if (!design || !coneReq) {
      setFetchedSubgraph(null)
      setDisplayedGraph(null)
      loadedRequestKey.current = null
      laidOutSubgraph.current = null
      return
    }
    if (analysisState !== 'current') return
    if (requestDesignMismatch) return
    const requestDesignId = design.design_id
    const requestKey = `${requestDesignId}|${coneReq.nonce}|${optsKey}`
    if (loadedRequestKey.current === requestKey) return

    const myReq = ++reqSeq.current
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    setExpansionGraph(null)
    setSourceStatus(null)
    setSourceControl(false)
    if (coneReq.kind !== 'source') setSelected(null)
    const fetchP =
      coneReq.kind === 'netlist'
        ? getNetlist(
            requestDesignId,
            graphOptions.maxNodes,
            graphOptions.showInfrastructure,
            graphOptions.groupVectors,
            controller.signal,
          ).then((graph) => ({
            graph,
            status: null,
            control: false,
          }))
        : coneReq.kind === 'source'
          ? getLineCone(requestDesignId, {
              file: coneReq.file,
              start_line: coneReq.startLine,
              end_line: coneReq.endLine,
              max_nodes: graphOptions.maxNodes,
              hide_control: graphOptions.hideControl,
              hide_const: graphOptions.hideConst,
              show_infrastructure: graphOptions.showInfrastructure,
              group_vectors: graphOptions.groupVectors,
            }, controller.signal).then((response) => ({
              graph: response.graph,
              status: response.status,
              control: response.control,
            }))
          : getCone(requestDesignId, {
              node: coneReq.node,
              nodes: coneReq.nodes.length > 1 ? coneReq.nodes : undefined,
              dir: coneReq.dir,
              max_depth: graphOptions.maxDepth,
              max_nodes: graphOptions.maxNodes,
              hide_control: graphOptions.hideControl,
              hide_const: graphOptions.hideConst,
              show_infrastructure: graphOptions.showInfrastructure,
              group_vectors: graphOptions.groupVectors,
            }, controller.signal).then((graph) => ({
              graph,
              status: null,
              control: false,
            }))
    fetchP
      .then(({ graph, status, control }) => {
        if (controller.signal.aborted || myReq !== reqSeq.current) return
        loadedRequestKey.current = requestKey
        setSourceStatus(status)
        setSourceControl(control)
        const presentation = sourceProbePresentation(status)
        // A partial mapping is still useful and replaces the prior selection.
        if (presentation.acceptReturnedGraph) {
          setFetchedSubgraph({ designId: requestDesignId, requestKey, graph })
          if (status != null) setSelected(null)
        }
        // Nothing synthesizable maps to this selection — fall back to the full
        // netlist instead of a bare message, keeping a schematic on screen.
        else {
          setLoading(false)
          const reason =
            status === 'optimized_or_absorbed' ? 'optimized away' : 'no mapped logic'
          store.openNetlist(`${coneReq.label} — ${reason}; showing full netlist`)
        }
      })
      .catch((e) => {
        if (controller.signal.aborted || myReq !== reqSeq.current) return
        setError(e instanceof ApiRequestError ? e.message : String(e))
        setLoading(false)
      })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, analysisState, design?.design_id, coneReq?.nonce, optsKey, requestDesignMismatch])

  // The rendered subgraph is the fetched base with every double-click expansion
  // merged on top. Memoized so a tab switch does not rebuild it and force a
  // needless relayout.
  const combinedSubgraph = useMemo(() => {
    if (!fetchedSubgraph) return null
    return mergeSubgraphs(fetchedSubgraph.graph, expansionGraph, MAX_GRAPH_RENDER_NODES)
  }, [fetchedSubgraph, expansionGraph])

  // Lay out only while visible, and retain a completed layout across tabs.
  useEffect(() => {
    if (!active) return
    if (!fetchedSubgraph || !combinedSubgraph) return
    if (laidOutSubgraph.current === combinedSubgraph) return
    const owner = fetchedSubgraph
    const toLayout = combinedSubgraph
    let cancelled = false
    const controller = new AbortController()
    setLoading(true)
    layoutSubgraph(toLayout, controller.signal)
      .then((g) => {
        if (cancelled) return
        setDisplayedGraph({
          designId: owner.designId,
          requestKey: owner.requestKey,
          subgraph: toLayout,
          graph: g,
        })
        laidOutSubgraph.current = toLayout
        setLoading(false)
        setFitNonce((n) => n + 1)
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
  }, [active, fetchedSubgraph, combinedSubgraph])

  const sub = displayedGraph?.subgraph ?? null
  const laid = displayedGraph?.graph ?? null
  const displayedDesignCurrent = isDisplayedDesignCurrent(
    design?.design_id,
    displayedGraph?.designId,
  )
  const displayedDesignMismatch = Boolean(displayedGraph && !displayedDesignCurrent)
  const graphInteractive = analysisState === 'current' && displayedDesignCurrent
  const sourcePresentation = sourceProbePresentation(sourceStatus)

  const highlight = useMemo(() => {
    const ids = new Set<number>([
      ...(coneReq?.highlight ?? []),
      ...(coneReq?.kind === 'source' && sourcePresentation.highlightRoots
        ? (sub?.nodes.filter((node) => node.is_root).map((node) => node.id) ?? [])
        : []),
    ])
    // A grouped bus node collapses per-bit ids the highlight set names, so it
    // must highlight when any of its members does (e.g. a path through a bus).
    for (const node of sub?.nodes ?? []) {
      if (node.members?.some((member) => ids.has(member))) ids.add(node.id)
    }
    return ids
  }, [coneReq, sourcePresentation.highlightRoots, sub])
  const rootId = coneReq?.kind === 'cone' ? coneReq.node : -1

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
      if (!designId) return
      const ids = node.members ?? [node.id]
      // Guard on the last-started request sequence (bumped when a new base
      // fetch begins), not the last-completed key — otherwise an expansion that
      // resolves while a new base cone is still in-flight would leak stale nodes
      // into it, and setExpansionGraph(null) at fetch start would not clear them.
      const owner = reqSeq.current
      const shared = {
        node: ids[0],
        nodes: ids.length > 1 ? ids : undefined,
        max_depth: 1,
        max_nodes: graphOptions.maxNodes,
        hide_control: graphOptions.hideControl,
        hide_const: graphOptions.hideConst,
        show_infrastructure: graphOptions.showInfrastructure,
        group_vectors: graphOptions.groupVectors,
      }
      Promise.all([
        getCone(designId, { ...shared, dir: 'fanin' }),
        getCone(designId, { ...shared, dir: 'fanout' }),
      ])
        .then(([fanin, fanout]) => {
          // Drop stale results if a new base fetch started while fetching.
          if (reqSeq.current !== owner) return
          // A depth-1 neighborhood is deliberately shallow, so its truncated
          // flag (hit the depth limit) is expected and must not mark the whole
          // view truncated — only the base cone and render cap do that.
          const clear = (g: Subgraph): Subgraph => ({ ...g, truncated: false })
          setExpansionGraph((prev) => {
            const acc = prev ?? { nodes: [], edges: [], truncated: false }
            return mergeSubgraphs(
              mergeSubgraphs(acc, clear(fanin), MAX_GRAPH_RENDER_NODES),
              clear(fanout),
              MAX_GRAPH_RENDER_NODES,
            )
          })
        })
        .catch(() => {
          // Expansion is best-effort; a failed neighborhood fetch leaves the
          // current graph intact rather than surfacing an error.
        })
    },
    [designId, graphOptions],
  )

  if (!design) return <div className="empty-state">No design yet.</div>
  if (!coneReq)
    return (
      <div className="empty-state">
        Select a register, output, path, or fanout driver to render its cone here —
        or open the full netlist.
        <div style={{ marginTop: 14 }}>
          <button onClick={() => store.openNetlist()}>Open full netlist</button>
        </div>
      </div>
    )

  return (
    <div className="graph-tab">
      <GraphToolbar graphInteractive={graphInteractive} />
      <div className="graph-stage-wrap" style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex' }}>
        {laid && laid.nodes.length > 0 ? (
          <GraphView
            graph={laid}
            rootId={rootId}
            highlight={highlight}
            selectedId={graphInteractive ? (selected?.id ?? null) : null}
            interactive={graphInteractive}
            onSelect={(node) => {
              if (!graphInteractive) return
              setSelected(node)
              store.highlightSources(designSrcSpans(node?.src, store.files))
            }}
            onControlSelect={
              graphInteractive
                ? (control) =>
                    store.openControlCone({
                      node: control.driver_id,
                      label: controlLabel(control),
                      generated: control.generated,
                    })
                : undefined
            }
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
          {coneReq.kind === 'source' && sourcePresentation.retainsPreviousGraph && laid && (
            <span className="msg">showing the previous mapped selection</span>
          )}
          {sourceControl && (
            <span className="msg">
              control path selection — reset/clock/enable connectivity is shown
            </span>
          )}
          {coneReq.kind === 'source' && coneReq.selectionTruncated && (
            <span className="msg">selection capped at 200 source lines</span>
          )}
          {sub?.truncated && (
            <span className="msg">
              truncated — {sub.nodes.length} nodes and {sub.edges.length} edges shown;
              analysis limits omitted additional schematic content
            </span>
          )}
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
  const store = useStore()
  const { coneReq, design, graphOptions } = store
  const requestDesignMismatch = Boolean(
    design && coneReq?.kind === 'cone' && coneReq.designId !== design.design_id,
  )
  const setOpt = store.setGraphOptions

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
      <span className="mono" style={{ color: 'var(--text-dim)', fontSize: 12 }}>
        {coneReq?.label}
      </span>
      <span className="sep" />

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

      {(coneReq?.kind === 'cone' || coneReq?.kind === 'source') && (
        <>
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

      <label className="toggle" title="Show vendor IO and clock-buffer cells">
        <input
          type="checkbox"
          checked={graphOptions.showInfrastructure}
          onChange={(event) =>
            setOpt({ showInfrastructure: event.target.checked })
          }
        />
        infrastructure
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

      <span className="sep" />
      <label
        className="toggle"
        title="Automatically synthesize three seconds after input changes"
      >
        <input
          type="checkbox"
          checked={store.autoSynthesize}
          onChange={(event) => store.setAutoSynthesize(event.target.checked)}
        />
        auto synth
      </label>
      <button onClick={() => store.openNetlist()} title="Render the full (capped) netlist">
        Full netlist
      </button>
    </div>
  )
}
