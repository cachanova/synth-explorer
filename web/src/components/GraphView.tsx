import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { LaidOutGraph, LaidOutNode, Point } from '../lib/layout'
import { nodeLabel, nodeSublabel, shortNetName } from '../lib/prettyType'
import {
  arithGlyph,
  boxBadge,
  bubbleAt,
  controlLabel,
  controlsFor,
  inputArcPath,
  inputBubbleAt,
  registerClockPath,
  shapePath,
  symbolKind,
  type ControlNetRef,
  type PortDirection,
  type SymbolKind,
} from '../lib/symbols'
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
  /** Opens a dedicated control cone when the parent supports that workflow. */
  onControlSelect?: (control: ControlNetRef, node: GraphNode) => void
  active: boolean
  fitNonce: number
}

interface NodePins {
  incoming: string[]
  outgoing: string[]
}

interface MutableNodePins {
  incoming: Set<string>
  outgoing: Set<string>
}

interface NodeVisual {
  fill: string
  stroke: string
  dashed: boolean
  isRoot: boolean
}

interface PanState {
  x: number
  y: number
  tx: number
  ty: number
  moved: boolean
}

function nodeVisual(
  node: GraphNode,
  kind: SymbolKind,
  rootId: number,
  highlighted: boolean,
): NodeVisual {
  const isRoot = node.id === rootId || Boolean(node.is_root)
  let fill = 'var(--bg-2)'
  let stroke = 'var(--border-strong)'

  if (kind === 'port-in' || kind === 'port-out') {
    fill = 'rgba(63,185,80,0.14)'
    stroke = 'var(--green)'
  } else if (kind === 'const') {
    fill = 'var(--bg-1)'
    stroke = 'var(--border)'
  } else if (kind === 'reg') {
    fill = 'rgba(210,168,255,0.08)'
    stroke = 'var(--seq)'
  } else if (kind === 'memory') {
    fill = 'rgba(210,153,34,0.08)'
    stroke = 'var(--amber)'
  }

  if (isRoot) {
    fill = 'rgba(88,166,255,0.16)'
    stroke = 'var(--accent)'
  }
  if (highlighted) stroke = 'var(--accent)'

  return {
    fill,
    stroke,
    dashed: Boolean(node.is_boundary) && !isRoot,
    isRoot,
  }
}

function pathD(points: Point[]): string {
  if (points.length === 0) return ''
  let d = `M ${points[0].x} ${points[0].y}`
  for (let i = 1; i < points.length; i++) d += ` L ${points[i].x} ${points[i].y}`
  return d
}

function compactPins(pins: string[], max = 6): string[] {
  if (pins.length <= max) return pins
  return [...pins.slice(0, max - 1), `+${pins.length - max + 1}`]
}

