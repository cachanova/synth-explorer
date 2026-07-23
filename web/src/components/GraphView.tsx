import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from 'react'
import {
  canonicalPinNames,
  controlRoleForPin,
  fitViewportToContent,
  isRegisterControlPin,
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
  controlDriverIds,
  controlCaption,
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
  /** Final Yosys net bits named directly by the selected source declaration. */
  highlightedBits?: Set<number>
  /** Extend source-selection overlays across adjacent port/constant nets. */
  extendOverlayToBoundaryNets?: boolean
  selectedId: number | null
  interactive: boolean
  onSelect: (node: GraphNode | null) => void
  /** Cross-probes the exact final-net bits carried by a clicked edge. */
  onEdgeSelect?: (bits: number[]) => void
  /** Opens a dedicated control cone when the parent supports that workflow. */
  onControlSelect?: (control: ControlRef, node: GraphNode) => void
  /** Double-click a node to additively render its fanin/fanout connections. */
  onExpand?: (node: GraphNode) => void
  /** Expand one synthetic group into its canonical physical members. */
  onExpandGroup?: (node: GraphNode) => void
  /** Collapse a locally expanded group back to its stable synthetic node. */
  onCollapseGroup?: (groupId: number) => void
  expandedGroups?: ExpandedGroupFrame[]
  active: boolean
  fitNonce: number
}

export interface ExpandedGroupFrame {
  id: number
  label: string
  members: number[]
}

interface NodePins {
  incoming: string[]
  outgoing: string[]
  controlInputs: RegisterControlPin[]
}

const EMPTY_NODE_PINS: NodePins = { incoming: [], outgoing: [], controlInputs: [] }
const EMPTY_HIGHLIGHTED_BITS = new Set<number>()
const EMPTY_EXPANDED_GROUPS: ExpandedGroupFrame[] = []

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
const DETAIL_VIEWPORT_OVERSCAN = 96
const INITIAL_DETAIL_VIEWPORT = { width: 960, height: 640 }
const OVERVIEW_IDENTITY_NODE_LIMIT = 250
const FIT_OVERLAY_GAP = 12

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

function visibleDetailNodeIds(
  graph: LaidOutGraph,
  transform: ViewportTransform,
  viewportWidth: number,
  viewportHeight: number,
): Set<number> {
  const ids = new Set<number>()
  const minX = -DETAIL_VIEWPORT_OVERSCAN
  const minY = -DETAIL_VIEWPORT_OVERSCAN
  const maxX = viewportWidth + DETAIL_VIEWPORT_OVERSCAN
  const maxY = viewportHeight + DETAIL_VIEWPORT_OVERSCAN
  for (const node of graph.nodes) {
    const left = node.x * transform.k + transform.x
    const right = (node.x + node.width) * transform.k + transform.x
    const top = node.y * transform.k + transform.y
    const bottom = (node.y + node.height) * transform.k + transform.y
    if (right >= minX && left <= maxX && bottom >= minY && top <= maxY) {
      ids.add(node.id)
    }
  }
  return ids
}

function initialDetailState(graph: LaidOutGraph): {
  level: SchematicDetailLevel
  ids: Set<number>
} {
  const transform = fitViewportToContent(
    INITIAL_DETAIL_VIEWPORT.width,
    INITIAL_DETAIL_VIEWPORT.height,
    graph.width,
    graph.height,
  )
  if (!transform) return { level: 'overview', ids: new Set() }
  const level = initialDetailLevel(transform.k)
  return {
    level,
    ids: level === 'overview'
      ? new Set()
      : visibleDetailNodeIds(
          graph,
          transform,
          INITIAL_DETAIL_VIEWPORT.width,
          INITIAL_DETAIL_VIEWPORT.height,
        ),
  }
}

