import { memo, useEffect, useState, type ReactNode, type RefObject } from 'react'
import {
  REG_BODY_HEIGHT,
  REG_CLOCK_Y_FRAC,
  REG_DATA_IN_Y_FRAC,
  REG_DATA_OUT_Y_FRAC,
  registerControlYFraction,
} from '../../lib/graph/nodeGeometry'
import type { LaidOutGraph, LaidOutNode } from '../../lib/graph/elkGraph'
import { groupBadgeText, nodeLabel, nodeSublabel, shortNetName } from '../../lib/graph/prettyType'
import {
  arithGlyph,
  boxBadge,
  bubbleAt,
  controlCaption,
  controlsFor,
  inputArcPath,
  inputBubbleAt,
  isSpecialPrimitive,
  registerClockPath,
  shapePath,
  symbolKind,
  type PortDirection,
  type SymbolKind,
} from '../../lib/graph/symbols'
import { truncate } from '../../lib/text'
import type { ControlRef, ControlRole, GraphNode } from '../../types'
import type { SchematicDetailLevel } from './useDetailLevel'

const OVERVIEW_IDENTITY_NODE_LIMIT = 250

interface RegisterControlPin {
  pin: string
  role: ControlRole
}

export interface NodePins {
  incoming: string[]
  outgoing: string[]
  controlInputs: RegisterControlPin[]
}

const EMPTY_NODE_PINS: NodePins = { incoming: [], outgoing: [], controlInputs: [] }
interface NodeVisual {
  fill: string
  stroke: string
  dashed: boolean
  isRoot: boolean
}

function nodeVisual(
  node: GraphNode,
  kind: SymbolKind,
  rootId: number,
  highlighted: boolean,
): NodeVisual {
  const isRoot = node.id === rootId || Boolean(node.is_root)
  let fill = 'var(--schematic-gate-fill)'
  let stroke = 'var(--schematic-gate-stroke)'

  if (kind === 'port-in' || kind === 'port-out') {
    fill = 'color-mix(in srgb, var(--green) 14%, var(--bg-2))'
    stroke = 'var(--green)'
  } else if (kind === 'const') {
    fill = 'var(--schematic-gate-fill)'
    stroke = 'var(--schematic-gate-stroke)'
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

function groupStackOffsets(node: GraphNode): number[] {
  const groupWidth = node.width ?? 0
  return groupWidth >= 2 ? (groupWidth >= 4 ? [6, 3] : [3.5]) : []
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
  const stackOffsets = groupStackOffsets(node)
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
// shows its reset. Every edge is routed to the matching pin in elkGraph.ts.
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
  // Pin positions must use the same primary body height as nodeGeometry.ts (which
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
  dimmed: boolean
  portDirection: PortDirection
  interactive: boolean
  tabIndex: 0 | -1
  onNodeElement: (nodeId: number, element: SVGGElement | null) => void
  showOverviewIdentity: boolean
  expandedGroupId?: number
}

export type GraphNavigationKey =
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'ArrowUp'
  | 'ArrowDown'
  | 'Home'
  | 'End'

export const GRAPH_NAVIGATION_KEYS = new Set<string>([
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
  dimmed,
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
      className={`g-node-body g-symbol-${kind}${highlighted ? ' hl' : ''}${selected ? ' selected' : ''}${dimmed ? ' g-dimmed' : ''}${interactive ? '' : ' noninteractive'}`}
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
  relatedNodeIds: Set<number>
  selectionActive: boolean
  portDirection: Map<number, PortDirection>
  interactive: boolean
  rovingTabStopId: number | null
  onNodeElement: (nodeId: number, element: SVGGElement | null) => void
  expandedGroupByMember: Map<number, number>
}

export const SchematicNodeShells = memo(function SchematicNodeShells({
  graph,
  rootId,
  relevantIds,
  overlayIds,
  selectedId,
  relatedNodeIds,
  selectionActive,
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
      dimmed={selectionActive && !relatedNodeIds.has(laidOutNode.id)}
      portDirection={portDirection.get(laidOutNode.id) ?? 'input'}
      interactive={interactive}
      tabIndex={laidOutNode.id === rovingTabStopId ? 0 : -1}
      onNodeElement={onNodeElement}
      showOverviewIdentity={graph.nodes.length <= OVERVIEW_IDENTITY_NODE_LIMIT}
      expandedGroupId={expandedGroupByMember.get(laidOutNode.id)}
    />
  ))
})

function SchematicNodeDetails({
  laidOutNode,
  rootId,
  highlighted,
  relevant,
  selected,
  dimmed,
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
  dimmed: boolean
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
      className={`g-node-details${forceFull ? ' force-full' : ''}${dimmed ? ' g-dimmed' : ''}`}
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
  dimmed,
  portDirection,
  forceFull,
}: {
  laidOutNode: LaidOutNode
  rootId: number
  highlighted: boolean
  relevant: boolean
  selected: boolean
  dimmed: boolean
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
      className={`g-node-details${forceFull ? ' force-full' : ''}${dimmed ? ' g-dimmed' : ''}`}
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

// Shared by sibling graph interaction components without owning render state.
// eslint-disable-next-line react/only-export-components
export function graphNodeElement(
  target: EventTarget | null,
  boundary: Element,
): SVGGElement | null {
  if (!(target instanceof Element)) return null
  const node = target.closest<SVGGElement>('.g-node-body')
  return node && boundary.contains(node) ? node : null
}

// Shared by sibling graph interaction components without owning render state.
// eslint-disable-next-line react/only-export-components
export function graphNodeId(element: SVGGElement | null): number | null {
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
  relatedNodeIds: Set<number>
  selectionActive: boolean
  interactive: boolean
  onControlSelect?: (control: ControlRef, node: GraphNode) => void
}

// Rich node detail is a viewport-bounded overlay over stable accessible shells.
// Focus is delegated here so moving between nodes reconciles only the old/new
// overlay rather than remapping every shell in a large graph.
export const SchematicNodeDetailOverlays = memo(function SchematicNodeDetailOverlays({
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
  relatedNodeIds,
  selectionActive,
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
          dimmed={selectionActive && !relatedNodeIds.has(nodeId)}
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
          dimmed={selectionActive && !relatedNodeIds.has(nodeId)}
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
export const SchematicPinOverlays = memo(function SchematicPinOverlays({
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
