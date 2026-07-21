import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from 'react'
import {
  canonicalPinNames,
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
  type LaidOutEdge,
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
  isSpecialPrimitive,
  registerClockPath,
  shapePath,
  symbolKind,
  type PortDirection,
  type SymbolKind,
} from '../lib/symbols'
import type { ControlRef, ControlRole, GraphNode } from '../types'
import {
  EDGE_HIT_CELL_SIZE,
  edgeHitCellKey,
  edgeHitCellKeys,
} from '../lib/edgeHitGrid'

interface RegisterControlPin {
  pin: string
  role: ControlRole
}

interface Props {
  graph: LaidOutGraph
  rootId: number
  relevantIds: Set<number>
  overlayIds: Set<number>
  /** Extend source-selection overlays across adjacent port/constant nets. */
  extendOverlayToBoundaryNets?: boolean
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

interface PinchState {
  pointerIds: [number, number]
  centerX: number
  centerY: number
  distance: number
  transform: ViewportTransform
  moved: boolean
}

type SchematicDetailLevel = 'overview' | 'compact' | 'full'

const DETAIL_LEVEL_RANK: Record<SchematicDetailLevel, number> = {
  overview: 0,
  compact: 1,
  full: 2,
}
const DETAIL_RESTORE_IDLE_MS = 160

function initialDetailLevel(scale: number): SchematicDetailLevel {
  if (scale < 0.4) return 'overview'
  if (scale < 0.75) return 'compact'
  return 'full'
}

function nextDetailLevel(
  scale: number,
  current: SchematicDetailLevel,
): SchematicDetailLevel {
  if (current === 'overview') {
    if (scale >= 0.8) return 'full'
    if (scale >= 0.45) return 'compact'
    return 'overview'
  }
  if (current === 'compact') {
    if (scale < 0.35) return 'overview'
    if (scale >= 0.8) return 'full'
    return 'compact'
  }
  if (scale < 0.35) return 'overview'
  if (scale < 0.65) return 'compact'
  return 'full'
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
  } else if (isSpecialPrimitive(node)) {
    fill = 'color-mix(in srgb, var(--blue) 10%, transparent)'
    stroke = 'var(--blue)'
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
  const maxChars = Math.max(4, Math.floor((width - 24) / 7.2))
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
  const incoming = pins.incoming
  const outgoing = pins.outgoing
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
  onNodeElement: (nodeId: number, element: SVGGElement | null) => void
  onControlSelect?: (control: ControlRef, node: GraphNode) => void
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
  onNodeElement,
  onControlSelect,
}: SchematicNodeProps) {
  const node = laidOutNode.node
  const kind = symbolKind(node, portDirection)
  const visual = nodeVisual(node, kind, rootId, highlighted)
  const name = nodeSublabel(node)
  const controls = controlsFor(node)
  const bodyHeight = Math.max(1, laidOutNode.height - controls.length * 13)
  const strokeWidth = selected ? 2.4 : visual.isRoot || highlighted ? 1.8 : 1.2
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

function graphNodeElement(
  target: EventTarget | null,
  boundary: Element,
): SVGGElement | null {
  if (!(target instanceof Element)) return null
  const node = target.closest<SVGGElement>('.g-node-body')
  return node && boundary.contains(node) ? node : null
}

function graphNodeId(element: SVGGElement | null): number | null {
  const value = element?.dataset.graphNodeId
  if (value == null) return null
  const nodeId = Number(value)
  return Number.isFinite(nodeId) ? nodeId : null
}

interface SchematicPinOverlaysProps {
  viewportRef: RefObject<SVGGElement | null>
  nodeById: Map<number, LaidOutNode>
  pinsById: Map<number, NodePins>
  portDirection: Map<number, PortDirection>
  selectedId: number | null
}

// Pointer and focus events bubble through one viewport listener. Only this
// small overlay reconciles when transient pin labels move between nodes.
const SchematicPinOverlays = memo(function SchematicPinOverlays({
  viewportRef,
  nodeById,
  pinsById,
  portDirection,
  selectedId,
}: SchematicPinOverlaysProps) {
  const [hoveredElement, setHoveredElement] = useState<SVGGElement | null>(null)
  const [focusedElement, setFocusedElement] = useState<SVGGElement | null>(null)

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    const onPointerOver = (event: PointerEvent) => {
      const node = graphNodeElement(event.target, viewport)
      const previous = graphNodeElement(event.relatedTarget, viewport)
      if (node !== previous) setHoveredElement(node)
    }
    const onPointerOut = (event: PointerEvent) => {
      const node = graphNodeElement(event.target, viewport)
      const next = graphNodeElement(event.relatedTarget, viewport)
      if (node !== next) setHoveredElement(next)
    }
    const onFocusIn = (event: FocusEvent) => {
      setFocusedElement(graphNodeElement(event.target, viewport))
    }
    const onFocusOut = (event: FocusEvent) => {
      setFocusedElement(graphNodeElement(event.relatedTarget, viewport))
    }

    viewport.addEventListener('pointerover', onPointerOver)
    viewport.addEventListener('pointerout', onPointerOut)
    viewport.addEventListener('focusin', onFocusIn)
    viewport.addEventListener('focusout', onFocusOut)
    return () => {
      viewport.removeEventListener('pointerover', onPointerOver)
      viewport.removeEventListener('pointerout', onPointerOut)
      viewport.removeEventListener('focusin', onFocusIn)
      viewport.removeEventListener('focusout', onFocusOut)
    }
  }, [viewportRef])

  const transientIds = [
    selectedId,
    graphNodeId(hoveredElement),
    graphNodeId(focusedElement),
  ]
  const renderedIds = new Set<number>()

  return transientIds.map((nodeId) => {
    if (nodeId == null || renderedIds.has(nodeId)) return null
    renderedIds.add(nodeId)
    const laidOutNode = nodeById.get(nodeId)
    if (!laidOutNode || laidOutNode.node.kind === 'port') return null
    const kind = symbolKind(
      laidOutNode.node,
      portDirection.get(nodeId) ?? 'input',
    )
    if (kind === 'reg' || kind === 'latch') return null
    const bodyHeight = Math.max(
      1,
      laidOutNode.height - controlsFor(laidOutNode.node).length * 13,
    )
    return (
      <g
        key={nodeId}
        className="g-pin-overlay"
        transform={`translate(${laidOutNode.x},${laidOutNode.y})`}
        data-graph-node-id={nodeId}
        aria-hidden="true"
      >
        <PinLabels
          pins={pinsById.get(nodeId) ?? EMPTY_NODE_PINS}
          width={laidOutNode.width}
          height={bodyHeight}
        />
      </g>
    )
  })
})