function SchematicOutline({
  node,
  kind,
  width,
  height,
  visual,
  strokeWidth,
}: {
  node: GraphNode
  kind: SymbolKind
  width: number
  height: number
  visual: NodeVisual
  strokeWidth: number
}) {
  const path = shapePath(kind, width, height)
  const bubble = bubbleAt(kind, width, height)
  const inputBubble = inputBubbleAt(node, width, height)
  const inputArc = inputArcPath(kind, height)
  const rx = kind === 'const' ? 14 : kind === 'lut' || kind === 'arith' ? 4 : 2
  const common = {
    fill: visual.fill,
    stroke: visual.stroke,
    strokeWidth,
    strokeDasharray: visual.dashed ? '5 3' : undefined,
    vectorEffect: 'non-scaling-stroke' as const,
  }

  return (
    <>
      {path ? (
        <path className="g-symbol-outline" d={path} {...common} />
      ) : (
        <rect
          className="g-symbol-outline"
          width={width}
          height={height}
          rx={rx}
          {...common}
        />
      )}

      {bubble && (
        <circle
          className="g-symbol-outline"
          cx={bubble.cx}
          cy={bubble.cy}
          r={bubble.r}
          {...common}
        />
      )}
      {inputBubble && (
        <circle
          className="g-symbol-outline"
          cx={inputBubble.cx}
          cy={inputBubble.cy}
          r={inputBubble.r}
          {...common}
        />
      )}
      {inputArc && (
        <path
          className="g-symbol-detail"
          d={inputArc}
          fill="none"
          stroke={visual.stroke}
          strokeWidth={strokeWidth}
          vectorEffect="non-scaling-stroke"
        />
      )}

      {kind === 'reg' && (
        <path
          className="g-symbol-detail"
          d={registerClockPath(Math.min(height, 58))}
          fill="none"
          stroke={visual.stroke}
          strokeWidth={strokeWidth}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {kind === 'lut' && (
        <path
          className="g-symbol-detail g-lut-detail"
          d={`M 8 8 V ${height - 8} M ${width - 8} 8 V ${height - 8}`}
          fill="none"
          stroke={visual.stroke}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {kind === 'memory' && (
        <path
          className="g-symbol-detail"
          d={`M 7 0 V ${height} M ${width - 7} 0 V ${height}`}
          fill="none"
          stroke={visual.stroke}
          vectorEffect="non-scaling-stroke"
        />
      )}
    </>
  )
}

function NodeContents({
  node,
  kind,
  width,
  height,
  name,
}: {
  node: GraphNode
  kind: SymbolKind
  width: number
  height: number
  name: string | null
}) {
  const label = nodeLabel(node)
  const maxChars = Math.max(4, Math.floor(width / 6.2))
  const primaryHeight = kind === 'reg' ? Math.min(height, 58) : height

  if (kind === 'arith') {
    return (
      <>
        <text className="g-operator-glyph" x={width / 2} y={primaryHeight / 2 + 7} textAnchor="middle">
          {arithGlyph(node.cell_type) ?? label}
        </text>
        {name && (
          <text className="g-node-name" x={width / 2} y={height - 6} textAnchor="middle">
            {truncate(name, maxChars)}
          </text>
        )}
      </>
    )
  }

  const isBox = kind === 'box' || kind === 'memory'
  const showName = name && name !== label
  const labelY = isBox
    ? showName
      ? primaryHeight / 2
      : primaryHeight / 2 + 5
    : showName
      ? primaryHeight / 2 - 3
      : primaryHeight / 2 + 4

  return (
    <>
      {isBox && (
        <text className="g-boundary-badge" x={width / 2} y={11} textAnchor="middle">
          {boxBadge(node)}
        </text>
      )}
      <text className="g-node-label" x={width / 2} y={labelY} textAnchor="middle">
        {truncate(label, maxChars)}
      </text>
      {showName && (
        <text className="g-node-name" x={width / 2} y={labelY + 13} textAnchor="middle">
          {truncate(name, maxChars)}
        </text>
      )}
    </>
  )
}

function PinLabels({ pins, width, height }: { pins: NodePins; width: number; height: number }) {
  const incoming = compactPins(pins.incoming)
  const outgoing = compactPins(pins.outgoing)
  return (
    <g className="g-pin-labels" aria-hidden="true">
      {incoming.map((pin, index) => {
        const y = ((index + 1) * height) / (incoming.length + 1)
        return (
          <g key={`in-${pin}`}>
            <line x1={0} x2={6} y1={y} y2={y} />
            <text x={8} y={y + 3}>{truncate(pin, 10)}</text>
          </g>
        )
      })}
      {outgoing.map((pin, index) => {
        const y = ((index + 1) * height) / (outgoing.length + 1)
        return (
          <g key={`out-${pin}`}>
            <line x1={width - 6} x2={width} y1={y} y2={y} />
            <text x={width - 8} y={y + 3} textAnchor="end">
              {truncate(pin, 10)}
            </text>
          </g>
        )
      })}
    </g>
  )
}

function ControlLabels({
  node,
  width,
  onSelect,
}: {
  node: GraphNode
  width: number
  onSelect?: (control: ControlNetRef, node: GraphNode) => void
}) {
  const controls = controlsFor(node)
  if (controls.length === 0) return null

  return (
    <g className="g-control-labels">
      {controls.map((control, index) => {
        const y = 59 + index * 13
        const caption = `${control.generated ? '⚠ ' : ''}${controlLabel(control)}`
        const details = [
          `${control.role}${control.pin ? ` pin ${control.pin}` : ''}: ${shortNetName(control.net_name)}`,
          control.active_low === true
            ? 'active-low'
            : control.active_low === false
              ? 'active-high'
              : null,
          control.synchronous === true
            ? 'synchronous'
            : control.synchronous === false
              ? 'asynchronous'
              : null,
          control.fanout != null ? `fanout ${control.fanout}` : null,
          control.generated ? 'generated or gated' : null,
          control.src ? `source ${control.src}` : null,
        ].filter(Boolean).join(' · ')
        return (
          <g
            key={`${control.role}-${control.driver_id}-${index}`}
            className={`g-control-label${control.generated ? ' generated' : ''}${onSelect ? ' clickable' : ''}`}
            role={onSelect ? 'button' : undefined}
            tabIndex={onSelect ? 0 : undefined}
            onPointerDown={onSelect ? (event) => event.stopPropagation() : undefined}
            onClick={onSelect ? (event) => {
              event.stopPropagation()
              onSelect(control, node)
            } : undefined}
            onKeyDown={onSelect ? (event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              event.stopPropagation()
              onSelect(control, node)
            } : undefined}
          >
            <title>
              {details}
            </title>
            <rect x={8} y={y} width={Math.max(0, width - 16)} height={11} rx={3} />
            <text x={width / 2} y={y + 8.5} textAnchor="middle">
              {truncate(caption, Math.max(5, Math.floor((width - 20) / 5.8)))}
            </text>
          </g>
        )
      })}
    </g>
  )
}

export function GraphView({
  graph,
  rootId,
  highlight,
  selectedId,
  onSelect,
  onControlSelect,
  active,
  fitNonce,
}: Props) {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, k: 1 })
  const [panning, setPanning] = useState(false)
  const [hoveredId, setHoveredId] = useState<number | null>(null)
  const [stageSize, setStageSize] = useState<{ width: number; height: number } | null>(null)
  const panState = useRef<PanState | null>(null)
  const suppressClick = useRef(false)
  const userAdjusted = useRef(false)

  const metadata = useMemo(() => {
    const nodeById = new Map<number, LaidOutNode>()
    const drivingNet = new Map<number, string>()
    const pinSetsById = new Map<number, MutableNodePins>()
    const hasIncoming = new Set<number>()
    const hasOutgoing = new Set<number>()

    for (const laidOutNode of graph.nodes) {
      nodeById.set(laidOutNode.id, laidOutNode)
      pinSetsById.set(laidOutNode.id, { incoming: new Set(), outgoing: new Set() })
    }
    for (const edge of graph.edges) {
      hasOutgoing.add(edge.from)
      hasIncoming.add(edge.to)
      if (!drivingNet.has(edge.from) && edge.edge.net_name) {
        drivingNet.set(edge.from, edge.edge.net_name)
      }
      const fromPins = pinSetsById.get(edge.from)
      const toPins = pinSetsById.get(edge.to)
      if (fromPins && edge.edge.from_port) fromPins.outgoing.add(edge.edge.from_port)
      if (toPins && edge.edge.to_port) toPins.incoming.add(edge.edge.to_port)
    }

    const portDirection = new Map<number, PortDirection>()
    for (const laidOutNode of graph.nodes) {
      if (laidOutNode.node.kind !== 'port') continue
      portDirection.set(
        laidOutNode.id,
        hasOutgoing.has(laidOutNode.id) && !hasIncoming.has(laidOutNode.id)
          ? 'input'
          : 'output',
      )
    }
    const pinsById = new Map<number, NodePins>()
    for (const [nodeId, pins] of pinSetsById) {
      pinsById.set(nodeId, {
        incoming: [...pins.incoming],
        outgoing: [...pins.outgoing],
      })
    }
    return { nodeById, drivingNet, pinsById, portDirection }
  }, [graph])

  const fit = useCallback(() => {
    const stage = stageRef.current
    if (!stage || graph.nodes.length === 0) return
    const rect = stage.getBoundingClientRect()
    const pad = 40
    const width = graph.width || 1
    const height = graph.height || 1
    const scale = Math.min((rect.width - pad) / width, (rect.height - pad) / height, 1.5)
    const safeScale = scale > 0 && Number.isFinite(scale) ? scale : 1
    setTransform({
      x: (rect.width - width * safeScale) / 2,
      y: (rect.height - height * safeScale) / 2,
      k: safeScale,
    })
  }, [graph])

  useLayoutEffect(() => {
    userAdjusted.current = false
    fit()
  }, [fit, fitNonce])

  useEffect(() => {
    if (!active) return
    const stage = stageRef.current
    if (!stage) return

    const updateSize = () => {
      const next = { width: stage.clientWidth, height: stage.clientHeight }
      setStageSize((previous) =>
        previous?.width === next.width && previous.height === next.height ? previous : next,
      )
      if (!userAdjusted.current) fit()
    }

    if (typeof ResizeObserver === 'undefined') {
      updateSize()
      window.addEventListener('resize', updateSize)
      return () => window.removeEventListener('resize', updateSize)
    }

    const observer = new ResizeObserver(updateSize)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [active, fit])

  const onWheel = useCallback((event: React.WheelEvent) => {
    event.preventDefault()
    const stage = stageRef.current
    if (!stage) return
    const rect = stage.getBoundingClientRect()
    const mouseX = event.clientX - rect.left
    const mouseY = event.clientY - rect.top
    userAdjusted.current = true
    setTransform((previous) => {
      const factor = Math.exp(-event.deltaY * 0.0016)
      const scale = Math.min(Math.max(previous.k * factor, 0.08), 4)
      const ratio = scale / previous.k
      return {
        k: scale,
        x: mouseX - (mouseX - previous.x) * ratio,
        y: mouseY - (mouseY - previous.y) * ratio,
      }
    })
  }, [])

  const onPointerDown = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      if (event.button !== 0) return
      event.currentTarget.setPointerCapture?.(event.pointerId)
      panState.current = {
        x: event.clientX,
        y: event.clientY,
        tx: transform.x,
        ty: transform.y,
        moved: false,
      }
      setPanning(true)
    },
    [transform],
  )

  const onPointerMove = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    const pan = panState.current
    if (!pan) return
    const dx = event.clientX - pan.x
    const dy = event.clientY - pan.y
    if (!pan.moved && Math.hypot(dx, dy) >= 2) {
      pan.moved = true
      userAdjusted.current = true
    }
    if (pan.moved) {
      setTransform((previous) => ({ ...previous, x: pan.tx + dx, y: pan.ty + dy }))
    }
  }, [])

  const finishPan = useCallback(() => {
    const moved = Boolean(panState.current?.moved)
    suppressClick.current = moved
    if (moved) {
      window.setTimeout(() => {
        suppressClick.current = false
      }, 0)
    }
    panState.current = null
    setPanning(false)
  }, [])

  const cancelPan = useCallback(() => {
    suppressClick.current = false
    panState.current = null
    setPanning(false)
  }, [])

  const zoomBy = (factor: number) => {
    userAdjusted.current = true
    setTransform((previous) => {
      const rect = stageRef.current?.getBoundingClientRect()
      const centerX = rect ? rect.width / 2 : 0
      const centerY = rect ? rect.height / 2 : 0
      const scale = Math.min(Math.max(previous.k * factor, 0.08), 4)
      const ratio = scale / previous.k
      return {
        k: scale,
        x: centerX - (centerX - previous.x) * ratio,
        y: centerY - (centerY - previous.y) * ratio,
      }
    })
  }

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const preventNativeScroll = (event: WheelEvent) => event.preventDefault()
    stage.addEventListener('wheel', preventNativeScroll, { passive: false })
    return () => stage.removeEventListener('wheel', preventNativeScroll)
  }, [])

  return (
    <div className="graph-stage" ref={stageRef}>
      <svg
        className={panning ? 'panning' : ''}
        width={stageSize?.width ?? '100%'}
        height={stageSize?.height ?? '100%'}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishPan}
        onPointerCancel={cancelPan}
        onClick={(event) => {
          if (suppressClick.current) {
            suppressClick.current = false
            return
          }
          if (event.target === event.currentTarget) onSelect(null)
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

        <g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
          {graph.edges.map((laidOutEdge, index) => {
            const highlighted = highlight.has(laidOutEdge.from) && highlight.has(laidOutEdge.to)
            let points = laidOutEdge.points
            if (points.length < 2) {
              const from = metadata.nodeById.get(laidOutEdge.from)
              const to = metadata.nodeById.get(laidOutEdge.to)
              if (from && to) {
                points = [
                  { x: from.x + from.width, y: from.y + from.height / 2 },
                  { x: to.x, y: to.y + to.height / 2 },
                ]
              }
            }
            const className = `g-edge${laidOutEdge.edge.control ? ' control' : ''}${highlighted ? ' hl' : ''}`
            return (
              <path
                key={index}
                className={className}
                d={pathD(points)}
                markerEnd={`url(#${highlighted ? 'arrow-hl' : 'arrow'})`}
              >
                <title>
                  {shortNetName(laidOutEdge.edge.net_name)} ({laidOutEdge.edge.bits.length} bit
                  {laidOutEdge.edge.bits.length === 1 ? '' : 's'}): {laidOutEdge.edge.from_port}→
                  {laidOutEdge.edge.to_port}
                </title>
              </path>
            )
          })}

          {graph.nodes.map((laidOutNode) => {
            const node = laidOutNode.node
            const portDirection = metadata.portDirection.get(node.id) ?? 'input'
            const kind = symbolKind(node, portDirection)
            const highlighted = highlight.has(node.id)
            const visual = nodeVisual(node, kind, rootId, highlighted)
            const selected = node.id === selectedId
            const hovered = node.id === hoveredId
            const name = nodeSublabel(node, metadata.drivingNet.get(node.id))
            const pins = metadata.pinsById.get(node.id) ?? { incoming: [], outgoing: [] }
            const strokeWidth = selected ? 2.4 : visual.isRoot || highlighted ? 1.8 : 1.2
            const showPins = (selected || hovered) && node.kind !== 'port'
            const title = name && name !== nodeLabel(node)
              ? `${nodeLabel(node)} — ${name}`
              : nodeLabel(node)

            return (
              <g
                key={node.id}
                transform={`translate(${laidOutNode.x},${laidOutNode.y})`}
                className={`g-node-body g-symbol-${kind}${selected ? ' selected' : ''}`}
                role="button"
                tabIndex={0}
                aria-label={title}
                onPointerEnter={() => setHoveredId(node.id)}
                onPointerLeave={() => setHoveredId((current) => current === node.id ? null : current)}
                onFocus={() => setHoveredId(node.id)}
                onBlur={() => setHoveredId((current) => current === node.id ? null : current)}
                onClick={(event) => {
                  event.stopPropagation()
                  if (suppressClick.current) {
                    suppressClick.current = false
                    return
                  }
                  onSelect(node)
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  onSelect(node)
                }}
              >
                <title>{title}</title>
                <SchematicOutline
                  node={node}
                  kind={kind}
                  width={laidOutNode.width}
                  height={laidOutNode.height}
                  visual={visual}
                  strokeWidth={strokeWidth}
                />
                <NodeContents
                  node={node}
                  kind={kind}
                  width={laidOutNode.width}
                  height={laidOutNode.height}
                  name={name}
                />
                {showPins && (
                  <PinLabels
                    pins={pins}
                    width={laidOutNode.width}
                    height={kind === 'reg' ? Math.min(laidOutNode.height, 58) : laidOutNode.height}
                  />
                )}
                {kind === 'reg' && (
                  <ControlLabels
                    node={node}
                    width={laidOutNode.width}
                    onSelect={onControlSelect}
                  />
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
        <button
          onClick={() => {
            userAdjusted.current = false
            fit()
          }}
          title="Fit to view"
        >
          ⤢
        </button>
      </div>
    </div>
  )
}

function truncate(value: string, maxLength: number): string {
  if (maxLength < 3 || value.length <= maxLength) return value
  return `${value.slice(0, maxLength - 1)}…`
}
