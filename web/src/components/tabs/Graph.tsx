import { useEffect, useMemo, useRef, useState } from 'react'
import { ApiRequestError, getCone, getLineCone, getNetlist } from '../../api'
import { MAX_GRAPH_RENDER_NODES } from '../../lib/graphLimits'
import { layoutSubgraph, type LaidOutGraph } from '../../lib/layout'
import { parseSrc } from '../../lib/src'
import { controlLabel } from '../../lib/symbols'
import { useStore } from '../../store'
import type { GraphNode, LineConeStatus, Subgraph } from '../../types'
import { GraphView } from '../GraphView'
import { NodeCard } from '../NodeCard'

export function Graph({ active }: { active: boolean }) {
  const store = useStore()
  const { analysisState, design, coneReq, graphOptions } = store

  const [sub, setSub] = useState<Subgraph | null>(null)
  const [laid, setLaid] = useState<LaidOutGraph | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<GraphNode | null>(null)
  const [sourceStatus, setSourceStatus] = useState<LineConeStatus | null>(null)
  const [sourceControl, setSourceControl] = useState(false)
  const [fitNonce, setFitNonce] = useState(0)
  const reqSeq = useRef(0)
  const loadedRequestKey = useRef<string | null>(null)
  const laidOutSubgraph = useRef<Subgraph | null>(null)

  const optsKey = `${graphOptions.maxDepth}|${graphOptions.maxNodes}|${graphOptions.hideControl}|${graphOptions.hideConst}|${graphOptions.showInfrastructure}`
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
      setSub(null)
      setLaid(null)
      loadedRequestKey.current = null
      laidOutSubgraph.current = null
      return
    }
    if (analysisState !== 'current') return
    if (requestDesignMismatch) return
    const requestKey = `${design.design_id}|${coneReq.nonce}|${optsKey}`
    if (loadedRequestKey.current === requestKey) return

    const myReq = ++reqSeq.current
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    setSourceStatus(null)
    setSourceControl(false)
    if (coneReq.kind !== 'source') setSelected(null)
    const fetchP =
      coneReq.kind === 'netlist'
        ? getNetlist(
            design.design_id,
            graphOptions.maxNodes,
            graphOptions.showInfrastructure,
            controller.signal,
          ).then((graph) => ({
            graph,
            status: null,
            control: false,
          }))
        : coneReq.kind === 'source'
          ? getLineCone(design.design_id, {
              file: coneReq.file,
              start_line: coneReq.startLine,
              end_line: coneReq.endLine,
              max_nodes: graphOptions.maxNodes,
              hide_control: graphOptions.hideControl,
              hide_const: graphOptions.hideConst,
              show_infrastructure: graphOptions.showInfrastructure,
            }, controller.signal).then((response) => ({
              graph: response.graph,
              status: response.status,
              control: response.control,
            }))
          : getCone(design.design_id, {
              node: coneReq.node,
              dir: coneReq.dir,
              max_depth: graphOptions.maxDepth,
              max_nodes: graphOptions.maxNodes,
              hide_control: graphOptions.hideControl,
              hide_const: graphOptions.hideConst,
              show_infrastructure: graphOptions.showInfrastructure,
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
        // An unmapped/absorbed selection is information about the source, not
        // a request to erase the user's last meaningful schematic.
        if (status == null || status === 'mapped') {
          setSub(graph)
          if (status === 'mapped') setSelected(null)
        }
        else setLoading(false)
      })
      .catch((e) => {
        if (controller.signal.aborted || myReq !== reqSeq.current) return
        setError(e instanceof ApiRequestError ? e.message : String(e))
        if (coneReq.kind !== 'source') {
          setSub(null)
          setLaid(null)
        }
        setLoading(false)
      })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, analysisState, design?.design_id, coneReq?.nonce, optsKey, requestDesignMismatch])

  // Lay out only while visible, and retain a completed layout across tabs.
  useEffect(() => {
    if (!active) return
    if (!sub) {
      setLaid(null)
      laidOutSubgraph.current = null
      return
    }
    if (laidOutSubgraph.current === sub) return
    let cancelled = false
    const controller = new AbortController()
    setLoading(true)
    layoutSubgraph(sub, controller.signal)
      .then((g) => {
        if (cancelled) return
        setLaid(g)
        laidOutSubgraph.current = sub
        setLoading(false)
        setFitNonce((n) => n + 1)
      })
      .catch((e) => {
        if (cancelled || controller.signal.aborted) return
        setError(String(e instanceof Error ? e.message : e))
        setLaid(null)
        laidOutSubgraph.current = null
        setLoading(false)
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [active, sub])

  const highlight = useMemo(
    () =>
      new Set([
        ...(coneReq?.highlight ?? []),
        ...(coneReq?.kind === 'source' && sourceStatus === 'mapped'
          ? (sub?.nodes.filter((node) => node.is_root).map((node) => node.id) ?? [])
          : []),
      ]),
    [coneReq, sourceStatus, sub],
  )
  const rootId = coneReq?.kind === 'cone' ? coneReq.node : -1

  // Net driven by the selected node (first outgoing edge) — lets the detail
  // card show a readable identity for hidden-name cells.
  const selectedNet = useMemo(() => {
    if (!sub || !selected) return null
    return sub.edges.find((e) => e.from === selected.id)?.net_name ?? null
  }, [sub, selected])

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
      <GraphToolbar />
      <div className="graph-stage-wrap" style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex' }}>
        {laid && laid.nodes.length > 0 ? (
          <GraphView
            graph={laid}
            rootId={rootId}
            highlight={highlight}
            selectedId={selected?.id ?? null}
            onSelect={(node) => {
              setSelected(node)
              if (analysisState === 'current' && !requestDesignMismatch) {
                store.highlightSources(parseSrc(node?.src))
              }
            }}
            onControlSelect={
              analysisState === 'current' && !requestDesignMismatch
                ? (control) =>
                    store.openControlCone({
                      node: control.driver_id,
                      label: controlLabel(control),
                      generated: control.generated,
                    })
                : undefined
            }
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
                    : 'No graph.'}
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
            <span className="msg">refreshing analysis… showing the last valid graph</span>
          )}
          {analysisState === 'error' && (
            <span className="msg err">analysis is stale; the last synthesis failed</span>
          )}
          {requestDesignMismatch && (
            <span className="msg">
              showing a cone from the previous synthesis — select a fresh endpoint or path
            </span>
          )}
          {sourceStatus === 'optimized_or_absorbed' && (
            <span className="msg">
              Logic for this selection was optimized away or absorbed during synthesis.
            </span>
          )}
          {sourceStatus === 'unmapped' && (
            <span className="msg">No synthesizable logic maps to this selection.</span>
          )}
          {coneReq.kind === 'source' && sourceStatus != null && sourceStatus !== 'mapped' && laid && (
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
              truncated — {sub.nodes.length} nodes shown (raise max-depth / max-nodes to
              see more, up to {MAX_GRAPH_RENDER_NODES})
            </span>
          )}
          {sub && !sub.truncated && (
            <span className="graph-count">{sub.nodes.length} nodes · {sub.edges.length} edges</span>
          )}
        </div>

        {selected && analysisState === 'current' && !requestDesignMismatch && (
          <NodeCard
            node={selected}
            drivingNet={selectedNet}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
    </div>
  )
}

function GraphToolbar() {
  const store = useStore()
  const { coneReq, design, graphOptions } = store
  const requestDesignMismatch = Boolean(
    design && coneReq?.kind === 'cone' && coneReq.designId !== design.design_id,
  )
  const setOpt = store.setGraphOptions

  const reissue = (dir: 'fanin' | 'fanout') => {
    if (coneReq?.kind !== 'cone') return
    store.openCone({ node: coneReq.node, dir, label: coneReq.label })
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
              disabled={requestDesignMismatch}
              onClick={() => reissue('fanin')}
            >
              fanin
            </button>
            <button
              className={coneReq.dir === 'fanout' ? 'primary' : ''}
              disabled={requestDesignMismatch}
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