interface SchematicEdgesProps {
  prepared: PreparedSchematicEdges
}

interface PreparedSchematicEdge {
  index: number
  points: Point[]
  title: string
  bits: number
  isBus: boolean
  relevant: boolean
  control: boolean
  highlighted: boolean
  batchKey: string
  mid: Point | null
}

interface SchematicEdgeBatch {
  key: string
  d: string
  count: number
  firstTitle: string
  relevant: boolean
  control: boolean
  isBus: boolean
  highlighted: boolean
}

interface SchematicArrowBatch {
  key: string
  d: string
  count: number
  relevant: boolean
  control: boolean
  highlighted: boolean
}

interface PreparedSchematicEdges {
  edges: PreparedSchematicEdge[]
  batches: SchematicEdgeBatch[]
  arrows: SchematicArrowBatch[]
}

function edgeBatchKey(
  relevant: boolean,
  control: boolean,
  isBus: boolean,
  highlighted: boolean,
): string {
  return `${relevant ? 1 : 0}${control ? 1 : 0}${isBus ? 1 : 0}${highlighted ? 1 : 0}`
}

function edgeClassName(
  control: boolean,
  isBus: boolean,
  highlighted: boolean,
): string {
  return `g-edge${control ? ' control' : ''}${isBus ? ' bus' : ''}${highlighted ? ' hl' : ''}`
}

function edgePaintOrder(batch: {
  relevant: boolean
  control: boolean
  isBus?: boolean
  highlighted: boolean
}): number {
  // Paint context first and highlighted nets last. This makes the semantic
  // overlay deterministic instead of depending on backend edge order.
  return (
    (batch.highlighted ? 8 : 0) +
    (batch.relevant ? 4 : 0) +
    (batch.control ? 2 : 0) +
    (batch.isBus ? 1 : 0)
  )
}

function edgeStrokeWidth(
  edge: Pick<PreparedSchematicEdge, 'isBus' | 'highlighted'>,
): number {
  if (edge.highlighted) return 2.2
  if (edge.isBus) return 2.4
  return 1.3
}