function sameNodeIds(left: Set<number>, right: Set<number>): boolean {
  if (left.size !== right.size) return false
  for (const id of left) if (!right.has(id)) return false
  return true
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
    fill = 'color-mix(in srgb, var(--green) 14%, var(--bg-2))'
    stroke = 'var(--green)'
  } else if (kind === 'const') {
    fill = 'var(--bg-1)'
    stroke = 'var(--border)'
  } else if (kind === 'reg' || kind === 'latch') {
    fill = 'color-mix(in srgb, var(--seq) 8%, var(--bg-2))'
    stroke = 'var(--seq)'
  } else if (kind === 'memory') {
    fill = 'color-mix(in srgb, var(--amber) 8%, var(--bg-2))'
    stroke = 'var(--amber)'
  } else if (kind === 'carry') {
    fill = 'color-mix(in srgb, var(--green) 10%, var(--bg-2))'
    stroke = 'var(--green)'
  } else if (kind === 'dsp') {
    fill = 'color-mix(in srgb, var(--amber) 10%, var(--bg-2))'
    stroke = 'var(--amber)'
  } else if (isSpecialPrimitive(node)) {
    fill = 'color-mix(in srgb, var(--blue) 10%, var(--bg-2))'
    stroke = 'var(--blue)'
  }

  if (isRoot) {
    fill = 'color-mix(in srgb, var(--accent) 16%, var(--bg-2))'
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
  showDetails,
  showStack,
  showOutline = true,
}: {
  node: GraphNode
  kind: SymbolKind
  width: number
  height: number
  visual: NodeVisual
  strokeWidth: number
  showDetails: boolean
  showStack: boolean
  showOutline?: boolean
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
      {showStack && stackOffsets.map((d) => (
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
      {showOutline && (path ? (
          <path className="g-symbol-outline" d={path} {...common} />
        ) : (
          <rect
            className="g-symbol-outline"
            width={width}
            height={height}
            rx={rx}
            {...common}
          />
        ))}

      {showOutline && bubble && (
        <circle
          className="g-symbol-outline"
          cx={bubble.cx}
          cy={bubble.cy}
          r={bubble.r}
          {...common}
        />
      )}
      {showOutline && inputBubble && (
        <circle
          className="g-symbol-outline"
          cx={inputBubble.cx}
          cy={inputBubble.cy}
          r={inputBubble.r}
          {...common}
        />
      )}
      {showDetails && inputArc && (
        <path
          className="g-symbol-detail"
          d={inputArc}
          fill="none"
          stroke={visual.stroke}
          strokeWidth={strokeWidth}
          vectorEffect="non-scaling-stroke"
        />
      )}

      {showDetails && kind === 'reg' && (
        <path
          className="g-symbol-detail"
          d={registerClockPath(Math.min(height, 58), REG_CLOCK_Y_FRAC)}
          fill="none"
          stroke={visual.stroke}
          strokeWidth={strokeWidth}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {showDetails && kind === 'memory' && (
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
  detailLevel = 'full',
}: {
  node: GraphNode
  kind: SymbolKind
  width: number
  height: number
  name: string | null
  detailLevel?: Exclude<SchematicDetailLevel, 'overview'>
}) {
  const label = nodeLabel(node)
  const labelGutter = kind === 'reg' || kind === 'latch' ? 52 : 24
  const maxChars = Math.max(4, Math.floor((width - labelGutter) / 7.2))
  const primaryHeight = kind === 'reg' ? Math.min(height, 58) : height

  const badgeText = groupBadgeText(node)
  const showCompactMemoryGroupDetails = detailLevel === 'compact'
    && isGroupedMemory(node, kind)
  const groupBadge = (detailLevel === 'full' || showCompactMemoryGroupDetails) && badgeText ? (
    <text
      className={`g-group-badge${showCompactMemoryGroupDetails ? ' g-memory-group-detail' : ''}`}
      x={width - 4}
      y={11}
      textAnchor="end"
    >
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
        {detailLevel === 'full' && name && (
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
        {detailLevel === 'full' && name && (
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

  const isBox = kind === 'box' || kind === 'memory' || kind === 'carry' || kind === 'dsp'
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
      {detailLevel === 'full' && isBox && (
        <text className="g-boundary-badge" x={width / 2} y={11} textAnchor="middle">
          {boxBadge(node)}
        </text>
      )}
      <text className="g-node-label" x={width / 2} y={labelY} textAnchor="middle">
        {truncate(label, maxChars)}
      </text>
      {(detailLevel === 'full' || showCompactMemoryGroupDetails) && showName && (
        <text
          className={`g-node-name${showCompactMemoryGroupDetails ? ' g-memory-group-detail' : ''}`}
          x={width / 2}
          y={labelY + 13}
          textAnchor="middle"
        >
          {truncate(name, maxChars)}
        </text>
      )}
    </>
  )
}

function isGroupedMemory(node: GraphNode, kind: SymbolKind): boolean {
  return kind === 'memory' && (node.member_count != null || node.members != null)
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
        const caption = controlCaption(control)
        const details = [
          control.net_count != null && control.net_count > 1
            ? `${control.role}${control.pin ? ` pin ${control.pin}` : ''}: ${control.net_count} distinct control nets`
            : `${control.role}${control.pin ? ` pin ${control.pin}` : ''}: ${shortNetName(control.net_name)}`,
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
  interactive: boolean
  tabIndex: 0 | -1
  onNodeElement: (nodeId: number, element: SVGGElement | null) => void
  showOverviewIdentity: boolean
  expandedGroupId?: number
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
  interactive,
  tabIndex,
  onNodeElement,
  showOverviewIdentity,
  expandedGroupId,
}: SchematicNodeProps) {
  const node = laidOutNode.node
  const kind = symbolKind(node, portDirection)
  const visual = nodeVisual(node, kind, rootId, highlighted)
  const name = nodeSublabel(node)
  const strokeWidth = selected ? 2.4 : visual.isRoot || highlighted ? 1.8 : 1.2
  const title = name && name !== nodeLabel(node)
    ? `${nodeLabel(node)} — ${name}${name !== node.name ? ` (${node.name})` : ''}`
    : nodeLabel(node)

  return (
    <g
      ref={(element) => onNodeElement(node.id, element)}
      transform={`translate(${laidOutNode.x},${laidOutNode.y})`}
      data-graph-node-id={node.id}
      data-node-tooltip={title}
      className={`g-node-body g-symbol-${kind}${highlighted ? ' hl' : ''}${selected ? ' selected' : ''}${interactive ? '' : ' noninteractive'}`}
      data-relevant={relevant ? 1 : 0}
      data-node-id={node.id}
      data-member-count={node.member_count ?? node.width}
      data-boundary={node.is_boundary ? 'true' : undefined}
      data-expanded-group-member={expandedGroupId}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? tabIndex : undefined}
      aria-label={
        interactive
          ? `${title}. Enter to inspect details and controls; Shift+Enter to expand.`
          : undefined
      }
    >
      <SchematicOutline
        node={node}
        kind={kind}
        width={laidOutNode.width}
        height={laidOutNode.height}
        visual={visual}
        strokeWidth={strokeWidth}
        showDetails={false}
        showStack={false}
      />
      {isGroupedMemory(node, kind) && (
        <g className="g-memory-overview-details" aria-hidden="true">
          <NodeContents
            node={node}
            kind={kind}
            width={laidOutNode.width}
            height={Math.max(1, laidOutNode.height - controlsFor(node).length * 13)}
            name={name}
            detailLevel="full"
          />
        </g>
      )}
      {showOverviewIdentity && !isGroupedMemory(node, kind) && (
        <text
          className="g-overview-label"
          x={laidOutNode.width / 2}
          y={Math.max(1, laidOutNode.height - controlsFor(node).length * 13) / 2 + 4}
          textAnchor="middle"
          aria-hidden="true"
        >
          {truncate(
            nodeLabel(node),
            Math.max(4, Math.floor((laidOutNode.width - 20) / 7.2)),
          )}
        </text>
      )}
    </g>
  )
})

interface SchematicNodeShellsProps {
  graph: LaidOutGraph
  rootId: number
  relevantIds: Set<number>
  overlayIds: Set<number>
  selectedId: number | null
  portDirection: Map<number, PortDirection>
  interactive: boolean
  rovingTabStopId: number | null
  onNodeElement: (nodeId: number, element: SVGGElement | null) => void
  expandedGroupByMember: Map<number, number>
}

const SchematicNodeShells = memo(function SchematicNodeShells({
  graph,
  rootId,
  relevantIds,
  overlayIds,
  selectedId,
  portDirection,
  interactive,
  rovingTabStopId,
  onNodeElement,
  expandedGroupByMember,
}: SchematicNodeShellsProps) {
  return graph.nodes.map((laidOutNode) => (
    <SchematicNode
      key={laidOutNode.id}
      laidOutNode={laidOutNode}
      rootId={rootId}
      relevant={relevantIds.size === 0 || relevantIds.has(laidOutNode.id)}
      highlighted={overlayIds.has(laidOutNode.id)}
      selected={laidOutNode.id === selectedId}
      portDirection={portDirection.get(laidOutNode.id) ?? 'input'}
      interactive={interactive}
      tabIndex={laidOutNode.id === rovingTabStopId ? 0 : -1}
      onNodeElement={onNodeElement}
      showOverviewIdentity={graph.nodes.length <= OVERVIEW_IDENTITY_NODE_LIMIT}
      expandedGroupId={expandedGroupByMember.get(laidOutNode.id)}
    />
  ))
})

function activateGroupControl(
  event: React.KeyboardEvent<SVGGElement>,
  action: () => void,
) {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  event.stopPropagation()
  action()
}

function GroupExpansionControls({
  graph,
  expandedGroups,
  relevantIds,
  interactive,
  onExpand,
  onCollapse,
}: {
  graph: LaidOutGraph
  expandedGroups: ExpandedGroupFrame[]
  relevantIds: Set<number>
  interactive: boolean
  onExpand?: (node: GraphNode) => void
  onCollapse?: (groupId: number) => void
}) {
  if (!interactive) return null
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))
  const frames = expandedGroups.flatMap((group) => {
    const members = group.members
      .map((id) => nodeById.get(id))
      .filter((node): node is LaidOutNode => node != null)
    if (members.length === 0) return []
    const left = Math.min(...members.map((node) => node.x)) - 12
    const top = Math.min(...members.map((node) => node.y)) - 20
    const right = Math.max(...members.map((node) => node.x + node.width)) + 12
    const bottom = Math.max(...members.map((node) => node.y + node.height)) + 12
    const hasComponent = members.some((member) => member.node.kind !== 'port')
    return [{ group, left, top, right, bottom, hasComponent }]
  })

  return (
    <g className="g-group-controls">
      {frames.map(({ group, left, top, right, bottom, hasComponent }) => (
        <g
          key={`expanded-${group.id}`}
          data-expanded-group-id={group.id}
          data-relevant={
            relevantIds.size === 0 || group.members.some((id) => relevantIds.has(id)) ? 1 : 0
          }
        >
          <rect
            className="g-expanded-group-boundary"
            x={left}
            y={top}
            width={right - left}
            height={bottom - top}
            rx={8}
          />
          <text className="g-expanded-group-label" x={left + 8} y={top + 12}>
            {truncate(group.label, 28)}
          </text>
          {onCollapse && hasComponent && (
            <g
              className="g-group-toggle"
              data-group-action="collapse"
              data-group-id={group.id}
              role="button"
              tabIndex={0}
              aria-label={`Collapse group ${group.label}`}
              transform={`translate(${right - 10},${top + 10})`}
              onPointerDown={(event) => {
                event.stopPropagation()
              }}
              onPointerUp={(event) => {
                event.stopPropagation()
                onCollapse(group.id)
              }}
              onClick={(event) => {
                event.stopPropagation()
              }}
              onKeyDown={(event) => activateGroupControl(event, () => onCollapse(group.id))}
            >
              <circle className="g-group-toggle-hit" r={10} />
              <path d="M-2.5 0H2.5" />
            </g>
          )}
        </g>
      ))}
      {onExpand && graph.nodes.map((laidOutNode) => {
        if (laidOutNode.node.kind === 'port') return null
        if (laidOutNode.node.member_count == null && laidOutNode.node.members == null) return null
        return (
          <g
            key={`collapsed-${laidOutNode.id}`}
            className="g-group-toggle"
            data-group-action="expand"
            data-group-id={laidOutNode.id}
            data-relevant={
              relevantIds.size === 0 || relevantIds.has(laidOutNode.id) ? 1 : 0
            }
            role="button"
            tabIndex={0}
            aria-label={`Expand group ${laidOutNode.node.name}`}
            transform={`translate(${laidOutNode.x + laidOutNode.width},${laidOutNode.y})`}
            onPointerDown={(event) => {
              // Do not let viewport panning claim this small SVG control.
              event.stopPropagation()
            }}
            onPointerUp={(event) => {
              // SVG clicks can be retargeted after the viewport's pointer
              // gesture; commit on release after suppressing that gesture.
              event.stopPropagation()
              onExpand(laidOutNode.node)
            }}
            onClick={(event) => {
              event.stopPropagation()
            }}
            onKeyDown={(event) => activateGroupControl(event, () => onExpand(laidOutNode.node))}
          >
            <circle className="g-group-toggle-hit" r={10} />
            <path d="M-2.5 0H2.5M0 -2.5V2.5" />
          </g>
        )
      })}
    </g>
  )
}

function SchematicNodeDetails({
  laidOutNode,
  rootId,
  highlighted,
  relevant,
  selected,
  portDirection,
  pins,
  forceFull,
  detailLevel,
  onControlSelect,
}: {
  laidOutNode: LaidOutNode
  rootId: number
  highlighted: boolean
  relevant: boolean
  selected: boolean
  portDirection: PortDirection
  pins: NodePins
  forceFull: boolean
  detailLevel: Exclude<SchematicDetailLevel, 'overview'>
  onControlSelect?: (control: ControlRef, node: GraphNode) => void
}) {
  const node = laidOutNode.node
  const kind = symbolKind(node, portDirection)
  const visual = nodeVisual(node, kind, rootId, highlighted)
  const controls = controlsFor(node)
  const bodyHeight = Math.max(1, laidOutNode.height - controls.length * 13)
  const strokeWidth = selected ? 2.4 : visual.isRoot || highlighted ? 1.8 : 1.2
  const renderedLevel = forceFull ? 'full' : detailLevel
  return (
    <g
      className={`g-node-details${forceFull ? ' force-full' : ''}`}
      transform={`translate(${laidOutNode.x},${laidOutNode.y})`}
      data-node-detail-id={node.id}
      data-relevant={relevant ? 1 : 0}
      aria-hidden="true"
    >
      <SchematicOutline
        node={node}
        kind={kind}
        width={laidOutNode.width}
        height={laidOutNode.height}
        visual={visual}
        strokeWidth={strokeWidth}
        showDetails
        showStack={false}
        showOutline={false}
      />
      <NodeContents
        node={node}
        kind={kind}
        width={laidOutNode.width}
        height={bodyHeight}
        name={nodeSublabel(node)}
        detailLevel={renderedLevel}
      />
      {renderedLevel === 'full' && (kind === 'reg' || kind === 'latch') && (
        <RegisterPins
          node={node}
          pins={pins}
          width={laidOutNode.width}
          bodyHeight={bodyHeight}
        />
      )}
      {renderedLevel === 'full' && controls.length > 0 && (
        <ControlLabels
          node={node}
          width={laidOutNode.width}
          startY={bodyHeight}
          onSelect={onControlSelect}
        />
      )}
    </g>
  )
}

function SchematicNodeStack({
  laidOutNode,
  rootId,
  highlighted,
  relevant,
  selected,
  portDirection,
  forceFull,
}: {
  laidOutNode: LaidOutNode
  rootId: number
  highlighted: boolean
  relevant: boolean
  selected: boolean
  portDirection: PortDirection
  forceFull: boolean
}) {
  const node = laidOutNode.node
  // A vector port already exposes its packed range (for example [7:0]).
  // Layered silhouettes add no information and make the boundary look like a
  // group of physical components, so reserve the stack cue for components.
  if (node.kind === 'port' || (node.width ?? 0) < 2) return null
  const kind = symbolKind(node, portDirection)
  const visual = nodeVisual(node, kind, rootId, highlighted)
  const strokeWidth = selected ? 2.4 : visual.isRoot || highlighted ? 1.8 : 1.2
  return (
    <g
      className={`g-node-details${forceFull ? ' force-full' : ''}`}
      transform={`translate(${laidOutNode.x},${laidOutNode.y})`}
      data-node-stack-id={node.id}
      data-relevant={relevant ? 1 : 0}
      aria-hidden="true"
    >
      <SchematicOutline
        node={node}
        kind={kind}
        width={laidOutNode.width}
        height={laidOutNode.height}
        visual={visual}
        strokeWidth={strokeWidth}
        showDetails={false}
        showStack
        showOutline={false}
      />
    </g>
  )
}

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

interface SchematicNodeDetailOverlaysProps {
  children: ReactNode
  viewportRef: RefObject<SVGGElement | null>
  nodeById: Map<number, LaidOutNode>
  pinsById: Map<number, NodePins>
  portDirection: Map<number, PortDirection>
  mountedIds: Set<number>
  detailLevel: SchematicDetailLevel
  rootId: number
  relevantIds: Set<number>
  overlayIds: Set<number>
  selectedId: number | null
  interactive: boolean
  onControlSelect?: (control: ControlRef, node: GraphNode) => void
}

// Rich node detail is a viewport-bounded overlay over stable accessible shells.
// Focus is delegated here so moving between nodes reconciles only the old/new
// overlay rather than remapping every shell in a large graph.
const SchematicNodeDetailOverlays = memo(function SchematicNodeDetailOverlays({
  children,
  viewportRef,
  nodeById,
  pinsById,
  portDirection,
  mountedIds,
  detailLevel,
  rootId,
  relevantIds,
  overlayIds,
  selectedId,
  interactive,
  onControlSelect,
}: SchematicNodeDetailOverlaysProps) {
  const [focusedElement, setFocusedElement] = useState<SVGGElement | null>(null)

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const onFocusIn = (event: FocusEvent) => {
      setFocusedElement(graphNodeElement(event.target, viewport))
    }
    const onFocusOut = (event: FocusEvent) => {
      setFocusedElement(graphNodeElement(event.relatedTarget, viewport))
    }
    viewport.addEventListener('focusin', onFocusIn)
    viewport.addEventListener('focusout', onFocusOut)
    return () => {
      viewport.removeEventListener('focusin', onFocusIn)
      viewport.removeEventListener('focusout', onFocusOut)
    }
  }, [viewportRef])

  const focusedId = graphNodeId(focusedElement)
  const renderedIds = new Set(mountedIds)
  if (selectedId != null) renderedIds.add(selectedId)
  if (focusedId != null) renderedIds.add(focusedId)

  const detailNodes = [...renderedIds].flatMap((nodeId) => {
    const laidOutNode = nodeById.get(nodeId)
    return laidOutNode ? [{ nodeId, laidOutNode }] : []
  })

  return (
    <>
      {detailNodes.map(({ nodeId, laidOutNode }) => (
        <SchematicNodeStack
          key={nodeId}
          laidOutNode={laidOutNode}
          rootId={rootId}
          highlighted={overlayIds.has(nodeId)}
          relevant={relevantIds.size === 0 || relevantIds.has(nodeId)}
          selected={nodeId === selectedId}
          portDirection={portDirection.get(nodeId) ?? 'input'}
          forceFull={nodeId === selectedId || nodeId === focusedId}
        />
      ))}
      {children}
      {detailNodes.map(({ nodeId, laidOutNode }) => (
        <SchematicNodeDetails
          key={nodeId}
          laidOutNode={laidOutNode}
          rootId={rootId}
          highlighted={overlayIds.has(nodeId)}
          relevant={relevantIds.size === 0 || relevantIds.has(nodeId)}
          selected={nodeId === selectedId}
          portDirection={portDirection.get(nodeId) ?? 'input'}
          pins={pinsById.get(nodeId) ?? EMPTY_NODE_PINS}
          forceFull={nodeId === selectedId || nodeId === focusedId}
          detailLevel={detailLevel === 'overview' ? 'compact' : detailLevel}
          onControlSelect={interactive ? onControlSelect : undefined}
        />
      ))}
    </>
  )
})

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

interface SelectedSchematicEdgeBatch {
  key: string
  d: string
  count: number
  indexes: number[]
  relevant: boolean
  control: boolean
  isBus: boolean
}

interface SelectedSchematicArrowBatch {
  key: string
  d: string
  count: number
  relevant: boolean
  control: boolean
}

interface PreparedSelectedSchematicEdges {
  batches: SelectedSchematicEdgeBatch[]
  arrows: SelectedSchematicArrowBatch[]
}

interface PreparedSchematicEdge {
  index: number
  from: number
  to: number
  points: Point[]
  title: string
  bits: number
  netBits: number[]
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
  incidentByNode: Map<number, PreparedSchematicEdge[]>
}

const EMPTY_PREPARED_SCHEMATIC_EDGES: PreparedSchematicEdge[] = []

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
  highlightedBits,
  extendOverlayToBoundaryNets,
}: {
  edges: LaidOutEdge[]
  nodeById: Map<number, LaidOutNode>
  relevantIds: Set<number>
  overlayIds: Set<number>
  highlightedBits: Set<number>
  extendOverlayToBoundaryNets: boolean
}): PreparedSchematicEdges {
  const prepared: PreparedSchematicEdge[] = []
  const batchBuilders = new Map<string, SchematicEdgeBatch & { paths: string[] }>()
  const arrowBuilders = new Map<string, SchematicArrowBatch & { paths: string[] }>()
  const incidentByNode = new Map<number, PreparedSchematicEdge[]>()

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
    const exactBitHighlighted = laidOutEdge.edge.bits.some((bit) =>
      highlightedBits.has(bit),
    )
    const highlighted =
      exactBitHighlighted ||
      (highlightedBits.size === 0 &&
        ((fromHighlighted && toHighlighted) ||
          (extendOverlayToBoundaryNets &&
            relevant &&
            ((fromHighlighted && toKind != null && toKind !== 'cell') ||
              (toHighlighted && fromKind != null && fromKind !== 'cell')))))
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
      from: laidOutEdge.from,
      to: laidOutEdge.to,
      points,
      title,
      bits,
      netBits: laidOutEdge.edge.bits,
      isBus,
      relevant,
      control,
      highlighted,
      batchKey,
      mid,
    }
    prepared.push(edge)
    for (const nodeId of laidOutEdge.from === laidOutEdge.to
      ? [laidOutEdge.from]
      : [laidOutEdge.from, laidOutEdge.to]) {
      const incident = incidentByNode.get(nodeId)
      if (incident) incident.push(edge)
      else incidentByNode.set(nodeId, [edge])
    }

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
  return { edges: prepared, batches, arrows, incidentByNode }
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

function prepareSelectedSchematicEdges(
  edges: PreparedSchematicEdge[],
): PreparedSelectedSchematicEdges {
  const batchBuilders = new Map<
    string,
    Omit<SelectedSchematicEdgeBatch, 'd'> & { paths: string[] }
  >()
  const arrowBuilders = new Map<
    string,
    Omit<SelectedSchematicArrowBatch, 'd'> & { paths: string[] }
  >()

  for (const edge of edges) {
    const line = pathD(edge.points)
    if (line) {
      const key = edgeBatchKey(edge.relevant, edge.control, edge.isBus, true)
      const batch = batchBuilders.get(key) ?? {
        key,
        count: 0,
        indexes: [],
        relevant: edge.relevant,
        control: edge.control,
        isBus: edge.isBus,
        paths: [],
      }
      batch.count += 1
      batch.indexes.push(edge.index)
      batch.paths.push(line)
      batchBuilders.set(key, batch)
    }

    const arrow = edgeArrowD(edge.points, edge.isBus ? 2.4 : 2.2)
    if (arrow) {
      const key =
        `${edge.relevant ? 1 : 0}${edge.control ? 1 : 0}${edge.isBus ? 1 : 0}`
      const batch = arrowBuilders.get(key) ?? {
        key,
        count: 0,
        relevant: edge.relevant,
        control: edge.control,
        paths: [],
      }
      batch.count += 1
      batch.paths.push(arrow)
      arrowBuilders.set(key, batch)
    }
  }

  return {
    batches: [...batchBuilders.values()].map(({ paths, ...batch }) => ({
      ...batch,
      d: paths.join(' '),
    })),
    arrows: [...arrowBuilders.values()].map(({ paths, ...batch }) => ({
      ...batch,
      d: paths.join(' '),
    })),
  }
}

const SelectedSchematicEdges = memo(function SelectedSchematicEdges({
  edges,
}: {
  edges: PreparedSchematicEdge[]
}) {
  if (edges.length === 0) return null
  const prepared = prepareSelectedSchematicEdges(edges)
  return (
    <g className="g-selected-edge-layer" aria-hidden="true">
      {prepared.batches.map((batch) => (
        <path
          key={batch.key}
          className={edgeClassName(batch.control, batch.isBus, true)}
          d={batch.d}
          data-selected-edge-count={batch.count}
          data-selected-edge-indices={batch.indexes.join(',')}
          data-relevant={batch.relevant ? 1 : 0}
        />
      ))}
      {prepared.arrows.map((batch) => (
        <path
          key={batch.key}
          className={`g-edge-arrows${batch.control ? ' control' : ''} hl`}
          d={batch.d}
          data-selected-arrow-count={batch.count}
          data-relevant={batch.relevant ? 1 : 0}
        />
      ))}
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
  cells: Map<string, EdgeHitSegment[]>
}

interface EdgeTooltipState {
  edgeIndex: number
  title: string
  left: number
  top: number
}

function buildEdgeHitIndex(edges: PreparedSchematicEdge[]): EdgeHitIndex {
  const cells = new Map<string, EdgeHitSegment[]>()
  let segmentId = 0
  for (const edge of edges) {
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
  return { cells }
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
  point: Point,
  tolerance: number,
): PreparedSchematicEdge | null {
  const minCellX = Math.floor((point.x - tolerance) / EDGE_HIT_CELL_SIZE)
  const maxCellX = Math.floor((point.x + tolerance) / EDGE_HIT_CELL_SIZE)
  const minCellY = Math.floor((point.y - tolerance) / EDGE_HIT_CELL_SIZE)
  const maxCellY = Math.floor((point.y + tolerance) / EDGE_HIT_CELL_SIZE)
  const visitedSegments = new Set<number>()
  const toleranceSquared = tolerance * tolerance
  let best: { edge: PreparedSchematicEdge; distanceSquared: number } | null = null
  for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
    for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
      for (const segment of index.cells.get(edgeHitCellKey(cellX, cellY)) ?? []) {
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

interface NodeTooltipState {
  nodeId: number
  title: string
  left: number
  top: number
}

const SchematicNodeTooltip = memo(function SchematicNodeTooltip({
  active,
  stageRef,
  svgRef,
  hideRef,
}: {
  active: boolean
  stageRef: RefObject<HTMLDivElement | null>
  svgRef: RefObject<SVGSVGElement | null>
  hideRef: MutableRefObject<(() => void) | null>
}) {
  const [tooltip, setTooltip] = useState<NodeTooltipState | null>(null)

  useEffect(() => {
    setTooltip(null)
    if (!active) return
    const svg = svgRef.current
    const stage = stageRef.current
    if (!svg || !stage) return
    let activeNode: SVGGElement | null = null
    const hide = () => {
      activeNode = null
      setTooltip(null)
    }
    hideRef.current = hide
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || svg.classList.contains('panning')) {
        hide()
        return
      }
      const node = graphNodeElement(event.target, svg)
      if (node === activeNode) return
      activeNode = node
      const title = node?.dataset.nodeTooltip
      if (!node || !title) {
        setTooltip(null)
        return
      }
      const stageRect = stage.getBoundingClientRect()
      const nodeRect = node.getBoundingClientRect()
      setTooltip({
        nodeId: graphNodeId(node) ?? -1,
        title,
        left: Math.min(
          Math.max(8, nodeRect.left - stageRect.left + nodeRect.width / 2),
          Math.max(8, stageRect.width - 272),
        ),
        top: Math.min(
          Math.max(8, nodeRect.top - stageRect.top - 30),
          Math.max(8, stageRect.height - 44),
        ),
      })
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
    }
  }, [active, hideRef, stageRef, svgRef])

  if (!tooltip) return null
  return (
    <div
      className="g-edge-tooltip g-node-tooltip"
      role="tooltip"
      data-node-id={tooltip.nodeId}
      style={{ left: tooltip.left, top: tooltip.top }}
    >
      {tooltip.title}
    </div>
  )
})

const SchematicEdgeTooltip = memo(function SchematicEdgeTooltip({
  active,
  edges,
  geometryKey,
  stageRef,
  svgRef,
  viewportRef,
  hideRef,
  suppressClickRef,
  onSelect,
}: {
  active: boolean
  edges: PreparedSchematicEdge[]
  geometryKey: object
  stageRef: RefObject<HTMLDivElement | null>
  svgRef: RefObject<SVGSVGElement | null>
  viewportRef: RefObject<SVGGElement | null>
  hideRef: MutableRefObject<(() => void) | null>
  suppressClickRef: MutableRefObject<boolean>
  onSelect?: (bits: number[]) => void
}) {
  const hitIndexRef = useRef<{
    geometryKey: object
    index: EdgeHitIndex
  } | null>(null)
  const geometryEdgesRef = useRef({ geometryKey, edges })
  if (geometryEdgesRef.current.geometryKey !== geometryKey) {
    geometryEdgesRef.current = { geometryKey, edges }
  }
  if (hitIndexRef.current?.geometryKey !== geometryKey) hitIndexRef.current = null
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
    let pending: { clientX: number; clientY: number } | null = null
    let tooltipVisible = false
    const ensureHitIndex = () => {
      if (hitIndexRef.current?.geometryKey === geometryKey) return hitIndexRef.current.index
      const index = buildEdgeHitIndex(geometryEdgesRef.current.edges)
      hitIndexRef.current = { geometryKey, index }
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
    const edgeAt = (clientX: number, clientY: number) => {
      const matrix = viewport.getScreenCTM()
      if (!matrix) return null
      const scale = Math.hypot(matrix.a, matrix.b)
      if (!Number.isFinite(scale) || scale <= 0) return null
      const graphPoint = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse())
      return hitTestEdge(
        ensureHitIndex(),
        graphPoint,
        EDGE_HIT_TOLERANCE_PX / scale,
      )
    }
    const resolvePending = () => {
      frame = null
      const current = pending
      pending = null
      if (!current || svg.classList.contains('panning')) {
        hide()
        return
      }
      const edge = edgeAt(current.clientX, current.clientY)
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
      pending = { clientX: event.clientX, clientY: event.clientY }
      if (frame == null) frame = window.requestAnimationFrame(resolvePending)
    }
    const onClick = (event: MouseEvent) => {
      if (!onSelect || svg.classList.contains('panning')) return
      if (suppressClickRef.current) {
        return
      }
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('.g-node-body')) return
      const edge = edgeAt(event.clientX, event.clientY)
      if (!edge) return
      event.stopPropagation()
      onSelect(edge.netBits)
    }

    svg.addEventListener('pointermove', onPointerMove)
    svg.addEventListener('pointerleave', hide)
    svg.addEventListener('pointerdown', hide)
    svg.addEventListener('wheel', hide)
    svg.addEventListener('click', onClick)
    return () => {
      svg.removeEventListener('pointermove', onPointerMove)
      svg.removeEventListener('pointerleave', hide)
      svg.removeEventListener('pointerdown', hide)
      svg.removeEventListener('wheel', hide)
      svg.removeEventListener('click', onClick)
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
  }, [
    active,
    geometryKey,
    hideRef,
    onSelect,
    stageRef,
    suppressClickRef,
    svgRef,
    viewportRef,
  ])

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
  highlightedBits = EMPTY_HIGHLIGHTED_BITS,
  extendOverlayToBoundaryNets = false,
  selectedId,
  interactive,
  onSelect,
  onEdgeSelect,
  onControlSelect,
  onExpand,
  onExpandGroup,
  onCollapseGroup,
  expandedGroups = EMPTY_EXPANDED_GROUPS,
  active,
  fitNonce,
}: Props) {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const viewportRef = useRef<SVGGElement | null>(null)
  const hideEdgeTooltipRef = useRef<(() => void) | null>(null)
  const hideNodeTooltipRef = useRef<(() => void) | null>(null)
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
  const mountedDetailsGraph = useRef(graph)
  const [mountedDetails, setMountedDetails] = useState(() => ({
    graph,
    ...initialDetailState(graph),
  }))

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
        const target = nodeById.get(edge.to)?.node
        const targetKind = target ? symbolKind(target) : null
        if (
          edge.edge.control ||
          ((targetKind === 'reg' || targetKind === 'latch') &&
            isRegisterControlPin(edge.edge.to_port))
        ) {
          toPins.controlInputs.set(
            edge.edge.to_port,
            controlRoleForPin(edge.edge.to_port),
          )
        }
      }
    }

    const controlDrivers = new Set<number>()
    for (const laidOutNode of graph.nodes) {
      for (const control of controlsFor(laidOutNode.node)) {
        for (const driver of controlDriverIds(control)) {
          controlDrivers.add(driver)
        }
      }
    }
    const portNodes = graph.nodes.filter(
      (laidOutNode) => laidOutNode.node.kind === 'port',
    )
    const portDirection = inferPortDirections(
      portNodes.map((laidOutNode) => laidOutNode.id),
      graph.edges,
      controlDrivers,
      new Map(
        portNodes.flatMap((laidOutNode) =>
          laidOutNode.node.port_direction
            ? [[laidOutNode.id, laidOutNode.node.port_direction]]
            : [],
        ),
      ),
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
  const expandedGroupByMember = useMemo(() => new Map(
    expandedGroups.flatMap((group) =>
      group.members.map((member) => [member, group.id] as const),
    ),
  ), [expandedGroups])
  const preparedEdges = useMemo(
    () => prepareSchematicEdges({
      edges: graph.edges,
      nodeById: metadata.nodeById,
      relevantIds,
      overlayIds,
      highlightedBits,
      extendOverlayToBoundaryNets,
    }),
    [
      extendOverlayToBoundaryNets,
      graph.edges,
      highlightedBits,
      metadata.nodeById,
      overlayIds,
      relevantIds,
    ],
  )
  const selectedEdges = useMemo(() => {
    if (selectedId == null) return EMPTY_PREPARED_SCHEMATIC_EDGES
    const selectedNode = metadata.nodeById.get(selectedId)?.node
    const endpointIds = [selectedId, ...(selectedNode?.members ?? [])]
    const seen = new Set<number>()
    const edges: PreparedSchematicEdge[] = []
    for (const endpointId of endpointIds) {
      for (const edge of preparedEdges.incidentByNode.get(endpointId) ?? []) {
        if (seen.has(edge.index)) continue
        seen.add(edge.index)
        edges.push(edge)
      }
    }
    return edges
  }, [metadata.nodeById, preparedEdges.incidentByNode, selectedId])

  const clearDetailRestore = useCallback(() => {
    if (detailRestoreTimer.current == null) return
    window.clearTimeout(detailRestoreTimer.current)
    detailRestoreTimer.current = null
  }, [])

  const updateMountedDetails = useCallback((level: SchematicDetailLevel) => {
    const currentGraph = graphRef.current
    mountedDetailsGraph.current = currentGraph
    let ids = new Set<number>()
    if (level !== 'overview') {
      const rect = stageRef.current?.getBoundingClientRect()
      ids = rect && rect.width > 0 && rect.height > 0
        ? visibleDetailNodeIds(
            currentGraph,
            transformRef.current,
            rect.width,
            rect.height,
          )
        : initialDetailState(currentGraph).ids
    }
    setMountedDetails((previous) =>
      previous.graph === currentGraph &&
      previous.level === level &&
      sameNodeIds(previous.ids, ids)
        ? previous
        : { graph: currentGraph, level, ids },
    )
  }, [])

  const applyDetailLevel = useCallback((next: SchematicDetailLevel) => {
    detailLevel.current = next
    viewportRef.current?.setAttribute('data-detail-level', next)
    updateMountedDetails(next)
  }, [updateMountedDetails])

  // The graph can contain thousands of SVG elements. Keep pointer-frequency
  // pan/zoom updates outside React so moving the viewport only mutates this
  // outer group instead of reconciling every edge and node. Less detail applies
  // immediately; restoring richer labels waits until the gesture is idle so a
  // 2,000-node style/layout transition never lands in the middle of a frame.
  const applyTransform = useCallback((next: ViewportTransform) => {
    hideEdgeTooltipRef.current?.()
    hideNodeTooltipRef.current?.()
    transformRef.current = next
    viewportRef.current?.setAttribute('transform', viewportTransformAttribute(next))

    const current = detailLevel.current
    if (current == null) {
      applyDetailLevel(initialDetailLevel(next.k))
      return
    }
    if (mountedDetailsGraph.current !== graphRef.current) {
      // A replacement graph must derive its overlay IDs from the preserved
      // viewport, not the nominal fit used to keep server/static markup useful.
      updateMountedDetails(current)
    }
    const desired = nextDetailLevel(next.k, current)
    clearDetailRestore()
    if (DETAIL_LEVEL_RANK[desired] < DETAIL_LEVEL_RANK[current]) {
      applyDetailLevel(desired)
      return
    }
    if (desired === current && desired === 'overview') return
    detailRestoreTimer.current = window.setTimeout(() => {
      detailRestoreTimer.current = null
      const activeLevel = detailLevel.current
      if (activeLevel == null) return
      const idleLevel = nextDetailLevel(transformRef.current.k, activeLevel)
      if (DETAIL_LEVEL_RANK[idleLevel] >= DETAIL_LEVEL_RANK[activeLevel]) {
        applyDetailLevel(idleLevel)
      }
    }, DETAIL_RESTORE_IDLE_MS)
  }, [applyDetailLevel, clearDetailRestore, updateMountedDetails])

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
    const wrapper = stage.parentElement
    const bannerRect = wrapper
      ?.querySelector<HTMLElement>('.graph-banner')
      ?.getBoundingClientRect()
    const cardRect = wrapper
      ?.querySelector<HTMLElement>('.node-card')
      ?.getBoundingClientRect()
    const shortcutRect = stage
      .querySelector<HTMLElement>('.graph-shortcuts')
      ?.getBoundingClientRect()
    const zoomRect = stage
      .querySelector<HTMLElement>('.zoom-controls')
      ?.getBoundingClientRect()
    const bottomOverlayTop = Math.min(
      shortcutRect?.top ?? Number.POSITIVE_INFINITY,
      zoomRect?.top ?? Number.POSITIVE_INFINITY,
    )
    const next = fitViewportToContent(
      rect.width,
      rect.height,
      currentGraph.width,
      currentGraph.height,
      40,
      1.5,
      {
        top: bannerRect && bannerRect.height > 0
          ? Math.max(0, bannerRect.bottom - rect.top + FIT_OVERLAY_GAP)
          : 0,
        right: cardRect && cardRect.width > 0
          ? Math.max(0, rect.right - cardRect.left + FIT_OVERLAY_GAP)
          : 0,
        bottom: Number.isFinite(bottomOverlayTop)
          ? Math.max(0, rect.bottom - bottomOverlayTop + FIT_OVERLAY_GAP)
          : 0,
      },
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
      else applyTransform(transformRef.current)
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
  }, [active, applyTransform, fit])

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

  const initialDetails = mountedDetails.graph === graph
    ? null
    : initialDetailState(graph)
  const renderedDetailIds = initialDetails?.ids ?? mountedDetails.ids
  const renderedDetailLevel = initialDetails?.level ?? mountedDetails.level

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
          <SelectedSchematicEdges edges={selectedEdges} />

          <SchematicNodeDetailOverlays
            viewportRef={viewportRef}
            nodeById={metadata.nodeById}
            pinsById={metadata.pinsById}
            portDirection={metadata.portDirection}
            mountedIds={renderedDetailIds}
            detailLevel={renderedDetailLevel}
            rootId={rootId}
            relevantIds={relevantIds}
            overlayIds={overlayIds}
            selectedId={selectedId}
            interactive={interactive}
            onControlSelect={onControlSelect}
          >
            <SchematicNodeShells
              graph={graph}
              rootId={rootId}
              relevantIds={relevantIds}
              overlayIds={overlayIds}
              selectedId={selectedId}
              portDirection={metadata.portDirection}
              interactive={interactive}
              rovingTabStopId={rovingTabStopId}
              onNodeElement={setNodeElement}
              expandedGroupByMember={expandedGroupByMember}
            />
          </SchematicNodeDetailOverlays>

          <SchematicPinOverlays
            viewportRef={viewportRef}
            nodeById={metadata.nodeById}
            pinsById={metadata.pinsById}
            portDirection={metadata.portDirection}
            selectedId={selectedId}
          />

          <GroupExpansionControls
            graph={graph}
            expandedGroups={expandedGroups}
            relevantIds={relevantIds}
            interactive={interactive}
            onExpand={onExpandGroup}
            onCollapse={onCollapseGroup}
          />
        </g>
      </svg>

      <SchematicEdgeTooltip
        active={active}
        edges={preparedEdges.edges}
        geometryKey={graph.edges}
        stageRef={stageRef}
        svgRef={svgRef}
        viewportRef={viewportRef}
        hideRef={hideEdgeTooltipRef}
        suppressClickRef={suppressClick}
        onSelect={interactive ? onEdgeSelect : undefined}
      />

      <SchematicNodeTooltip
        active={active}
        stageRef={stageRef}
        svgRef={svgRef}
        hideRef={hideNodeTooltipRef}
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
