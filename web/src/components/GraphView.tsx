import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  controlRoleForPin,
  fitViewportToContent,
  panViewport,
  preserveViewportAnchor,
  REG_BODY_HEIGHT,
  REG_CLOCK_Y_FRAC,
  REG_DATA_IN_Y_FRAC,
  REG_DATA_OUT_Y_FRAC,
  registerControlYFraction,
  viewportTransformAttribute,
  zoomViewportAt,
  type LaidOutGraph,
  type LaidOutNode,
  type Point,
  type ViewportTransform,
} from '../lib/layout'
import { groupBadgeText, nodeLabel, nodeSublabel, shortNetName } from '../lib/prettyType'
import {
  arithGlyph,
  boxBadge,
  bubbleAt,
  controlLabel,
  controlsFor,
  inferPortDirections,
  inputArcPath,
  inputBubbleAt,
  registerClockPath,
  shapePath,
  symbolKind,
  type PortDirection,
  type SymbolKind,
} from '../lib/symbols'
import type { ControlRef, ControlRole, GraphNode } from '../types'

interface RegisterControlPin {
  pin: string
  role: ControlRole
}

interface Props {
  graph: LaidOutGraph
  rootId: number
  relevantIds: Set<number>
  overlayIds: Set<number>
  selectedId: number | null
  interactive: boolean
  onSelect: (node: GraphNode | null) => void
  /** Opens a dedicated control cone when the parent supports that workflow. */
  onControlSelect?: (control: ControlRef, node: GraphNode) => void
  /** Double-click a node to additively render its fanin/fanout connections. */
  onExpand?: (node: GraphNode) => void
  active: boolean
  fitNonce: number
}

interface NodePins {
  incoming: string[]
  outgoing: string[]
  controlInputs: RegisterControlPin[]
}

const EMPTY_NODE_PINS: NodePins = { incoming: [], outgoing: [], controlInputs: [] }