function edgeArrowD(points: Point[], strokeWidth: number): string {
  if (points.length < 2) return ''
  const tipAnchor = points[points.length - 1]
  let previousIndex = points.length - 2
  while (
    previousIndex >= 0 &&
    points[previousIndex].x === tipAnchor.x &&
    points[previousIndex].y === tipAnchor.y
  ) {
    previousIndex -= 1
  }
  if (previousIndex < 0) return ''
  const previous = points[previousIndex]
  const dx = tipAnchor.x - previous.x
  const dy = tipAnchor.y - previous.y
  const length = Math.hypot(dx, dy)
  if (length === 0) return ''
  const ux = dx / length
  const uy = dy / length
  const px = -uy
  const py = ux

  // Match the former marker: viewBox 0 0 10 10, ref 9 5, marker 7x7,
  // markerUnits=strokeWidth. The triangle tip sits 0.7 stroke widths past the
  // edge endpoint and its base 6.3 stroke widths behind it.
  const tipX = tipAnchor.x + ux * 0.7 * strokeWidth
  const tipY = tipAnchor.y + uy * 0.7 * strokeWidth
  const baseX = tipAnchor.x - ux * 6.3 * strokeWidth
  const baseY = tipAnchor.y - uy * 6.3 * strokeWidth
  const halfWidth = 3.5 * strokeWidth
  return [
    `M ${baseX + px * halfWidth} ${baseY + py * halfWidth}`,
    `L ${tipX} ${tipY}`,
    `L ${baseX - px * halfWidth} ${baseY - py * halfWidth}`,
    'Z',
  ].join(' ')
}

function prepareSchematicEdges({
  edges,
  nodeById,
  relevantIds,
  overlayIds,
  extendOverlayToBoundaryNets,
}: {
  edges: LaidOutEdge[]
  nodeById: Map<number, LaidOutNode>
  relevantIds: Set<number>
  overlayIds: Set<number>
  extendOverlayToBoundaryNets: boolean
}): PreparedSchematicEdges {
  const prepared: PreparedSchematicEdge[] = []
  const batchBuilders = new Map<string, SchematicEdgeBatch & { paths: string[] }>()
  const arrowBuilders = new Map<string, SchematicArrowBatch & { paths: string[] }>()

  edges.forEach((laidOutEdge, index) => {
    const relevant =
      relevantIds.size === 0 ||
      (relevantIds.has(laidOutEdge.from) && relevantIds.has(laidOutEdge.to))
    const fromHighlighted = overlayIds.has(laidOutEdge.from)
    const toHighlighted = overlayIds.has(laidOutEdge.to)
    const fromKind =
      extendOverlayToBoundaryNets && toHighlighted
        ? nodeById.get(laidOutEdge.from)?.node.kind
        : undefined
    const toKind =
      extendOverlayToBoundaryNets && fromHighlighted
        ? nodeById.get(laidOutEdge.to)?.node.kind
        : undefined
    // Source overlays name logic cells, not their port/constant boundary
    // nodes. Keep those terminal nets continuous without lighting up branches
    // from the selected logic into unrelated context cells.
    const highlighted =
      (fromHighlighted && toHighlighted) ||
      (extendOverlayToBoundaryNets &&
        relevant &&
        ((fromHighlighted && toKind != null && toKind !== 'cell') ||
          (toHighlighted && fromKind != null && fromKind !== 'cell')))
    let points = laidOutEdge.points
    if (points.length < 2) {
      const from = nodeById.get(laidOutEdge.from)
      const to = nodeById.get(laidOutEdge.to)
      if (from && to) {
        points = [
          { x: from.x + from.width, y: from.y + from.height / 2 },
          { x: to.x, y: to.y + to.height / 2 },
        ]
      }
    }
    const bits = laidOutEdge.edge.bits.length
    const isBus = bits > 1
    const control = Boolean(laidOutEdge.edge.control)
    const batchKey = edgeBatchKey(relevant, control, isBus, highlighted)
    const mid = points.length > 0 ? points[Math.floor(points.length / 2)] : null
    const title = `${shortNetName(laidOutEdge.edge.net_name)} (${bits} bit${isBus ? 's' : ''}): ${laidOutEdge.edge.from_port}→${laidOutEdge.edge.to_port}`
    const edge: PreparedSchematicEdge = {
      index,
      points,
      title,
      bits,
      isBus,
      relevant,
      control,
      highlighted,
      batchKey,
      mid,
    }
    prepared.push(edge)

    let batch = batchBuilders.get(batchKey)
    if (!batch) {
      batch = {
        key: batchKey,
        d: '',
        count: 0,
        firstTitle: title,
        relevant,
        control,
        isBus,
        highlighted,
        paths: [],
      }
      batchBuilders.set(batchKey, batch)
    }
    batch.count += 1
    const line = pathD(points)
    if (line) batch.paths.push(line)

    const arrow = edgeArrowD(points, edgeStrokeWidth(edge))
    if (arrow) {
      const arrowKey = `${relevant ? 1 : 0}${control ? 1 : 0}${highlighted ? 1 : 0}`
      let arrowBatch = arrowBuilders.get(arrowKey)
      if (!arrowBatch) {
        arrowBatch = {
          key: arrowKey,
          d: '',
          count: 0,
          relevant,
          control,
          highlighted,
          paths: [],
        }
        arrowBuilders.set(arrowKey, arrowBatch)
      }
      arrowBatch.count += 1
      arrowBatch.paths.push(arrow)
    }
  })

  const batches = [...batchBuilders.values()]
    .map(({ paths, ...batch }) => ({ ...batch, d: paths.join(' ') }))
    .sort((a, b) => edgePaintOrder(a) - edgePaintOrder(b))
  const arrows = [...arrowBuilders.values()]
    .map(({ paths, ...batch }) => ({ ...batch, d: paths.join(' ') }))
    .sort((a, b) => edgePaintOrder(a) - edgePaintOrder(b))
  return { edges: prepared, batches, arrows }
}

