import { useEffect, useMemo, useRef, useState } from 'react'
import { ApiRequestError, getCone, getNetlist } from '../../api'
import { layoutSubgraph, MAX_LAYOUT_NODES, type LaidOutGraph } from '../../lib/layout'
import { useStore } from '../../store'
import type { GraphNode, Subgraph } from '../../types'
import { GraphView } from '../GraphView'
import { NodeCard } from '../NodeCard'

export function Graph() {
  const store = useStore()
  const { design, coneReq, graphOptions } = store

  const [sub, setSub] = useState<Subgraph | null>(null)
  const [laid, setLaid] = useState<LaidOutGraph | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<GraphNode | null>(null)
  const [fitNonce, setFitNonce] = useState(0)
  const reqSeq = useRef(0)

  const optsKey = `${graphOptions.maxDepth}|${graphOptions.maxNodes}|${graphOptions.hideControl}|${graphOptions.hideConst}`

  // fetch subgraph whenever the request or options change
  useEffect(() => {
    if (!design || !coneReq) {
      setSub(null)
      setLaid(null)
      return
    }
    const myReq = ++reqSeq.current
    setLoading(true)
    setError(null)
    setSelected(null)
    const fetchP = coneReq.netlist
      ? getNetlist(design.design_id, graphOptions.maxNodes)
      : getCone(design.design_id, {
          node: coneReq.node,
          dir: coneReq.dir,
          max_depth: graphOptions.maxDepth,
          max_nodes: graphOptions.maxNodes,
          hide_control: graphOptions.hideControl,
          hide_const: graphOptions.hideConst,
        })
    fetchP
      .then((s) => {
        if (myReq !== reqSeq.current) return
        setSub(s)
      })
      .catch((e) => {
        if (myReq !== reqSeq.current) return
        setError(e instanceof ApiRequestError ? e.message : String(e))
        setSub(null)
        setLaid(null)
        setLoading(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [design?.design_id, coneReq?.nonce, optsKey])

  // lay out whenever the subgraph changes
  useEffect(() => {
    if (!sub) {
      setLaid(null)
      return
    }
    let cancelled = false
    setLoading(true)
    layoutSubgraph(sub)
      .then((g) => {
        if (cancelled) return
        setLaid(g)
        setLoading(false)
        setFitNonce((n) => n + 1)
      })
      .catch((e) => {
        if (cancelled) return
        setError(String(e instanceof Error ? e.message : e))
        setLaid(null)
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [sub])

  const highlight = useMemo(
    () => new Set(coneReq?.highlight ?? []),
    [coneReq],
  )
  const rootId = coneReq?.netlist ? -1 : coneReq?.node ?? -1

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
            onSelect={setSelected}
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
          {sub?.truncated && (
            <span className="msg">
              truncated — {sub.nodes.length} nodes shown (raise max-depth / max-nodes to
              see more, up to {MAX_LAYOUT_NODES})
            </span>
          )}
          {sub && !sub.truncated && (
            <span className="graph-count">{sub.nodes.length} nodes · {sub.edges.length} edges</span>
          )}
        </div>

        {selected && <NodeCard node={selected} onClose={() => setSelected(null)} />}
      </div>
    </div>
  )
}

function GraphToolbar() {
  const store = useStore()
  const { coneReq, graphOptions } = store
  const setOpt = store.setGraphOptions

  const reissue = (dir: 'fanin' | 'fanout') => {
    if (!coneReq || coneReq.netlist) return
    store.openCone({ node: coneReq.node, dir, label: coneReq.label })
  }

  return (
    <div className="graph-toolbar">
      <span className="mono" style={{ color: 'var(--text-dim)', fontSize: 12 }}>
        {coneReq?.label}
      </span>
      <span className="sep" />

      {coneReq && !coneReq.netlist && (
        <>
          <div className="stepper" title="Cone direction">
            <button
              className={coneReq.dir === 'fanin' ? 'primary' : ''}
              onClick={() => reissue('fanin')}
            >
              fanin
            </button>
            <button
              className={coneReq.dir === 'fanout' ? 'primary' : ''}
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
              setOpt({ maxNodes: Math.min(2000, graphOptions.maxNodes + 100) })
            }
          >
            +
          </button>
        </div>
      </label>

      <span className="sep" />
      <button onClick={() => store.openNetlist()} title="Render the full (capped) netlist">
        Full netlist
      </button>
    </div>
  )
}