interface MutableNodePins {
  incoming: Set<string>
  outgoing: Set<string>
  controlInputs: Map<string, ControlRole>
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
    fill = 'color-mix(in srgb, var(--green) 14%, transparent)'
    stroke = 'var(--green)'
  } else if (kind === 'const') {
    fill = 'var(--bg-1)'
    stroke = 'var(--border)'
  } else if (kind === 'reg' || kind === 'latch') {
    fill = 'color-mix(in srgb, var(--seq) 8%, transparent)'
    stroke = 'var(--seq)'
  } else if (kind === 'memory') {
    fill = 'color-mix(in srgb, var(--amber) 8%, transparent)'
    stroke = 'var(--amber)'
  }

  if (isRoot) {
    fill = 'color-mix(in srgb, var(--accent) 16%, transparent)'
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
  const stackOffsets = groupWidth >= 2 ? (groupWidth >= 4 ? [6, 3] : [3.5]) : []
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
          d={registerClockPath(Math.min(height, 58), REG_CLOCK_Y_FRAC)}
          fill="none"
          stroke={visual.stroke}
          strokeWidth={strokeWidth}
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

  const badgeText = groupBadgeText(node)
  const groupBadge = badgeText ? (
    <text className="g-group-badge" x={width - 4} y={11} textAnchor="end">
      {badgeText}
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

  // A flip-flop/latch is identified by its register signal name, so that is the
  // prominent centered label; the primitive type (DFF/LATCH) is a small tag on
  // top. When the register has no recoverable name, the type takes the center.
  if (kind === 'reg' || kind === 'latch') {
    return (
      <>
        {groupBadge}
        {name && (
          <text className="g-reg-type" x={width / 2} y={11} textAnchor="middle">
            {truncate(label, maxChars)}
          </text>
        )}
        <text
          className="g-node-label g-reg-name"
          x={width / 2}
          y={primaryHeight / 2 + (name ? 8 : 4)}
          textAnchor="middle"
        >
          {truncate(name ?? label, maxChars)}
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
function controlPinLetter(role: ControlRef['role']): string | null {
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
// shows its reset. Every edge is routed to the matching pin in layout.ts.
function RegisterPins({
  node,
  pins,
  width,
  bodyHeight,
}: {
  node: GraphNode
  pins: NodePins
  width: number
  bodyHeight: number
}) {
  // Pin positions must use the same primary body height as layout.ts (which
  // routes the data edges to min(fullHeight, REG_BODY_HEIGHT) port offsets), not
  // the full body — otherwise the grouped-badge row shifts the ticks off the
  // incoming/outgoing wires.
  const body = Math.min(bodyHeight, REG_BODY_HEIGHT)
  const dInY = body * REG_DATA_IN_Y_FRAC
  const qY = body * REG_DATA_OUT_Y_FRAC
  const seenRoles = new Set<ControlRole>()
  const controls = [...controlsFor(node), ...pins.controlInputs].filter((control) => {
    if (controlPinLetter(control.role) === null || seenRoles.has(control.role)) {
      return false
    }
    seenRoles.add(control.role)
    return true
  })
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
      {controls.map((control) => {
        const y = body * registerControlYFraction(control.role)
        return (
          <g key={`${control.role}-${control.pin}`}>
            <line className="g-reg-pin-tick" x1={0} x2={7} y1={y} y2={y} />
            <text className="g-reg-pin g-reg-ctrl-pin" x={9} y={y + 3}>
              {controlPinLetter(control.role)}
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
  startY,
  onSelect,
}: {
  node: GraphNode
  width: number
  startY: number
  onSelect?: (control: ControlRef, node: GraphNode) => void
}) {
  const controls = controlsFor(node)
  if (controls.length === 0) return null

  return (
    <g className="g-control-labels" aria-hidden="true">
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
            onPointerDown={onSelect ? (event) => event.stopPropagation() : undefined}
            onClick={onSelect ? (event) => {
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
  relevant: boolean
  highlighted: boolean
  selected: boolean
  portDirection: PortDirection
  pins: NodePins
  interactive: boolean
  tabIndex: 0 | -1
  suppressClick: { current: boolean }
  onNodeElement: (nodeId: number, element: SVGGElement | null) => void
  onSelect: (node: GraphNode | null) => void
  onFocusNode: (nodeId: number) => void
  onNavigateNode: (nodeId: number, key: GraphNavigationKey) => void
  onControlSelect?: (control: ControlRef, node: GraphNode) => void
  onExpand?: (node: GraphNode) => void
}

type GraphNavigationKey =
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'ArrowUp'
  | 'ArrowDown'
  | 'Home'
  | 'End'

const GRAPH_NAVIGATION_KEYS = new Set<string>([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
])

// Hover state belongs to one node, so revealing pin labels never reconciles
// the parent GraphView's thousands of nodes and edges.
const SchematicNode = memo(function SchematicNode({
  laidOutNode,
  rootId,
  relevant,
  highlighted,
  selected,
  portDirection,
  pins,
  interactive,
  tabIndex,
  suppressClick,
  onNodeElement,
  onSelect,
  onFocusNode,
  onNavigateNode,
  onControlSelect,
  onExpand,
}: SchematicNodeProps) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const node = laidOutNode.node
  const kind = symbolKind(node, portDirection)
  const visual = nodeVisual(node, kind, rootId, highlighted)
  const name = nodeSublabel(node)
  const controls = controlsFor(node)
  const bodyHeight = Math.max(1, laidOutNode.height - controls.length * 13)
  const strokeWidth = selected ? 2.4 : visual.isRoot || highlighted ? 1.8 : 1.2
  const showPins = (selected || hovered || focused) && node.kind !== 'port'
  const title = name && name !== nodeLabel(node)
    ? `${nodeLabel(node)} — ${name}`
    : nodeLabel(node)

  return (
    <g
      ref={(element) => onNodeElement(node.id, element)}
      transform={`translate(${laidOutNode.x},${laidOutNode.y})`}
      data-graph-node-id={node.id}
      className={`g-node-body g-symbol-${kind}${highlighted ? ' hl' : ''}${selected ? ' selected' : ''}${interactive ? '' : ' noninteractive'}`}
      data-relevant={relevant ? 1 : 0}
      data-node-id={node.id}
      data-member-count={node.members?.length}
      data-boundary={node.is_boundary ? 'true' : undefined}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? tabIndex : undefined}
      aria-label={
        interactive
          ? `${title}. Enter to inspect details and controls; Shift+Enter to expand.`
          : undefined
      }
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={interactive ? () => {
        setFocused(true)
        onFocusNode(node.id)
      } : undefined}
      onBlur={interactive ? () => setFocused(false) : undefined}
      onClick={interactive ? (event) => {
        event.stopPropagation()
        if (suppressClick.current) {
          suppressClick.current = false
          return
        }
        if (document.activeElement !== event.currentTarget) onFocusNode(node.id)
        onSelect(node)
      } : undefined}
      onDoubleClick={interactive && onExpand ? (event) => {
        event.stopPropagation()
        onExpand(node)
      } : undefined}
      onKeyDown={interactive ? (event) => {
        if (GRAPH_NAVIGATION_KEYS.has(event.key)) {
          event.preventDefault()
          event.stopPropagation()
          onNavigateNode(node.id, event.key as GraphNavigationKey)
          return
        }
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        event.stopPropagation()
        if (event.key === 'Enter' && event.shiftKey && onExpand) {
          onExpand(node)
          return
        }
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
          pins={pins}
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

export const GraphView = memo(function GraphView({
  graph,
  rootId,
  relevantIds,
  overlayIds,
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
  const graphRef = useRef(graph)
  graphRef.current = graph
  const layoutHistory = useRef<{
    graph: LaidOutGraph | null
    fitNonce: number | null
  }>({ graph: null, fitNonce: null })
  const transformRef = useRef<ViewportTransform>({ x: 0, y: 0, k: 1 })
  const panState = useRef<PanState | null>(null)
  const suppressClick = useRef(false)
  const userAdjusted = useRef(false)
  const rovingNodeId = useRef<number | null>(null)
  const nodeElements = useRef(new Map<number, SVGGElement>())
  const programmaticFocusNodeId = useRef<number | null>(null)

  const metadata = useMemo(() => {
    const nodeById = new Map<number, LaidOutNode>()
    const pinSetsById = new Map<number, MutableNodePins>()

    for (const laidOutNode of graph.nodes) {
      nodeById.set(laidOutNode.id, laidOutNode)
      pinSetsById.set(laidOutNode.id, {
        incoming: new Set(),
        outgoing: new Set(),
        controlInputs: new Map(),
      })
    }
    for (const edge of graph.edges) {
      const fromPins = pinSetsById.get(edge.from)
      const toPins = pinSetsById.get(edge.to)
      if (fromPins && edge.edge.from_port) fromPins.outgoing.add(edge.edge.from_port)
      if (toPins && edge.edge.to_port) {
        toPins.incoming.add(edge.edge.to_port)
        if (edge.edge.control) {
          toPins.controlInputs.set(
            edge.edge.to_port,
            controlRoleForPin(edge.edge.to_port),
          )
        }
      }
    }

    const portDirection = inferPortDirections(
      graph.nodes
        .filter((laidOutNode) => laidOutNode.node.kind === 'port')
        .map((laidOutNode) => laidOutNode.id),
      graph.edges,
    )
    const pinsById = new Map<number, NodePins>()
    for (const [nodeId, pins] of pinSetsById) {
      pinsById.set(nodeId, {
        incoming: [...pins.incoming],
        outgoing: [...pins.outgoing],
        controlInputs: [...pins.controlInputs].map(([pin, role]) => ({ pin, role })),
      })
    }
    return { nodeById, pinsById, portDirection }
  }, [graph])

  // The graph can contain thousands of SVG elements. Keep pointer-frequency
  // pan/zoom updates outside React so moving the viewport only mutates this
  // outer group instead of reconciling every edge and node.
  const applyTransform = useCallback((next: ViewportTransform) => {
    transformRef.current = next
    viewportRef.current?.setAttribute('transform', viewportTransformAttribute(next))
  }, [])

  const rovingTabStopId = interactive
    ? metadata.nodeById.has(rovingNodeId.current ?? Number.NaN)
      ? rovingNodeId.current
      : metadata.nodeById.has(selectedId ?? Number.NaN)
        ? selectedId
        : metadata.nodeById.has(rootId)
          ? rootId
          : (graph.nodes[0]?.id ?? null)
    : null
  rovingNodeId.current = rovingTabStopId

  const setNodeElement = useCallback(
    (nodeId: number, element: SVGGElement | null) => {
      if (element) nodeElements.current.set(nodeId, element)
      else nodeElements.current.delete(nodeId)
    },
    [],
  )

  const focusGraphNode = useCallback((nodeId: number) => {
    const previous = rovingNodeId.current == null
      ? null
      : (nodeElements.current.get(rovingNodeId.current) ?? null)
    previous?.setAttribute('tabindex', '-1')
    const next = nodeElements.current.get(nodeId)
    if (!next) return
    rovingNodeId.current = nodeId
    next.setAttribute('tabindex', '0')

    const laidOutNode = metadata.nodeById.get(nodeId)
    const stage = stageRef.current
    if (laidOutNode && stage) {
      const rect = stage.getBoundingClientRect()
      const wrapper = stage.parentElement
      const cardRect = wrapper
        ?.querySelector<HTMLElement>('.node-card')
        ?.getBoundingClientRect()
      const bannerRect = wrapper
        ?.querySelector<HTMLElement>('.graph-banner')
        ?.getBoundingClientRect()
      const shortcutRect = stage
        .querySelector<HTMLElement>('.graph-shortcuts')
        ?.getBoundingClientRect()
      const zoomControlsRect = stage
        .querySelector<HTMLElement>('.zoom-controls')
        ?.getBoundingClientRect()
      const transform = transformRef.current
      const margin = 24
      const leftBound = margin
      const rightBound = cardRect
        ? cardRect.left - rect.left - margin
        : rect.width - margin
      const topBound = bannerRect && bannerRect.height > 0
        ? bannerRect.bottom - rect.top + margin
        : margin
      const bottomOverlayTop = Math.min(
        shortcutRect?.top ?? Number.POSITIVE_INFINITY,
        zoomControlsRect?.top ?? Number.POSITIVE_INFINITY,
      )
      const bottomBound = Number.isFinite(bottomOverlayTop)
        ? bottomOverlayTop - rect.top - margin
        : rect.height - margin
      const left = laidOutNode.x * transform.k + transform.x
      const right = (laidOutNode.x + laidOutNode.width) * transform.k + transform.x
      const top = laidOutNode.y * transform.k + transform.y
      const bottom = (laidOutNode.y + laidOutNode.height) * transform.k + transform.y
      const dx = left < leftBound
        ? leftBound - left
        : right > rightBound
          ? rightBound - right
          : 0
      const dy = top < topBound
        ? topBound - top
        : bottom > bottomBound
          ? bottomBound - bottom
          : 0
      if (dx !== 0 || dy !== 0) {
        userAdjusted.current = true
        applyTransform({ ...transform, x: transform.x + dx, y: transform.y + dy })
      }
    }
    programmaticFocusNodeId.current = nodeId
    next.focus()
    programmaticFocusNodeId.current = null
  }, [applyTransform, metadata.nodeById])

  const acceptGraphNodeFocus = useCallback(
    (nodeId: number) => {
      if (programmaticFocusNodeId.current === nodeId) return
      focusGraphNode(nodeId)
    },
    [focusGraphNode],
  )

  useLayoutEffect(() => {
    if (selectedId == null || rovingNodeId.current == null) return
    focusGraphNode(rovingNodeId.current)
  }, [focusGraphNode, selectedId])

  const navigateGraphNode = useCallback(
    (nodeId: number, key: GraphNavigationKey) => {
      if (graph.nodes.length === 0) return
      if (key === 'Home') {
        focusGraphNode(graph.nodes[0].id)
        return
      }
      if (key === 'End') {
        focusGraphNode(graph.nodes[graph.nodes.length - 1].id)
        return
      }

      const current = metadata.nodeById.get(nodeId)
      if (!current) return
      const currentX = current.x + current.width / 2
      const currentY = current.y + current.height / 2
      let best: { id: number; score: number } | null = null
      for (const candidate of graph.nodes) {
        if (candidate.id === nodeId) continue
        const dx = candidate.x + candidate.width / 2 - currentX
        const dy = candidate.y + candidate.height / 2 - currentY
        const inDirection =
          (key === 'ArrowLeft' && dx < 0) ||
          (key === 'ArrowRight' && dx > 0) ||
          (key === 'ArrowUp' && dy < 0) ||
          (key === 'ArrowDown' && dy > 0)
        if (!inDirection) continue
        const primary = key === 'ArrowLeft' || key === 'ArrowRight'
          ? Math.abs(dx)
          : Math.abs(dy)
        const cross = key === 'ArrowLeft' || key === 'ArrowRight'
          ? Math.abs(dy)
          : Math.abs(dx)
        const score = primary + cross * 0.5
        if (!best || score < best.score) best = { id: candidate.id, score }
      }
      if (best) focusGraphNode(best.id)
    },
    [focusGraphNode, graph.nodes, metadata.nodeById],
  )

  const fit = useCallback(() => {
    const stage = stageRef.current
    const currentGraph = graphRef.current
    if (!stage || currentGraph.nodes.length === 0) return
    const rect = stage.getBoundingClientRect()
    const next = fitViewportToContent(
      rect.width,
      rect.height,
      currentGraph.width,
      currentGraph.height,
    )
    if (next) applyTransform(next)
  }, [applyTransform])

  useLayoutEffect(() => {
    const previous = layoutHistory.current
    if (previous.graph == null || previous.fitNonce !== fitNonce) {
      userAdjusted.current = false
      fit()
    } else if (previous.graph !== graph) {
      applyTransform(
        preserveViewportAnchor(
          transformRef.current,
          previous.graph,
          graph,
          [selectedId, rootId],
        ),
      )
    }
    layoutHistory.current = { graph, fitNonce }
  }, [applyTransform, fit, fitNonce, graph, rootId, selectedId])

  useEffect(() => {
    if (!active) return
    const stage = stageRef.current
    if (!stage) return

    const updateSize = () => {
      if (!userAdjusted.current) fit()
    }

    // ResizeObserver normally delivers an initial entry, but measuring now
    // avoids one frame with a stale transform when a display:none Schematic tab is
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

  const zoomBy = useCallback((factor: number) => {
    userAdjusted.current = true
    const rect = stageRef.current?.getBoundingClientRect()
    const centerX = rect ? rect.width / 2 : 0
    const centerY = rect ? rect.height / 2 : 0
    applyTransform(
      zoomViewportAt(transformRef.current, centerX, centerY, factor),
    )
  }, [applyTransform])

  const onViewportKeyDown = useCallback(
    (event: React.KeyboardEvent<SVGSVGElement>) => {
      if (event.target !== event.currentTarget) return
      const step = event.shiftKey ? 80 : 32
      let handled = true
      switch (event.key) {
        case 'ArrowLeft':
          applyTransform(panViewport(transformRef.current, step, 0))
          break
        case 'ArrowRight':
          applyTransform(panViewport(transformRef.current, -step, 0))
          break
        case 'ArrowUp':
          applyTransform(panViewport(transformRef.current, 0, step))
          break
        case 'ArrowDown':
          applyTransform(panViewport(transformRef.current, 0, -step))
          break
        case '+':
        case '=':
          zoomBy(1.25)
          break
        case '-':
        case '_':
          zoomBy(0.8)
          break
        case '0':
          userAdjusted.current = false
          fit()
          break
        default:
          handled = false
      }
      if (!handled) return
      userAdjusted.current = event.key !== '0'
      event.preventDefault()
      event.stopPropagation()
    },
    [applyTransform, fit, zoomBy],
  )

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
        role="region"
        aria-label="Schematic viewport. Use arrow keys to pan, plus and minus to zoom, and zero to fit."
        tabIndex={0}
        onWheel={onWheel}
        onKeyDown={onViewportKeyDown}
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
            const relevant =
              relevantIds.size === 0 ||
              (relevantIds.has(laidOutEdge.from) && relevantIds.has(laidOutEdge.to))
            const highlighted =
              overlayIds.has(laidOutEdge.from) && overlayIds.has(laidOutEdge.to)
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
              <g className="g-edge-wrap" key={index} data-relevant={relevant ? 1 : 0}>
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
              relevant={relevantIds.size === 0 || relevantIds.has(laidOutNode.id)}
              highlighted={overlayIds.has(laidOutNode.id)}
              selected={laidOutNode.id === selectedId}
              portDirection={metadata.portDirection.get(laidOutNode.id) ?? 'input'}
              pins={metadata.pinsById.get(laidOutNode.id) ?? EMPTY_NODE_PINS}
              interactive={interactive}
              tabIndex={laidOutNode.id === rovingTabStopId ? 0 : -1}
              suppressClick={suppressClick}
              onNodeElement={setNodeElement}
              onSelect={onSelect}
              onFocusNode={acceptGraphNodeFocus}
              onNavigateNode={navigateGraphNode}
              onControlSelect={onControlSelect}
              onExpand={onExpand}
            />
          ))}
        </g>
      </svg>

      {interactive && (
        <div className="graph-shortcuts" role="note">
          Node arrows move focus · Enter inspects · Shift+Enter or double-click
          expands · Esc clears · Viewport arrows pan · +/− zoom · 0 fits
        </div>
      )}

      <div className="zoom-controls">
        <button onClick={() => zoomBy(1.25)} title="Zoom in" aria-label="Zoom in">
          +
        </button>
        <button onClick={() => zoomBy(0.8)} title="Zoom out" aria-label="Zoom out">
          −
        </button>
        <button
          onClick={() => {
            userAdjusted.current = false
            fit()
          }}
          title="Fit to view"
          aria-label="Fit schematic to view"
        >
          ⤢
        </button>
      </div>
    </div>
  )
})

function truncate(value: string, maxLength: number): string {
  if (maxLength < 3 || value.length <= maxLength) return value
  return `${value.slice(0, maxLength - 1)}…`
}