// Selection changes affect node state far more often than edge state. Keep the
// complete edge layer outside those reconciliations, and batch equal semantic
// styles into a bounded number of paths instead of mounting one path and title
// for every connection.
const SchematicEdges = memo(function SchematicEdges({ prepared }: SchematicEdgesProps) {
  if (prepared.edges.length === 0) return null
  return (
    <g
      className="g-edge-layer"
      role="img"
      aria-label={`${prepared.edges.length} schematic connection${prepared.edges.length === 1 ? '' : 's'}. Inspect nodes for accessible fanin and fanout details.`}
    >
      {prepared.batches.map((batch) => (
        <path
          key={batch.key}
          className={edgeClassName(batch.control, batch.isBus, batch.highlighted)}
          d={batch.d}
          data-edge-batch={batch.key}
          data-edge-count={batch.count}
          data-first-edge-title={batch.firstTitle}
          data-relevant={batch.relevant ? 1 : 0}
          aria-hidden="true"
        />
      ))}
      {prepared.arrows.map((batch) => (
        <path
          key={batch.key}
          className={`g-edge-arrows${batch.control ? ' control' : ''}${batch.highlighted ? ' hl' : ''}`}
          d={batch.d}
          data-arrow-count={batch.count}
          data-relevant={batch.relevant ? 1 : 0}
          aria-hidden="true"
        />
      ))}
      {prepared.edges.map((edge) => edge.isBus && edge.mid ? (
        <text
          key={edge.index}
          className="g-bus-label"
          x={edge.mid.x}
          y={edge.mid.y - 3}
          textAnchor="middle"
          aria-hidden="true"
          data-relevant={edge.relevant ? 1 : 0}
        >
          {edge.bits}
        </text>
      ) : null)}
    </g>
  )
})

const EDGE_HIT_TOLERANCE_PX = 7

interface EdgeHitSegment {
  id: number
  edge: PreparedSchematicEdge
  from: Point
  to: Point
}

interface EdgeHitIndex {
  batches: Map<string, Map<string, EdgeHitSegment[]>>
}

interface EdgeTooltipState {
  edgeIndex: number
  title: string
  left: number
  top: number
}

function buildEdgeHitIndex(edges: PreparedSchematicEdge[]): EdgeHitIndex {
  const batches = new Map<string, Map<string, EdgeHitSegment[]>>()
  let segmentId = 0
  for (const edge of edges) {
    let cells = batches.get(edge.batchKey)
    if (!cells) {
      cells = new Map()
      batches.set(edge.batchKey, cells)
    }
    for (let pointIndex = 1; pointIndex < edge.points.length; pointIndex += 1) {
      const from = edge.points[pointIndex - 1]
      const to = edge.points[pointIndex]
      if (from.x === to.x && from.y === to.y) continue
      const segment: EdgeHitSegment = { id: segmentId, edge, from, to }
      segmentId += 1
      for (const key of edgeHitCellKeys(from, to)) {
        const existing = cells.get(key)
        if (existing) existing.push(segment)
        else cells.set(key, [segment])
      }
    }
  }
  return { batches }
}

function pointSegmentDistanceSquared(point: Point, from: Point, to: Point): number {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) {
    const px = point.x - from.x
    const py = point.y - from.y
    return px * px + py * py
  }
  const projection = Math.max(
    0,
    Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared),
  )
  const closestX = from.x + projection * dx
  const closestY = from.y + projection * dy
  const px = point.x - closestX
  const py = point.y - closestY
  return px * px + py * py
}

