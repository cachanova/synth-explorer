import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  fitViewportToContent,
  panViewport,
  REG_DATA_IN_Y_FRAC,
  REG_DATA_OUT_Y_FRAC,
  viewportTransformAttribute,
  zoomViewportAt,
  type LaidOutGraph,
  type LaidOutNode,
  type Point,
  type ViewportTransform,
} from '../lib/layout'
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

interface Props {
  graph: LaidOutGraph
  rootId: number
  highlight: Set<number>
  selectedId: number | null
  interactive: boolean
  onSelect: (node: GraphNode | null) => void
  /** Opens a dedicated control cone when the parent supports that workflow. */
  onControlSelect?: (control: ControlNetRef, node: GraphNode) => void
  /** Double-click a node to additively render its fanin/fanout connections. */
  onExpand?: (node: GraphNode) => void
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
  pointerId: number
  x: number
  y: number
  transform: ViewportTransform
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
  } else if (kind === 'reg' || kind === 'latch') {
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

  // A grouped (width>=2) node is a vector, so draw offset silhouettes behind it
  // — a stack-of-sheets cue that a bus of cells collapsed into one symbol.
  const groupWidth = node.width ?? 0
  const stackOffsets = groupWidth >= 2 ? (groupWidth >= 4 ? [7, 3.5] : [4]) : []
  const ghostProps = {
    fill: visual.fill,
    stroke: visual.stroke,
    strokeWidth,
    vectorEffect: 'non-scaling-stroke' as const,
  }

  return (
    <>
      {stackOffsets.map((d) => (
        <g
          key={`stack-${d}`}
          className="g-symbol-stack"
          transform={`translate(${d},${-d})`}
          aria-hidden="true"
        >
          {path ? (
            <path d={path} {...ghostProps} />
          ) : (
            <rect width={width} height={height} rx={rx} {...ghostProps} />
          )}
        </g>
      ))}
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

  const groupWidth = node.width ?? 0
  const groupBadge =
    groupWidth >= 2 ? (
      <text className="g-group-badge" x={width - 4} y={11} textAnchor="end">
        ×{groupWidth}
      </text>
    ) : null

  if (kind === 'arith') {
    return (
      <>
        {groupBadge}
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

  // A flip-flop/latch keeps its primitive glyph centered and shows the register
  // signal name across the top, clear of the side D/Q/R pins and the clock notch.
  if (kind === 'reg' || kind === 'latch') {
    return (
      <>
        {groupBadge}
        {name && (
          <text className="g-node-name g-reg-name" x={width / 2} y={12} textAnchor="middle">
            {truncate(name, maxChars)}
          </text>
        )}
        <text className="g-node-label" x={width / 2} y={primaryHeight / 2 + 4} textAnchor="middle">
          {truncate(label, maxChars)}
        </text>
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
      {groupBadge}
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

/** Short pin letter for a flip-flop control, per primitive: R/S/E/EN. */
function controlPinLetter(role: ControlNetRef['role']): string | null {
  switch (role) {
    case 'reset':
      return 'R'
    case 'set':
      return 'S'
    case 'enable':
      return 'EN'
    default:
      return null
  }
}

// Every flip-flop / latch draws the same recognizable pins: D data-in (upper
// west), the clock triangle (lower west), Q data-out (east), and a letter per
// remaining control (R/S/EN) so an FDRE shows its enable while a plain DFF
// shows its reset. The data edges are routed to the D and Q ports in layout.ts,
// so the arrows land on these pins and never on the clock notch.
function RegisterPins({
  node,
  width,
  bodyHeight,
}: {
  node: GraphNode
  width: number
  bodyHeight: number
}) {
  const dInY = bodyHeight * REG_DATA_IN_Y_FRAC
  const qY = bodyHeight * REG_DATA_OUT_Y_FRAC
  const controlLetters = controlsFor(node)
    .map((control) => controlPinLetter(control.role))
    .filter((letter): letter is string => letter !== null)
  return (
    <g className="g-reg-pins" aria-hidden="true">
      <line className="g-reg-pin-tick" x1={0} x2={7} y1={dInY} y2={dInY} />
      <text className="g-reg-pin" x={9} y={dInY + 3}>
        D
      </text>
      <line className="g-reg-pin-tick" x1={width - 7} x2={width} y1={qY} y2={qY} />
      <text className="g-reg-pin" x={width - 9} y={qY + 3} textAnchor="end">
        Q
      </text>
      {controlLetters.map((letter, index) => (
        <text
          className="g-reg-pin g-reg-ctrl-pin"
          key={letter}
          x={9}
          y={bodyHeight * 0.5 + 3 + index * 11}
        >
          {letter}
        </text>
      ))}
    </g>
  )
}

function ControlLabels({
  node,
  width,
  startY,
  onSelect,
}: {
  node: GraphNode
  width: number
  startY: number
  onSelect?: (control: ControlNetRef, node: GraphNode) => void
}) {
  const controls = controlsFor(node)
  if (controls.length === 0) return null

  return (
    <g className="g-control-labels">
      {controls.map((control, index) => {
        const y = startY + 1 + index * 13
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

interface SchematicNodeProps {
  laidOutNode: LaidOutNode
  rootId: number
  highlighted: boolean
  selected: boolean
  portDirection: PortDirection
  drivingNet?: string
  pins: NodePins
  interactive: boolean
  suppressClick: { current: boolean }
  onSelect: (node: GraphNode | null) => void
  onControlSelect?: (control: ControlNetRef, node: GraphNode) => void
  onExpand?: (node: GraphNode) => void
}

// Hover state belongs to one node, so revealing pin labels never reconciles
// the parent GraphView's thousands of nodes and edges.
const SchematicNode = memo(function SchematicNode({
  laidOutNode,
  rootId,
  highlighted,
  selected,
  portDirection,
  drivingNet,
  pins,
  interactive,
  suppressClick,
  onSelect,
  onControlSelect,
  onExpand,
}: SchematicNodeProps) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const node = laidOutNode.node
  const kind = symbolKind(node, portDirection)
  const visual = nodeVisual(node, kind, rootId, highlighted)
  const name = nodeSublabel(node, drivingNet)
  const controls = controlsFor(node)
  const bodyHeight = Math.max(1, laidOutNode.height - controls.length * 13)
  const strokeWidth = selected ? 2.4 : visual.isRoot || highlighted ? 1.8 : 1.2
  const showPins = (selected || hovered || focused) && node.kind !== 'port'
  const title = name && name !== nodeLabel(node)
    ? `${nodeLabel(node)} — ${name}`
    : nodeLabel(node)

  return (
    <g
      transform={`translate(${laidOutNode.x},${laidOutNode.y})`}
      className={`g-node-body g-symbol-${kind}${selected ? ' selected' : ''}${interactive ? '' : ' noninteractive'}`}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? title : undefined}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={interactive ? () => setFocused(true) : undefined}
      onBlur={interactive ? () => setFocused(false) : undefined}
      onClick={interactive ? (event) => {
        event.stopPropagation()
        if (suppressClick.current) {
          suppressClick.current = false
          return
        }
        onSelect(node)
      } : undefined}
      onDoubleClick={interactive && onExpand ? (event) => {
        event.stopPropagation()
        onExpand(node)
      } : undefined}
      onKeyDown={interactive ? (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onSelect(node)
      } : undefined}
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
        height={bodyHeight}
        name={name}
      />
      {(kind === 'reg' || kind === 'latch') && (
        <RegisterPins
          node={node}
          width={laidOutNode.width}
          bodyHeight={bodyHeight}
        />
      )}
      {showPins && kind !== 'reg' && kind !== 'latch' && (
        <PinLabels
          pins={pins}
          width={laidOutNode.width}
          height={bodyHeight}
        />
      )}
      {controls.length > 0 && (
        <ControlLabels
          node={node}
          width={laidOutNode.width}
          startY={bodyHeight}
          onSelect={interactive ? onControlSelect : undefined}
        />
      )}
    </g>
  )
})

export function GraphView({
  graph,
  rootId,
  highlight,
  selectedId,
  interactive,
  onSelect,
  onControlSelect,
  onExpand,
  active,
  fitNonce,
}: Props) {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const viewportRef = useRef<SVGGElement | null>(null)
  const transformRef = useRef<ViewportTransform>({ x: 0, y: 0, k: 1 })
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

  // The graph can contain thousands of SVG elements. Keep pointer-frequency
  // pan/zoom updates outside React so moving the viewport only mutates this
  // outer group instead of reconciling every edge and node.
  const applyTransform = useCallback((next: ViewportTransform) => {
    transformRef.current = next
    viewportRef.current?.setAttribute('transform', viewportTransformAttribute(next))
  }, [])

  const fit = useCallback(() => {
    const stage = stageRef.current
    if (!stage || graph.nodes.length === 0) return
    const rect = stage.getBoundingClientRect()
    const next = fitViewportToContent(
      rect.width,
      rect.height,
      graph.width,
      graph.height,
    )
    if (next) applyTransform(next)
  }, [applyTransform, graph])

  useLayoutEffect(() => {
    userAdjusted.current = false
    fit()
  }, [fit, fitNonce])

  useEffect(() => {
    if (!active) return
    const stage = stageRef.current
    if (!stage) return

    const updateSize = () => {
      if (!userAdjusted.current) fit()
    }

    // ResizeObserver normally delivers an initial entry, but measuring now
    // avoids one frame with a stale transform when a display:none Graph tab is
    // shown again. fit() ignores transient zero-sized flex layouts.
    updateSize()

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateSize)
      return () => window.removeEventListener('resize', updateSize)
    }

    const observer = new ResizeObserver(updateSize)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [active, fit])

  const onWheel = useCallback(
    (event: React.WheelEvent) => {
      event.preventDefault()
      const stage = stageRef.current
      if (!stage) return
      const rect = stage.getBoundingClientRect()
      const mouseX = event.clientX - rect.left
      const mouseY = event.clientY - rect.top
      userAdjusted.current = true
      applyTransform(
        zoomViewportAt(
          transformRef.current,
          mouseX,
          mouseY,
          Math.exp(-event.deltaY * 0.0016),
        ),
      )
    },
    [applyTransform],
  )

  const onPointerDown = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      if (event.button !== 0) return
      panState.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        transform: transformRef.current,
        moved: false,
      }
      event.currentTarget.classList.add('panning')
    },
    [],
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      const pan = panState.current
      if (!pan || event.pointerId !== pan.pointerId) return
      if (event.buttons === 0) {
        // The release happened outside the svg before capture engaged; end
        // the gesture instead of panning with no button held.
        panState.current = null
        event.currentTarget.classList.remove('panning')
        return
      }
      const dx = event.clientX - pan.x
      const dy = event.clientY - pan.y
      if (!pan.moved && Math.hypot(dx, dy) >= 2) {
        pan.moved = true
        userAdjusted.current = true
        // Capture only once a pan actually starts. Capturing on pointerdown
        // makes the browser retarget the eventual pointerup/click at the svg
        // root, which silently drops the first click on a node.
        event.currentTarget.setPointerCapture?.(event.pointerId)
      }
      if (pan.moved) applyTransform(panViewport(pan.transform, dx, dy))
    },
    [applyTransform],
  )

  const finishPan = useCallback(() => {
    const moved = Boolean(panState.current?.moved)
    suppressClick.current = moved
    if (moved) {
      window.setTimeout(() => {
        suppressClick.current = false
      }, 0)
    }
    panState.current = null
    svgRef.current?.classList.remove('panning')
  }, [])

  const cancelPan = useCallback(() => {
    suppressClick.current = false
    panState.current = null
    svgRef.current?.classList.remove('panning')
  }, [])

  useEffect(() => {
    if (active) return
    panState.current = null
    suppressClick.current = false
    svgRef.current?.classList.remove('panning')
  }, [active])

  const zoomBy = (factor: number) => {
    userAdjusted.current = true
    const rect = stageRef.current?.getBoundingClientRect()
    const centerX = rect ? rect.width / 2 : 0
    const centerY = rect ? rect.height / 2 : 0
    applyTransform(
      zoomViewportAt(transformRef.current, centerX, centerY, factor),
    )
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
        ref={svgRef}
        width="100%"
        height="100%"
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
          if (interactive && event.target === event.currentTarget) onSelect(null)
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

        <g ref={viewportRef}>
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
            const bits = laidOutEdge.edge.bits.length
            const isBus = bits > 1
            const className = `g-edge${laidOutEdge.edge.control ? ' control' : ''}${isBus ? ' bus' : ''}${highlighted ? ' hl' : ''}`
            const mid = points.length > 0 ? points[Math.floor(points.length / 2)] : null
            return (
              <g key={index}>
                <path
                  className={className}
                  d={pathD(points)}
                  markerEnd={`url(#${highlighted ? 'arrow-hl' : 'arrow'})`}
                >
                  <title>
                    {shortNetName(laidOutEdge.edge.net_name)} ({bits} bit
                    {isBus ? 's' : ''}): {laidOutEdge.edge.from_port}→
                    {laidOutEdge.edge.to_port}
                  </title>
                </path>
                {isBus && mid && (
                  <text
                    className="g-bus-label"
                    x={mid.x}
                    y={mid.y - 3}
                    textAnchor="middle"
                    aria-hidden="true"
                  >
                    {bits}
                  </text>
                )}
              </g>
            )
          })}

          {graph.nodes.map((laidOutNode) => (
            <SchematicNode
              key={laidOutNode.id}
              laidOutNode={laidOutNode}
              rootId={rootId}
              highlighted={highlight.has(laidOutNode.id)}
              selected={laidOutNode.id === selectedId}
              portDirection={metadata.portDirection.get(laidOutNode.id) ?? 'input'}
              drivingNet={metadata.drivingNet.get(laidOutNode.id)}
              pins={metadata.pinsById.get(laidOutNode.id) ?? { incoming: [], outgoing: [] }}
              interactive={interactive}
              suppressClick={suppressClick}
              onSelect={onSelect}
              onControlSelect={onControlSelect}
              onExpand={onExpand}
            />
          ))}
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
