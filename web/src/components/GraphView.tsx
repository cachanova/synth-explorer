import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { LaidOutGraph, LaidOutNode, Point } from '../lib/layout'
import { nodeLabel, nodeSublabel } from '../lib/prettyType'
import type { GraphNode } from '../types'

interface Transform {
  x: number
  y: number
  k: number
}

interface Props {
  graph: LaidOutGraph
  rootId: number
  highlight: Set<number>
  selectedId: number | null
  onSelect: (node: GraphNode | null) => void
  fitNonce: number
}

function nodeVisual(n: GraphNode, rootId: number, highlighted: boolean) {
  const isRoot = n.id === rootId || n.is_root
  let fill = 'var(--bg-2)'
  let stroke = 'var(--border-strong)'
  let dashed = false
  let rx = 6

  if (n.kind === 'port') {
    fill = 'rgba(63,185,80,0.14)'
    stroke = 'var(--green)'
    rx = 16
  } else if (n.kind === 'const') {
    fill = 'var(--bg-1)'
    stroke = 'var(--border)'
  } else if (n.seq) {
    stroke = 'var(--seq)'
  }
  if (n.is_boundary && !isRoot) dashed = true
  if (isRoot) {
    fill = 'rgba(88,166,255,0.16)'
    stroke = 'var(--accent)'
  }
  if (highlighted) {
    stroke = 'var(--accent)'
  }
  return { fill, stroke, dashed, rx, isRoot }
}

function pathD(points: Point[]): string {
  if (points.length === 0) return ''
  let d = `M ${points[0].x} ${points[0].y}`
  for (let i = 1; i < points.length; i++) d += ` L ${points[i].x} ${points[i].y}`
  return d
}