function hitTestEdge(
  index: EdgeHitIndex,
  batchKey: string,
  point: Point,
  tolerance: number,
): PreparedSchematicEdge | null {
  const cells = index.batches.get(batchKey)
  if (!cells) return null
  const minCellX = Math.floor((point.x - tolerance) / EDGE_HIT_CELL_SIZE)
  const maxCellX = Math.floor((point.x + tolerance) / EDGE_HIT_CELL_SIZE)
  const minCellY = Math.floor((point.y - tolerance) / EDGE_HIT_CELL_SIZE)
  const maxCellY = Math.floor((point.y + tolerance) / EDGE_HIT_CELL_SIZE)
  const visitedSegments = new Set<number>()
  const toleranceSquared = tolerance * tolerance
  let best: { edge: PreparedSchematicEdge; distanceSquared: number } | null = null
  for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
    for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
      for (const segment of cells.get(edgeHitCellKey(cellX, cellY)) ?? []) {
        if (visitedSegments.has(segment.id)) continue
        visitedSegments.add(segment.id)
        const distanceSquared = pointSegmentDistanceSquared(
          point,
          segment.from,
          segment.to,
        )
        if (distanceSquared > toleranceSquared) continue
        if (
          !best ||
          distanceSquared < best.distanceSquared ||
          (distanceSquared === best.distanceSquared && segment.edge.index > best.edge.index)
        ) {
          best = { edge: segment.edge, distanceSquared }
        }
      }
    }
  }
  return best?.edge ?? null
}

const SchematicEdgeTooltip = memo(function SchematicEdgeTooltip({
  active,
  edges,
  stageRef,
  svgRef,
  viewportRef,
  hideRef,
}: {
  active: boolean
  edges: PreparedSchematicEdge[]
  stageRef: RefObject<HTMLDivElement | null>
  svgRef: RefObject<SVGSVGElement | null>
  viewportRef: RefObject<SVGGElement | null>
  hideRef: MutableRefObject<(() => void) | null>
}) {
  const hitIndexRef = useRef<{
    edges: PreparedSchematicEdge[]
    index: EdgeHitIndex
  } | null>(null)
  if (hitIndexRef.current?.edges !== edges) hitIndexRef.current = null
  const [tooltip, setTooltip] = useState<EdgeTooltipState | null>(null)

  useEffect(() => {
    setTooltip(null)
    if (!active) return
    const svg = svgRef.current
    const stage = stageRef.current
    const viewport = viewportRef.current
    if (!svg || !stage || !viewport) return
    let frame: number | null = null
    let idle: number | null = null
    let pending: { clientX: number; clientY: number; batchKey: string } | null = null
    let tooltipVisible = false
    const ensureHitIndex = () => {
      if (hitIndexRef.current?.edges === edges) return hitIndexRef.current.index
      const index = buildEdgeHitIndex(edges)
      hitIndexRef.current = { edges, index }
      return index
    }

    // Building the geometry grid is linear in routed segments. Warm it only
    // after the graph paints; the first pointer hit can still build it on
    // demand if the browser has not reached an idle period yet.
    if (typeof window.requestIdleCallback === 'function') {
      idle = window.requestIdleCallback(ensureHitIndex, { timeout: 1_000 })
    } else {
      idle = window.setTimeout(ensureHitIndex, 0)
    }

    const hide = () => {
      pending = null
      if (frame != null) window.cancelAnimationFrame(frame)
      frame = null
      if (tooltipVisible) {
        tooltipVisible = false
        setTooltip(null)
      }
    }
    hideRef.current = hide
    const resolvePending = () => {
      frame = null
      const current = pending
      pending = null
      if (!current || svg.classList.contains('panning')) {
        hide()
        return
      }
      const matrix = viewport.getScreenCTM()
      if (!matrix) {
        hide()
        return
      }
      const scale = Math.hypot(matrix.a, matrix.b)
      if (!Number.isFinite(scale) || scale <= 0) {
        hide()
        return
      }
      const graphPoint = new DOMPoint(current.clientX, current.clientY).matrixTransform(
        matrix.inverse(),
      )
      const edge = hitTestEdge(
        ensureHitIndex(),
        current.batchKey,
        graphPoint,
        EDGE_HIT_TOLERANCE_PX / scale,
      )
      if (!edge) {
        hide()
        return
      }
      const rect = stage.getBoundingClientRect()
      const left = Math.min(
        Math.max(8, current.clientX - rect.left + 12),
        Math.max(8, rect.width - 272),
      )
      const top = Math.min(
        Math.max(8, current.clientY - rect.top + 12),
        Math.max(8, rect.height - 44),
      )
      tooltipVisible = true
      setTooltip({ edgeIndex: edge.index, title: edge.title, left, top })
    }
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') {
        hide()
        return
      }
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('.g-node-body')) {
        hide()
        return
      }
      const edgePath = target?.closest<SVGPathElement>('.g-edge[data-edge-batch]')
      const batchKey = edgePath?.dataset.edgeBatch
      if (!edgePath || !batchKey || !svg.contains(edgePath)) {
        hide()
        return
      }
      pending = { clientX: event.clientX, clientY: event.clientY, batchKey }
      if (frame == null) frame = window.requestAnimationFrame(resolvePending)
    }

    svg.addEventListener('pointermove', onPointerMove)
    svg.addEventListener('pointerleave', hide)
    svg.addEventListener('pointerdown', hide)
    svg.addEventListener('wheel', hide)
    return () => {
      svg.removeEventListener('pointermove', onPointerMove)
      svg.removeEventListener('pointerleave', hide)
      svg.removeEventListener('pointerdown', hide)
      svg.removeEventListener('wheel', hide)
      if (hideRef.current === hide) hideRef.current = null
      if (frame != null) window.cancelAnimationFrame(frame)
      if (idle != null) {
        if (typeof window.cancelIdleCallback === 'function') {
          window.cancelIdleCallback(idle)
        } else {
          window.clearTimeout(idle)
        }
      }
    }
  }, [active, edges, hideRef, stageRef, svgRef, viewportRef])

  if (!tooltip) return null
  return (
    <div
      className="g-edge-tooltip"
      role="tooltip"
      data-edge-index={tooltip.edgeIndex}
      style={{ left: tooltip.left, top: tooltip.top }}
    >
      {tooltip.title}
    </div>
  )
})

export const GraphView = memo(function GraphView({
  graph,
  rootId,
  relevantIds,
  overlayIds,
  extendOverlayToBoundaryNets = false,
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
  const hideEdgeTooltipRef = useRef<(() => void) | null>(null)
  const graphRef = useRef(graph)
  graphRef.current = graph
  const layoutHistory = useRef<{
    graph: LaidOutGraph | null
    fitNonce: number | null
  }>({ graph: null, fitNonce: null })
  const transformRef = useRef<ViewportTransform>({ x: 0, y: 0, k: 1 })
  const panState = useRef<PanState | null>(null)
  const pinchState = useRef<PinchState | null>(null)
  const suppressClick = useRef(false)
  const userAdjusted = useRef(false)
  const rovingNodeId = useRef<number | null>(null)
  const nodeElements = useRef(new Map<number, SVGGElement>())
  const programmaticFocusNodeId = useRef<number | null>(null)
  const detailLevel = useRef<SchematicDetailLevel | null>(null)
  const detailRestoreTimer = useRef<number | null>(null)

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
        incoming: canonicalPinNames(pins.incoming),
        outgoing: canonicalPinNames(pins.outgoing),
        controlInputs: [...pins.controlInputs].map(([pin, role]) => ({ pin, role })),
      })
    }
    return { nodeById, pinsById, portDirection }
  }, [graph])
  const preparedEdges = useMemo(
    () => prepareSchematicEdges({
      edges: graph.edges,
      nodeById: metadata.nodeById,
      relevantIds,
      overlayIds,
      extendOverlayToBoundaryNets,
    }),
    [
      extendOverlayToBoundaryNets,
      graph.edges,
      metadata.nodeById,
      overlayIds,
      relevantIds,
    ],
  )

  const clearDetailRestore = useCallback(() => {
    if (detailRestoreTimer.current == null) return
    window.clearTimeout(detailRestoreTimer.current)
    detailRestoreTimer.current = null
  }, [])

  const applyDetailLevel = useCallback((next: SchematicDetailLevel) => {
    detailLevel.current = next
    viewportRef.current?.setAttribute('data-detail-level', next)
  }, [])

  // The graph can contain thousands of SVG elements. Keep pointer-frequency
  // pan/zoom updates outside React so moving the viewport only mutates this
  // outer group instead of reconciling every edge and node. Less detail applies
  // immediately; restoring richer labels waits until the gesture is idle so a
  // 2,000-node style/layout transition never lands in the middle of a frame.
  const applyTransform = useCallback((next: ViewportTransform) => {
    hideEdgeTooltipRef.current?.()
    transformRef.current = next
    viewportRef.current?.setAttribute('transform', viewportTransformAttribute(next))

    const current = detailLevel.current
    if (current == null) {
      applyDetailLevel(initialDetailLevel(next.k))
      return
    }
    const desired = nextDetailLevel(next.k, current)
    clearDetailRestore()
    if (DETAIL_LEVEL_RANK[desired] <= DETAIL_LEVEL_RANK[current]) {
      if (desired !== current) applyDetailLevel(desired)
      return
    }
    detailRestoreTimer.current = window.setTimeout(() => {
      detailRestoreTimer.current = null
      const activeLevel = detailLevel.current
      if (activeLevel == null) return
      const idleLevel = nextDetailLevel(transformRef.current.k, activeLevel)
      if (DETAIL_LEVEL_RANK[idleLevel] > DETAIL_LEVEL_RANK[activeLevel]) {
        applyDetailLevel(idleLevel)
      }
    }, DETAIL_RESTORE_IDLE_MS)
  }, [applyDetailLevel, clearDetailRestore])

  useEffect(() => clearDetailRestore, [clearDetailRestore])

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

  const acceptNodeTargetFocus = useCallback(
    (target: EventTarget | null, boundary: Element) => {
      if (!interactive) return
      const nodeId = graphNodeId(graphNodeElement(target, boundary))
      if (nodeId != null) acceptGraphNodeFocus(nodeId)
    },
    [acceptGraphNodeFocus, interactive],
  )

  const selectNodeTarget = useCallback(
    (event: React.MouseEvent<SVGSVGElement>) => {
      if (suppressClick.current) {
        suppressClick.current = false
        return
      }
      if (!interactive) return
      const nodeElement = graphNodeElement(event.target, event.currentTarget)
      const nodeId = graphNodeId(nodeElement)
      const laidOutNode = nodeId == null ? null : metadata.nodeById.get(nodeId)
      if (nodeElement && nodeId != null && laidOutNode) {
        event.stopPropagation()
        if (document.activeElement !== nodeElement) acceptGraphNodeFocus(nodeId)
        onSelect(laidOutNode.node)
        return
      }
      if (event.target === event.currentTarget) onSelect(null)
    },
    [acceptGraphNodeFocus, interactive, metadata.nodeById, onSelect],
  )

  const expandNodeTarget = useCallback(
    (event: React.MouseEvent<SVGSVGElement>) => {
      if (!interactive || !onExpand) return
      const nodeId = graphNodeId(graphNodeElement(event.target, event.currentTarget))
      const laidOutNode = nodeId == null ? null : metadata.nodeById.get(nodeId)
      if (!laidOutNode) return
      event.stopPropagation()
      onExpand(laidOutNode.node)
    },
    [interactive, metadata.nodeById, onExpand],
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
      if (event.pointerType === 'touch') return
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
      if (event.pointerType === 'touch') return

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
    const moved = Boolean(panState.current?.moved || pinchState.current?.moved)
    suppressClick.current = moved
    if (moved) {
      window.setTimeout(() => {
        suppressClick.current = false
      }, 0)
    }
    panState.current = null
    pinchState.current = null
    svgRef.current?.classList.remove('panning')
  }, [])

  const finishPointer = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      if (event.pointerType !== 'touch') finishPan()
    },
    [finishPan],
  )

  const cancelPan = useCallback(() => {
    suppressClick.current = false
    panState.current = null
    pinchState.current = null
    svgRef.current?.classList.remove('panning')
  }, [])

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length === 1) {
        const touch = event.touches[0]
        panState.current = {
          pointerId: touch.identifier,
          x: touch.clientX,
          y: touch.clientY,
          transform: transformRef.current,
          moved: false,
        }
      } else if (event.touches.length === 2) {
        const [first, second] = event.touches
        pinchState.current = {
          pointerIds: [first.identifier, second.identifier],
          centerX: (first.clientX + second.clientX) / 2,
          centerY: (first.clientY + second.clientY) / 2,
          distance: Math.max(
            1,
            Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY),
          ),
          transform: transformRef.current,
          moved: false,
        }
        panState.current = null
        userAdjusted.current = true
      }
      svg.classList.add('panning')
    }

    const onTouchMove = (event: TouchEvent) => {
      event.preventDefault()
      const pinch = pinchState.current
      if (pinch) {
        const first = [...event.touches].find(
          (touch) => touch.identifier === pinch.pointerIds[0],
        )
        const second = [...event.touches].find(
          (touch) => touch.identifier === pinch.pointerIds[1],
        )
        const stage = stageRef.current
        if (!first || !second || !stage) return
        const centerX = (first.clientX + second.clientX) / 2
        const centerY = (first.clientY + second.clientY) / 2
        const distance = Math.max(
          1,
          Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY),
        )
        const rect = stage.getBoundingClientRect()
        const zoomed = zoomViewportAt(
          pinch.transform,
          pinch.centerX - rect.left,
          pinch.centerY - rect.top,
          distance / pinch.distance,
        )
        pinch.moved = true
        applyTransform(
          panViewport(
            zoomed,
            centerX - pinch.centerX,
            centerY - pinch.centerY,
          ),
        )
        return
      }

      const pan = panState.current
      const touch = [...event.touches].find(
        (candidate) => candidate.identifier === pan?.pointerId,
      )
      if (!pan || !touch) return
      const dx = touch.clientX - pan.x
      const dy = touch.clientY - pan.y
      if (!pan.moved && Math.hypot(dx, dy) >= 2) {
        pan.moved = true
        userAdjusted.current = true
      }
      if (pan.moved) applyTransform(panViewport(pan.transform, dx, dy))
    }

    const onTouchEnd = (event: TouchEvent) => {
      if (pinchState.current && event.touches.length === 1) {
        const touch = event.touches[0]
        pinchState.current = null
        panState.current = {
          pointerId: touch.identifier,
          x: touch.clientX,
          y: touch.clientY,
          transform: transformRef.current,
          moved: true,
        }
        return
      }
      finishPan()
    }

    svg.addEventListener('touchstart', onTouchStart, { passive: false })
    svg.addEventListener('touchmove', onTouchMove, { passive: false })
    svg.addEventListener('touchend', onTouchEnd, { passive: false })
    svg.addEventListener('touchcancel', cancelPan, { passive: false })
    return () => {
      svg.removeEventListener('touchstart', onTouchStart)
      svg.removeEventListener('touchmove', onTouchMove)
      svg.removeEventListener('touchend', onTouchEnd)
      svg.removeEventListener('touchcancel', cancelPan)
    }
  }, [applyTransform, cancelPan, finishPan])

  useEffect(() => {
    if (active) {
      // Deactivation cancels any pending richer-detail restore. Re-evaluate the
      // preserved transform when the tab returns so a user-adjusted viewport
      // cannot remain stuck at the lower tier that was active mid-gesture.
      applyTransform(transformRef.current)
      return
    }
    panState.current = null
    pinchState.current = null
    suppressClick.current = false
    clearDetailRestore()
    svgRef.current?.classList.remove('panning')
  }, [active, applyTransform, clearDetailRestore])

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
      const nodeId = interactive
        ? graphNodeId(graphNodeElement(event.target, event.currentTarget))
        : null
      const laidOutNode = nodeId == null ? null : metadata.nodeById.get(nodeId)
      if (nodeId != null && laidOutNode) {
        if (GRAPH_NAVIGATION_KEYS.has(event.key)) {
          event.preventDefault()
          event.stopPropagation()
          navigateGraphNode(nodeId, event.key as GraphNavigationKey)
          return
        }
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        event.stopPropagation()
        if (event.key === 'Enter' && event.shiftKey && onExpand) {
          onExpand(laidOutNode.node)
          return
        }
        onSelect(laidOutNode.node)
        return
      }
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
    [
      applyTransform,
      fit,
      interactive,
      metadata.nodeById,
      navigateGraphNode,
      onExpand,
      onSelect,
      zoomBy,
    ],
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
        onFocus={(event) => acceptNodeTargetFocus(event.target, event.currentTarget)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishPointer}
        onPointerCancel={cancelPan}
        onClick={selectNodeTarget}
        onDoubleClick={expandNodeTarget}
      >
        <g
          ref={viewportRef}
          className="g-viewport"
          data-detail-level="overview"
        >
          <SchematicEdges prepared={preparedEdges} />

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
              onNodeElement={setNodeElement}
              onControlSelect={onControlSelect}
            />
          ))}

          <SchematicPinOverlays
            viewportRef={viewportRef}
            nodeById={metadata.nodeById}
            pinsById={metadata.pinsById}
            portDirection={metadata.portDirection}
            selectedId={selectedId}
          />
        </g>
      </svg>

      <SchematicEdgeTooltip
        active={active}
        edges={preparedEdges.edges}
        stageRef={stageRef}
        svgRef={svgRef}
        viewportRef={viewportRef}
        hideRef={hideEdgeTooltipRef}
      />

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