export function GraphView({
  graph,
  rootId,
  highlight,
  selectedId,
  onSelect,
  fitNonce,
}: Props) {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [t, setT] = useState<Transform>({ x: 0, y: 0, k: 1 })
  const [panning, setPanning] = useState(false)
  const panState = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)

  const nodeById = useMemo(() => {
    const m = new Map<number, LaidOutNode>()
    for (const n of graph.nodes) m.set(n.id, n)
    return m
  }, [graph])

  // Driving net per node (first outgoing edge) — used to give hidden-name
  // cells a readable sublabel like "new_n27".
  const drivingNet = useMemo(() => {
    const m = new Map<number, string>()
    for (const e of graph.edges) {
      if (!m.has(e.from) && e.edge.net_name) m.set(e.from, e.edge.net_name)
    }
    return m
  }, [graph])

  const fit = useCallback(() => {
    const stage = stageRef.current
    if (!stage || graph.nodes.length === 0) return
    const rect = stage.getBoundingClientRect()
    const pad = 40
    const w = graph.width || 1
    const h = graph.height || 1
    const k = Math.min((rect.width - pad) / w, (rect.height - pad) / h, 1.5)
    const kk = k > 0 && Number.isFinite(k) ? k : 1
    const x = (rect.width - w * kk) / 2
    const y = (rect.height - h * kk) / 2
    setT({ x, y, k: kk })
  }, [graph])

  useLayoutEffect(() => {
    fit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, fitNonce])

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const stage = stageRef.current
    if (!stage) return
    const rect = stage.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    setT((prev) => {
      const factor = Math.exp(-e.deltaY * 0.0016)
      const k = Math.min(Math.max(prev.k * factor, 0.08), 4)
      const scale = k / prev.k
      return {
        k,
        x: mx - (mx - prev.x) * scale,
        y: my - (my - prev.y) * scale,
      }
    })
  }, [])

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return
      ;(e.target as Element).setPointerCapture?.(e.pointerId)
      panState.current = { x: e.clientX, y: e.clientY, tx: t.x, ty: t.y }
      setPanning(true)
    },
    [t],
  )
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const p = panState.current
    if (!p) return
    setT((prev) => ({ ...prev, x: p.tx + (e.clientX - p.x), y: p.ty + (e.clientY - p.y) }))
  }, [])
  const onPointerUp = useCallback(() => {
    panState.current = null
    setPanning(false)
  }, [])

  const zoomBy = (factor: number) =>
    setT((prev) => {
      const stage = stageRef.current
      const rect = stage?.getBoundingClientRect()
      const cx = rect ? rect.width / 2 : 0
      const cy = rect ? rect.height / 2 : 0
      const k = Math.min(Math.max(prev.k * factor, 0.08), 4)
      const scale = k / prev.k
      return { k, x: cx - (cx - prev.x) * scale, y: cy - (cy - prev.y) * scale }
    })

  // prevent native wheel scroll
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const handler = (e: WheelEvent) => e.preventDefault()
    stage.addEventListener('wheel', handler, { passive: false })
    return () => stage.removeEventListener('wheel', handler)
  }, [])

  return (
    <div className="graph-stage" ref={stageRef}>
      <svg
        className={panning ? 'panning' : ''}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onClick={(e) => {
          if (e.target === e.currentTarget) onSelect(null)
        }}
      >
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--border-strong)" />
          </marker>
          <marker
            id="arrow-hl"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
          </marker>
        </defs>
        <g transform={`translate(${t.x},${t.y}) scale(${t.k})`}>
          {graph.edges.map((e, i) => {
            const hl = highlight.has(e.from) && highlight.has(e.to)
            let pts = e.points
            if (pts.length < 2) {
              const a = nodeById.get(e.from)
              const b = nodeById.get(e.to)
              if (a && b) {
                pts = [
                  { x: a.x + a.width, y: a.y + a.height / 2 },
                  { x: b.x, y: b.y + b.height / 2 },
                ]
              }
            }
            const cls = `g-edge${e.edge.control ? ' control' : ''}${hl ? ' hl' : ''}`
            return (
              <path
                key={i}
                className={cls}
                d={pathD(pts)}
                markerEnd={`url(#${hl ? 'arrow-hl' : 'arrow'})`}
              >
                <title>
                  {e.edge.net_name} ({e.edge.bits.length} bit
                  {e.edge.bits.length === 1 ? '' : 's'}): {e.edge.from_port}→
                  {e.edge.to_port}
                </title>
              </path>
            )
          })}
          {graph.nodes.map((ln) => {
            const n = ln.node
            const highlighted = highlight.has(n.id)
            const v = nodeVisual(n, rootId, highlighted)
            const selected = n.id === selectedId
            const label = nodeLabel(n)
            const sub = nodeSublabel(n, drivingNet.get(n.id))
            const showName = sub && sub !== label ? sub : null
            return (
              <g
                key={n.id}
                transform={`translate(${ln.x},${ln.y})`}
                className="g-node-body"
                onClick={(ev) => {
                  ev.stopPropagation()
                  onSelect(n)
                }}
              >
                <rect
                  width={ln.width}
                  height={ln.height}
                  rx={v.rx}
                  fill={v.fill}
                  stroke={v.stroke}
                  strokeWidth={selected ? 2.4 : v.isRoot || highlighted ? 1.8 : 1.2}
                  strokeDasharray={v.dashed ? '5 3' : undefined}
                />
                <text
                  className="g-node-label"
                  x={ln.width / 2}
                  y={showName ? ln.height / 2 - 3 : ln.height / 2 + 4}
                  textAnchor="middle"
                >
                  {label}
                </text>
                {showName && (
                  <text
                    className="g-node-name"
                    x={ln.width / 2}
                    y={ln.height / 2 + 11}
                    textAnchor="middle"
                  >
                    {truncate(showName, Math.floor(ln.width / 6))}
                  </text>
                )}
              </g>
            )
          })}
        </g>
      </svg>

      <div className="zoom-controls">
        <button onClick={() => zoomBy(1.25)} title="Zoom in">
          +
        </button>
        <button onClick={() => zoomBy(0.8)} title="Zoom out">
          −
        </button>
        <button onClick={fit} title="Fit to view">
          ⤢
        </button>
      </div>
    </div>
  )
}

function truncate(s: string, n: number): string {
  if (n < 3 || s.length <= n) return s
  return s.slice(0, n - 1) + '…'
}
