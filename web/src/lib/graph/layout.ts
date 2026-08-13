// Converts a Subgraph into an ELK layered layout via the worker, and back into
// positioned nodes + routed edges for SVG rendering.

import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api'
import type {
  BoundaryMember,
  ControlRole,
  EdgeBoundaryMember,
  GraphEdge,
  GraphNode,
  Subgraph,
} from '../../types'
import type { ElkRequest, ElkResponse } from '../../workers/elk.worker'
import {
  MAX_GRAPH_EDGES,
  MAX_GROUP_EXPANSION_RENDER_NODES,
} from './graphLimits'
import { groupBadgeText, nodeLabel, nodeSublabel } from './prettyType'
import {
  controlCaption,
  controlDriverIds,
  controlsFor,
  inferPortBoundaryRoles,
  symbolKind,
  type PortBoundaryRole,
} from './symbols'

export interface Point {
  x: number
  y: number
}

export interface LaidOutNode {
  id: number
  x: number
  y: number
  width: number
  height: number
  node: GraphNode
}

export interface LaidOutEdge {
  from: number
  to: number
  points: Point[]
  edge: GraphEdge
}

export interface LaidOutGraph {
  nodes: LaidOutNode[]
  edges: LaidOutEdge[]
  groups?: LaidOutGroup[]
  width: number
  height: number
}

export interface LaidOutGroup {
  id: number
  x: number
  y: number
  width: number
  height: number
}

/**
 * A new projection is a different sub-schematic, so frame exactly the cells it
 * shows. Overlap with the previous projection does not make the retained camera
 * meaningful: the new cone can sit anywhere in the old view, or extend past it.
 * Only an additive change to the same projection keeps its camera, which
 * `preserveViewportAnchor` handles.
 */
export function shouldRefitProjection(
  sameDesign: boolean,
  sameProjection: boolean,
): boolean {
  return !sameDesign || !sameProjection
}

export interface ExpandedGroupLayout {
  id: number
  members: number[]
  /** Height of the collapsed schematic that the user expanded from. */
  referenceHeight?: number
}

export interface LayoutInputNode {
  id: number
  baseWidth: number
  baseHeight: number
  controlHeight: number
  register: boolean
  boundary: PortBoundaryRole
  boundaryMembers?: BoundaryMember[]
}

export interface LayoutInputEdge {
  from: number
  to: number
  fromPort: string
  toPort: string
  control: boolean
  /**
   * Net bits this edge carries. One driver pin can emit several distinct nets --
   * the slices of a bus -- so the pin alone does not identify a net. Empty or
   * absent when the source has no bit information.
   */
  bits?: number[]
  sourceBoundaryMembers?: EdgeBoundaryMember[]
  targetBoundaryMembers?: EdgeBoundaryMember[]
}

export interface LayoutInput {
  nodes: LayoutInputNode[]
  edges: LayoutInputEdge[]
  groups?: ExpandedGroupLayout[]
}

export const MAX_GLOBAL_LAYOUT_COMPONENTS = 32
export const EXPANDED_GROUP_VERTICAL_LIMIT_MULTIPLIER = 2
const EXPANDED_GROUP_NODE_SPACING = 18
// The header band leaves room for the group label; the remaining sides only
// need the gutter that boundary nets use to reach their member pins.
const EXPANDED_GROUP_TOP_PADDING = 30
const EXPANDED_GROUP_SIDE_PADDING = 16
const EXPANDED_GROUP_VERTICAL_PADDING =
  EXPANDED_GROUP_TOP_PADDING + EXPANDED_GROUP_SIDE_PADDING

function expandedGroupSingleColumnHeight(
  members: Array<{ height?: number }>,
): number {
  return (
    EXPANDED_GROUP_VERTICAL_PADDING +
    members.reduce((height, member) => height + (member.height ?? 0), 0) +
    Math.max(0, members.length - 1) * EXPANDED_GROUP_NODE_SPACING
  )
}

function shouldStackExpandedGroup(
  group: ExpandedGroupLayout,
  members: Array<{ height?: number }>,
): boolean {
  if (group.referenceHeight == null) return members.length <= 16
  return (
    expandedGroupSingleColumnHeight(members) <=
    group.referenceHeight * EXPANDED_GROUP_VERTICAL_LIMIT_MULTIPLIER
  )
}

function expandedGroupColumnCount(
  group: ExpandedGroupLayout,
  members: Array<{ width?: number; height?: number }>,
): number {
  if (shouldStackExpandedGroup(group, members)) return 1
  // Column count deliberately does not chase a height target. A grid's height is
  // set by how many nets cross its channels, not by how the cells are arranged,
  // so trading rows for columns buys back almost nothing vertically while making
  // the block far wider. `EXPANDED_GROUP_VERTICAL_LIMIT_MULTIPLIER` still decides
  // stacked-vs-grid above, where a single column's height really is predictable.
  // Here we only shape the block, aiming for a roughly square array.
  const cellWidth = Math.max(1, ...members.map((member) => member.width ?? 0))
  const cellHeight = Math.max(1, ...members.map((member) => member.height ?? 0))
  const columns = Math.round(
    Math.sqrt((members.length * cellHeight) / cellWidth),
  )
  // At least two columns: reaching here means one column was already judged too
  // tall, so a single-column "grid" would just rebuild the shape we rejected.
  return Math.min(members.length, Math.max(2, columns))
}

// ---------------------------------------------------------------------------
// Perfect-lattice grid for expanded groups.
//
// Members sit on a uniform cell grid: every column the same width, every row
// the same height, so the block reads as a real array. Wires get their own
// space instead of competing with the members for it -- a horizontal channel at
// each row boundary carries nets that must cross columns, and the gutter beside
// each column carries the vertical hop onto the pin. Channel height is sized by
// how many nets actually cross there, so the block only grows where wires
// really need the room.
// ---------------------------------------------------------------------------

// Identifies the net an edge carries, so grid channels can allocate one track
// per net instead of one per sink: a high-fanout net costs a single track.
//
// The driver pin alone is not enough. A grouped bus driver emits one edge per
// sink from the same pin, each carrying a different slice of the bus -- those
// are distinct nets and must not share a track, or the picture would claim they
// are electrically connected. The bit set is what separates them. When an edge
// carries no bits there is nothing to prove two edges are the same net, so each
// falls back to its own key rather than risking a false merge.
const netKeyOf = (edge: LayoutInputEdge): string =>
  edge.bits != null && edge.bits.length > 0
    ? `${edge.from}#${edge.fromPort}#${[...edge.bits].sort((a, b) => a - b).join(',')}`
    : `edge:${edge.from}#${edge.fromPort}#${edge.to}#${edge.toPort}`

const GRID_GUTTER = 26          // clear space between two columns of cells
const GRID_TRACK_PITCH = 7      // vertical distance between wires in a channel
const GRID_CHANNEL_MARGIN = 6   // clearance at each end of a channel
const GRID_MIN_CHANNEL = 16     // channel height when nothing crosses there

interface GridLattice {
  columnCount: number
  rowCount: number
  cellWidth: number
  cellHeight: number
  width: number
  height: number
  /** Top-left of each member cell, relative to the frame. */
  cellOf: (index: number) => { x: number; y: number }
  /** x of the vertical gutter immediately left of a column. */
  gutterLeftOf: (column: number) => number
  /** x of the vertical gutter immediately right of a column. */
  gutterRightOf: (column: number) => number
  /** y of the track a crossing net rides, relative to the frame. */
  trackY: (portId: string) => number | undefined
  columnOf: (index: number) => number
  rowOf: (index: number) => number
}

function planGridLattice(
  memberIds: number[],
  columnCount: number,
  sizeOf: (member: number) => { width: number; height: number },
  westPorts: Array<{ portId: string; member: number; net: string }>,
  eastPorts: Array<{ portId: string; member: number; net: string }>,
): GridLattice {
  const rowCount = Math.max(1, Math.ceil(memberIds.length / columnCount))
  const cellWidth = Math.max(
    1,
    ...memberIds.map((member) => sizeOf(member).width),
  )
  const cellHeight = Math.max(
    1,
    ...memberIds.map((member) => sizeOf(member).height),
  )
  const indexOfMember = new Map(memberIds.map((member, i) => [member, i]))
  const columnOf = (index: number) => index % columnCount
  const rowOf = (index: number) => Math.floor(index / columnCount)

  // Which channel each crossing net rides. A net entering from the west uses
  // the channel above its own row; one leaving east uses the channel below.
  // Channel k sits above row k, so there are rowCount + 1 of them.
  //
  // Ports are keyed per member pin, but a net that fans out to several members
  // is still one wire: it rides a single track and drops onto each pin through
  // that member's own gutter. Tracks are therefore allocated per net, not per
  // port, which is what keeps a high-fanout net from claiming one track per sink.
  const channelNets: Array<Array<{ portId: string; net: string }>> = Array.from(
    { length: rowCount + 1 },
    () => [],
  )
  for (const { portId, member, net } of westPorts) {
    const index = indexOfMember.get(member)
    if (index == null || columnOf(index) === 0) continue // straight in
    channelNets[rowOf(index)].push({ portId, net })
  }
  for (const { portId, member, net } of eastPorts) {
    const index = indexOfMember.get(member)
    if (index == null || columnOf(index) === columnCount - 1) continue
    channelNets[rowOf(index) + 1].push({ portId, net })
  }

  const trackCount = (entries: Array<{ net: string }>) =>
    new Set(entries.map((entry) => entry.net)).size
  const demand = (entries: Array<{ net: string }>) => {
    const tracks = trackCount(entries)
    return tracks === 0
      ? GRID_MIN_CHANNEL
      : Math.max(
          GRID_MIN_CHANNEL,
          tracks * GRID_TRACK_PITCH + 2 * GRID_CHANNEL_MARGIN,
        )
  }
  // Row pitch has to be one number for the block to read as an array, so every
  // channel between two rows is as tall as the busiest of them. The channels
  // above the first row and below the last sit outside that repeat and stay
  // sized to their own demand.
  const interior = channelNets.slice(1, rowCount).map(demand)
  const uniformInterior = interior.length > 0 ? Math.max(...interior) : 0
  // The outermost channels sit against the frame rather than between two rows,
  // so they take no space unless a net actually rides them. Interior channels
  // always keep a gap, since rows must not touch.
  const channelHeight = channelNets.map((entries, k) =>
    k === 0 || k === rowCount
      ? (entries.length === 0 ? 0 : demand(entries))
      : uniformInterior,
  )
  // Start below the header band so a track never crosses the group's label.
  const channelTop: number[] = []
  let cursor = EXPANDED_GROUP_TOP_PADDING
  for (let k = 0; k <= rowCount; k += 1) {
    channelTop.push(cursor)
    cursor += channelHeight[k]
    if (k < rowCount) cursor += cellHeight
  }
  const height = cursor + EXPANDED_GROUP_SIDE_PADDING
  const width =
    EXPANDED_GROUP_SIDE_PADDING * 2 +
    columnCount * cellWidth +
    Math.max(0, columnCount - 1) * GRID_GUTTER

  const cellX = (column: number) =>
    EXPANDED_GROUP_SIDE_PADDING + column * (cellWidth + GRID_GUTTER)
  const cellY = (row: number) => channelTop[row] + channelHeight[row]

  const trackByPort = new Map<string, number>()
  channelNets.forEach((entries, k) => {
    const slotOfNet = new Map<string, number>()
    entries.forEach(({ portId, net }) => {
      let slot = slotOfNet.get(net)
      if (slot == null) {
        slot = slotOfNet.size
        slotOfNet.set(net, slot)
      }
      trackByPort.set(
        portId,
        channelTop[k] + GRID_CHANNEL_MARGIN + slot * GRID_TRACK_PITCH,
      )
    })
  })

  return {
    columnCount,
    rowCount,
    cellWidth,
    cellHeight,
    width,
    height,
    cellOf: (index) => ({ x: cellX(columnOf(index)), y: cellY(rowOf(index)) }),
    gutterLeftOf: (column) =>
      column === 0
        ? EXPANDED_GROUP_SIDE_PADDING / 2
        : cellX(column) - GRID_GUTTER / 2,
    gutterRightOf: (column) =>
      column >= columnCount - 1
        ? width - EXPANDED_GROUP_SIDE_PADDING / 2
        : cellX(column + 1) - GRID_GUTTER / 2,
    trackY: (portId) => trackByPort.get(portId),
    columnOf,
    rowOf,
  }
}

function shouldKeepGlobalBoundaries(input: LayoutInput): boolean {
  const nodeById = new Map(input.nodes.map((node) => [node.id, node]))
  const neighbors = new Map(
    input.nodes.map((node) => [node.id, [] as number[]]),
  )
  for (const edge of input.edges) {
    if (!neighbors.has(edge.from) || !neighbors.has(edge.to)) continue
    neighbors.get(edge.from)!.push(edge.to)
    neighbors.get(edge.to)!.push(edge.from)
  }

  const unseen = new Set(neighbors.keys())
  let componentCount = 0
  let boundaryComponentCount = 0
  for (const root of neighbors.keys()) {
    if (!unseen.delete(root)) continue
    componentCount += 1
    let hasBoundary = nodeById.get(root)?.boundary !== 'internal'
    const pending = [root]
    while (pending.length > 0) {
      const node = pending.pop()!
      for (const neighbor of neighbors.get(node) ?? []) {
        if (!unseen.delete(neighbor)) continue
        hasBoundary ||= nodeById.get(neighbor)?.boundary !== 'internal'
        pending.push(neighbor)
      }
    }
    if (hasBoundary) boundaryComponentCount += 1
  }
  const internalComponentCount = componentCount - boundaryComponentCount
  return (
    componentCount <= MAX_GLOBAL_LAYOUT_COMPONENTS ||
    internalComponentCount <= MAX_GLOBAL_LAYOUT_COMPONENTS
  )
}

export interface LayoutGeometry {
  nodes: Array<Omit<LaidOutNode, 'node'>>
  edges: Array<{ inputIndex: number; points: Point[] }>
  groups?: LaidOutGroup[]
  width: number
  height: number
}

interface CachedLayoutGeometry {
  geometry: LayoutGeometry
  retainedBytes: number
}

// Repeated source/cone queries return fresh Subgraph objects even when their
// layout-relevant content is identical. Keep a small structural cache of the
// compact geometry, then hydrate it with the current graph objects. The byte
// budget prevents a handful of near-cap schematics from retaining unbounded
// routed-point arrays; the entry cap keeps small-graph churn bounded too.
export const LAYOUT_GEOMETRY_CACHE_MAX_ENTRIES = 4
export const LAYOUT_GEOMETRY_CACHE_MAX_BYTES = 16 * 1024 * 1024
const layoutGeometryCache = new Map<string, CachedLayoutGeometry>()
let layoutGeometryCacheBytes = 0

function layoutGeometryKey(input: LayoutInput, placement: NodePlacement): string {
  return `${placement}:${JSON.stringify(input)}`
}

function estimatedRetainedBytes(key: string, geometry: LayoutGeometry): number {
  const pointCount = geometry.edges.reduce(
    (total, edge) => total + edge.points.length,
    0,
  )
  // Conservative object/array allowances plus UTF-16 key storage. This is a
  // retained-memory budget, not a wire-size estimate.
  return (
    key.length * 2 +
    geometry.nodes.length * 128 +
    geometry.edges.length * 96 +
    (geometry.groups?.length ?? 0) * 80 +
    pointCount * 48 +
    256
  )
}

function cachedLayoutGeometry(key: string): LayoutGeometry | null {
  const cached = layoutGeometryCache.get(key)
  if (!cached) return null
  // Map insertion order is the LRU order.
  layoutGeometryCache.delete(key)
  layoutGeometryCache.set(key, cached)
  return cached.geometry
}

function cacheLayoutGeometry(key: string, geometry: LayoutGeometry): void {
  const retainedBytes = estimatedRetainedBytes(key, geometry)
  if (retainedBytes > LAYOUT_GEOMETRY_CACHE_MAX_BYTES) return

  const previous = layoutGeometryCache.get(key)
  if (previous) {
    layoutGeometryCacheBytes -= previous.retainedBytes
    layoutGeometryCache.delete(key)
  }
  layoutGeometryCache.set(key, { geometry, retainedBytes })
  layoutGeometryCacheBytes += retainedBytes

  while (
    layoutGeometryCache.size > LAYOUT_GEOMETRY_CACHE_MAX_ENTRIES ||
    layoutGeometryCacheBytes > LAYOUT_GEOMETRY_CACHE_MAX_BYTES
  ) {
    const oldestKey = layoutGeometryCache.keys().next().value
    if (oldestKey == null) break
    const oldest = layoutGeometryCache.get(oldestKey)
    layoutGeometryCache.delete(oldestKey)
    if (oldest) layoutGeometryCacheBytes -= oldest.retainedBytes
  }
}

export function clearLayoutGeometryCache(): void {
  layoutGeometryCache.clear()
  layoutGeometryCacheBytes = 0
}

export interface ViewportTransform {
  x: number
  y: number
  k: number
}

export interface ViewportInsets {
  top?: number
  right?: number
  bottom?: number
  left?: number
}

const MIN_VIEWPORT_SCALE = 0.08
const MAX_VIEWPORT_SCALE = 4

export function viewportTransformAttribute(transform: ViewportTransform): string {
  return `translate(${transform.x},${transform.y}) scale(${transform.k})`
}

export function panViewport(
  start: ViewportTransform,
  deltaX: number,
  deltaY: number,
): ViewportTransform {
  return { ...start, x: start.x + deltaX, y: start.y + deltaY }
}

export function zoomViewportAt(
  previous: ViewportTransform,
  anchorX: number,
  anchorY: number,
  factor: number,
): ViewportTransform {
  const scale = Math.min(
    Math.max(previous.k * factor, MIN_VIEWPORT_SCALE),
    MAX_VIEWPORT_SCALE,
  )
  const ratio = scale / previous.k
  return {
    k: scale,
    x: anchorX - (anchorX - previous.x) * ratio,
    y: anchorY - (anchorY - previous.y) * ratio,
  }
}

/** Keep a retained node at the same screen position after an additive layout. */
export function preserveViewportAnchor(
  transform: ViewportTransform,
  previous: LaidOutGraph,
  next: LaidOutGraph,
  preferredIds: Array<number | null | undefined> = [],
): ViewportTransform {
  const previousById = new Map(previous.nodes.map((node) => [node.id, node]))
  const nextById = new Map(next.nodes.map((node) => [node.id, node]))
  const candidates = [
    ...preferredIds,
    ...previous.nodes.map((node) => node.id),
  ]
  for (const id of candidates) {
    if (id == null) continue
    const before = previousById.get(id)
    const after = nextById.get(id)
    if (!before || !after) continue
    const beforeX = before.x + before.width / 2
    const beforeY = before.y + before.height / 2
    const afterX = after.x + after.width / 2
    const afterY = after.y + after.height / 2
    return {
      ...transform,
      x: transform.x + (beforeX - afterX) * transform.k,
      y: transform.y + (beforeY - afterY) * transform.k,
    }
  }
  return transform
}

/**
 * Center laid-out graph content in a viewport without relying on SVG viewBox
 * scaling. A hidden or not-yet-laid-out flex pane can transiently report a
 * zero-sized viewport; callers should retain the last transform in that case.
 */
export function fitViewportToContent(
  viewportWidth: number,
  viewportHeight: number,
  contentWidth: number,
  contentHeight: number,
  padding = 40,
  maxScale = 1.5,
  insets: ViewportInsets = {},
): ViewportTransform | null {
  const inset = (value: number | undefined) =>
    Number.isFinite(value) && (value ?? 0) > 0 ? (value ?? 0) : 0
  const top = inset(insets.top)
  const right = inset(insets.right)
  const bottom = inset(insets.bottom)
  const left = inset(insets.left)
  const availableWidth = viewportWidth - left - right
  const availableHeight = viewportHeight - top - bottom
  if (
    !Number.isFinite(viewportWidth) ||
    !Number.isFinite(viewportHeight) ||
    availableWidth <= padding ||
    availableHeight <= padding
  ) {
    return null
  }

  const width =
    Number.isFinite(contentWidth) && contentWidth > 0 ? contentWidth : 1
  const height =
    Number.isFinite(contentHeight) && contentHeight > 0 ? contentHeight : 1
  const scale = Math.min(
    (availableWidth - padding) / width,
    (availableHeight - padding) / height,
    maxScale,
  )
  if (!(scale > 0) || !Number.isFinite(scale)) return null

  return {
    x: left + (availableWidth - width * scale) / 2,
    y: top + (availableHeight - height * scale) / 2,
    k: scale,
  }
}

const CHAR_WIDTH = 7.2
const PAD_X = 24

function textWidth(node: GraphNode): number {
  const label = nodeLabel(node)
  const name = nodeSublabel(node) ?? ''
  const longest = Math.max(label.length, Math.min(name.length, 22))
  return Math.round(longest * CHAR_WIDTH + PAD_X)
}

export function nodeDimensions(node: GraphNode): { width: number; height: number } {
  const kind = symbolKind(node)
  const contentWidth = textWidth(node)

  const base = (() => {
    switch (kind) {
      case 'and':
      case 'nand':
      case 'or':
      case 'nor':
      case 'xor':
      case 'xnor':
        return { width: Math.max(76, contentWidth), height: 52 }
      case 'not':
      case 'buf':
        return { width: Math.max(62, contentWidth), height: 46 }
      case 'mux':
      case 'nmux':
        return { width: Math.max(70, contentWidth), height: 58 }
      case 'port-in':
      case 'port-out':
        return { width: Math.max(74, contentWidth), height: 34 }
      case 'reg':
      case 'latch':
        return { width: Math.max(92, contentWidth), height: 58 }
      case 'lut':
        return { width: Math.max(78, contentWidth), height: 54 }
      case 'carry':
        return { width: Math.max(98, contentWidth), height: 58 }
      case 'dsp':
        return { width: Math.max(112, contentWidth), height: 62 }
      case 'arith':
        return { width: Math.max(72, contentWidth), height: 54 }
      case 'memory':
        return { width: Math.max(112, contentWidth), height: 62 }
      case 'const':
        return { width: Math.max(58, contentWidth), height: 32 }
      case 'box':
        return { width: Math.max(96, contentWidth), height: 58 }
    }
  })()
  const controls = controlsFor(node)
  let width = base.width
  let height = base.height
  if (controls.length > 0) {
    const controlWidth = controls.reduce(
      (max, control) => Math.max(max, controlCaption(control).length * 6.2 + PAD_X),
      0,
    )
    width = Math.max(width, Math.round(controlWidth))
    height = base.height + controls.length * 13
  }
  // Reserve a row and width only when a separate "×N" member badge renders.
  const badge = groupBadgeText(node)
  if (badge) {
    width = Math.max(width, Math.round(badge.length * CHAR_WIDTH + PAD_X))
    height += 14
  }
  return { width, height }
}

/** Build the ELK graph description from compact layout input. */
// NETWORK_SIMPLEX gives the tightest alignment but recurses in elkjs and blows
// the stack on very deep DAGs (e.g. a wide adder tree). BRANDES_KOEPF is the
// robust fallback: slightly looser, never overflows. layoutSubgraph retries
// with it when the premium strategy fails.
export type NodePlacement = 'NETWORK_SIMPLEX' | 'BRANDES_KOEPF'
export const REDUCED_THOROUGHNESS_NODE_THRESHOLD = 700
export const DENSE_LAYOUT_NODE_THRESHOLD = 500
export const REDUCED_THOROUGHNESS_EDGE_DENSITY = 2.5
export const DENSE_LONGEST_PATH_EDGE_DENSITY = 4

// A flip-flop draws as a box with the data pin (D) at the upper-west, the clock
// triangle lower-west, and the data output (Q) at the east. These fractions of
// the primary body height are shared with GraphView so the routed data edges
// land exactly on the rendered D and Q pins (and never on the clock notch).
export const REG_BODY_HEIGHT = 58
export const REG_DATA_IN_Y_FRAC = 0.32
export const REG_DATA_OUT_Y_FRAC = 0.5
export const REG_CLOCK_Y_FRAC = 0.72
export const REG_RESET_Y_FRAC = 0.5
export const REG_SET_Y_FRAC = 0.14
export const REG_ENABLE_Y_FRAC = 0.88
const PIN_ROW_HEIGHT = 14
const CONTROL_ROW_HEIGHT = 13

/** Fixed schematic position for a register's non-data input pin. */
export function registerControlYFraction(role: ControlRole): number {
  switch (role) {
    case 'clock':
      return REG_CLOCK_Y_FRAC
    case 'reset':
      return REG_RESET_Y_FRAC
    case 'set':
      return REG_SET_Y_FRAC
    case 'enable':
      return REG_ENABLE_Y_FRAC
    case 'other':
      return 0.6
  }
}

export function controlRoleForPin(pin: string): ControlRole {
  const upper = pin.toUpperCase()
  if (upper.startsWith('CLK') || upper.endsWith('CLK')) return 'clock'
  switch (upper) {
    case 'CLK':
    case 'C':
      return 'clock'
    case 'R':
    case 'RST':
    case 'ARST':
    case 'SRST':
    case 'CLR':
    case 'LSR':
      return 'reset'
    case 'S':
    case 'SET':
    case 'PRE':
    case 'SR':
      return 'set'
    case 'E':
    case 'EN':
    case 'CE':
    case 'G':
    case 'GE':
      return 'enable'
    default:
      return 'other'
  }
}

/** True when a register input names a physical clock/reset/set/enable pin. */
export function isRegisterControlPin(pin: string): boolean {
  return controlRoleForPin(pin) !== 'other'
}

function isRegKind(node: GraphNode): boolean {
  const kind = symbolKind(node)
  return kind === 'reg' || kind === 'latch'
}

export function canonicalPinNames(pins: Iterable<string>): string[] {
  return [...new Set(pins)].sort()
}

interface PinCatalog {
  incoming: Map<number, string[]>
  outgoing: Map<number, string[]>
  incomingIndex: Map<number, Map<string, number>>
  outgoingIndex: Map<number, Map<string, number>>
}

function collectPinCatalog(edges: readonly LayoutInputEdge[]): PinCatalog {
  const incomingSets = new Map<number, Set<string>>()
  const outgoingSets = new Map<number, Set<string>>()
  const add = (map: Map<number, Set<string>>, id: number, pin: string) => {
    let pins = map.get(id)
    if (!pins) {
      pins = new Set()
      map.set(id, pins)
    }
    pins.add(pin)
  }
  for (const edge of edges) {
    add(outgoingSets, edge.from, edge.fromPort)
    add(incomingSets, edge.to, edge.toPort)
  }
  const build = (sets: Map<number, Set<string>>) => {
    const names = new Map<number, string[]>()
    const positions = new Map<number, Map<string, number>>()
    for (const [id, pins] of sets) {
      const ordered = canonicalPinNames(pins)
      names.set(id, ordered)
      positions.set(id, new Map(ordered.map((pin, index) => [pin, index])))
    }
    return { names, positions }
  }
  const incoming = build(incomingSets)
  const outgoing = build(outgoingSets)
  return {
    incoming: incoming.names,
    outgoing: outgoing.names,
    incomingIndex: incoming.positions,
    outgoingIndex: outgoing.positions,
  }
}

function dimensionsForPins(
  node: LayoutInputNode,
  incoming: number,
  outgoing: number,
): { width: number; height: number } {
  if (node.register) return { width: node.baseWidth, height: node.baseHeight }
  const pinRows = Math.max(incoming, outgoing)
  return {
    width: node.baseWidth,
    height: Math.max(
      node.baseHeight,
      (pinRows + 1) * PIN_ROW_HEIGHT + node.controlHeight,
    ),
  }
}

function pinBodyHeight(node: LayoutInputNode, height: number): number {
  return Math.max(1, height - node.controlHeight)
}

function normalizeBoundaryMembers(
  members: readonly BoundaryMember[] | undefined,
): BoundaryMember[] | undefined {
  if (!members || members.length === 0) return undefined
  const unique = new Map<string, BoundaryMember>()
  for (const member of members) {
    unique.set(`${member.bit}:${member.member}`, {
      member: member.member,
      bit: member.bit,
    })
  }
  return [...unique.values()].sort(
    (left, right) => left.bit - right.bit || left.member - right.member,
  )
}

function normalizeEdgeBoundaryMembers(
  members: readonly EdgeBoundaryMember[] | undefined,
  boundaryMembers: readonly BoundaryMember[] | undefined,
): EdgeBoundaryMember[] | undefined {
  if (!members || members.length === 0) return undefined
  const bitByMember = new Map(
    boundaryMembers?.map((entry) => [entry.member, entry.bit] as const),
  )
  const netBitsByMember = new Map<number, Set<number>>()
  for (const entry of members) {
    const netBits = netBitsByMember.get(entry.member) ?? new Set<number>()
    for (const bit of entry.net_bits) netBits.add(bit)
    netBitsByMember.set(entry.member, netBits)
  }
  return [...netBitsByMember]
    .sort(([left], [right]) => {
      const leftBit = bitByMember.get(left)
      const rightBit = bitByMember.get(right)
      if (leftBit != null && rightBit != null && leftBit !== rightBit) {
        return leftBit - rightBit
      }
      if (leftBit != null && rightBit == null) return -1
      if (leftBit == null && rightBit != null) return 1
      return left - right
    })
    .map(([member, netBits]) => ({
      member,
      net_bits: [...netBits].sort((left, right) => left - right),
    }))
}

export function prepareLayoutInput(
  sub: Subgraph,
  expandedGroups: ExpandedGroupLayout[] = [],
): LayoutInput {
  const nodeById = new Map(sub.nodes.map((node) => [node.id, node]))
  // Hidden control edges retain their driver ids on the controlled node. Count
  // those sources when classifying primary inputs so hiding control wiring does
  // not move clock/reset ports away from the left boundary.
  const controlDrivers = new Set<number>()
  for (const node of sub.nodes) {
    for (const control of controlsFor(node)) {
      for (const driver of controlDriverIds(control)) controlDrivers.add(driver)
    }
  }
  const portNodes = sub.nodes.filter((node) => node.kind === 'port')
  const boundaryById = inferPortBoundaryRoles(
    portNodes.map((node) => node.id),
    sub.edges,
    controlDrivers,
    new Map(
      portNodes.flatMap((node) =>
        node.port_direction ? [[node.id, node.port_direction]] : [],
      ),
    ),
  )
  const visibleNodeIds = new Set(sub.nodes.map((node) => node.id))
  const claimedMembers = new Set<number>()
  const groups = expandedGroups.flatMap((group) => {
    const members = group.members.filter(
      (member) => visibleNodeIds.has(member) && !claimedMembers.has(member),
    )
    for (const member of members) claimedMembers.add(member)
    return members.length > 0
      ? [{
          id: group.id,
          members,
          ...(group.referenceHeight != null
            ? { referenceHeight: group.referenceHeight }
            : {}),
        }]
      : []
  })
  return {
    nodes: sub.nodes.map((node) => {
      const { width, height } = nodeDimensions(node)
      const boundaryMembers = normalizeBoundaryMembers(node.boundary_members)
      return {
        id: node.id,
        baseWidth: width,
        baseHeight: height,
        controlHeight: controlsFor(node).length * CONTROL_ROW_HEIGHT,
        register: isRegKind(node),
        boundary: boundaryById.get(node.id) ?? 'internal',
        ...(boundaryMembers != null ? { boundaryMembers } : {}),
      }
    }),
    edges: sub.edges.map((edge) => {
      const target = nodeById.get(edge.to)
      const sourceBoundaryMembers = normalizeEdgeBoundaryMembers(
        edge.source_boundary_members,
        nodeById.get(edge.from)?.boundary_members,
      )
      const targetBoundaryMembers = normalizeEdgeBoundaryMembers(
        edge.target_boundary_members,
        target?.boundary_members,
      )
      return {
        from: edge.from,
        to: edge.to,
        fromPort: edge.from_port,
        toPort: edge.to_port,
        // API `control` describes global-control semantics and styling. Keep
        // ordinary logic-generated enables solid while still routing them to
        // the physical EN pin instead of the register's D pin.
        control:
          edge.control === true ||
          Boolean(target && isRegKind(target) && isRegisterControlPin(edge.to_port)),
        ...(edge.bits != null && edge.bits.length > 0 ? { bits: edge.bits } : {}),
        ...(sourceBoundaryMembers != null ? { sourceBoundaryMembers } : {}),
        ...(targetBoundaryMembers != null ? { targetBoundaryMembers } : {}),
      }
    }),
    ...(groups.length > 0 ? { groups } : {}),
  }
}

export function toElkGraph(
  input: LayoutInput,
  nodePlacement: NodePlacement = 'NETWORK_SIMPLEX',
): ElkNode {
  // Distinct input/output pin names per node, so every component's edges route
  // to spread-out pins on the west/east sides instead of collapsing to the box
  // centre. Sorted for a stable top-to-bottom pin order.
  const pins = collectPinCatalog(input.edges)
  const inPins = pins.incoming
  const outPins = pins.outgoing

  const nodeById = new Map(input.nodes.map((node) => [node.id, node]))
  const controlPins = new Map<number, Map<string, ControlRole>>()
  for (const edge of input.edges) {
    if (!edge.control) continue
    const node = nodeById.get(edge.to)
    if (!node?.register) continue
    let pins = controlPins.get(edge.to)
    if (!pins) {
      pins = new Map()
      controlPins.set(edge.to, pins)
    }
    pins.set(edge.toPort, controlRoleForPin(edge.toPort))
  }

  const regIds = new Set<number>()
  const nodeChildren: ElkNode[] = input.nodes.map((n) => {
    const ins = inPins.get(n.id) ?? []
    const outs = outPins.get(n.id) ?? []
    const { width, height } = dimensionsForPins(n, ins.length, outs.length)
    const boundaryLayoutOptions: NonNullable<ElkNode['layoutOptions']> =
      n.boundary === 'input'
      ? {
          'elk.layered.layering.layerConstraint': 'FIRST_SEPARATE',
          'elk.alignment': 'LEFT',
        }
      : n.boundary === 'output'
        ? {
            'elk.layered.layering.layerConstraint': 'LAST_SEPARATE',
            'elk.alignment': 'RIGHT',
          }
        : {}
    if (n.register) {
      regIds.add(n.id)
      // Fixed D/control (west) and Q (east) ports keep every visible register
      // connection on its real schematic pin.
      const body = Math.min(height, REG_BODY_HEIGHT)
      const controls = [...(controlPins.get(n.id)?.entries() ?? [])].sort(
        ([pinA, roleA], [pinB, roleB]) =>
          registerControlYFraction(roleA) - registerControlYFraction(roleB) ||
          pinA.localeCompare(pinB),
      )
      return {
        id: String(n.id),
        width,
        height,
        layoutOptions: {
          ...boundaryLayoutOptions,
          'elk.portConstraints': 'FIXED_POS',
        },
        ports: [
          {
            id: `${n.id}#in`,
            x: 0,
            y: body * REG_DATA_IN_Y_FRAC,
            layoutOptions: { 'elk.port.side': 'WEST' },
          },
          ...controls.map(([pin, role]) => ({
            id: `${n.id}#control:${pin}`,
            x: 0,
            y: body * registerControlYFraction(role),
            layoutOptions: { 'elk.port.side': 'WEST' },
          })),
          {
            id: `${n.id}#out`,
            x: width,
            y: body * REG_DATA_OUT_Y_FRAC,
            layoutOptions: { 'elk.port.side': 'EAST' },
          },
        ],
      }
    }
    if (ins.length === 0 && outs.length === 0) {
      return { id: String(n.id), width, height, layoutOptions: boundaryLayoutOptions }
    }
    const ports = [
      ...ins.map((pin, i) => ({
        id: `${n.id}#i:${pin}`,
        x: 0,
        y: ((i + 1) * pinBodyHeight(n, height)) / (ins.length + 1),
        layoutOptions: { 'elk.port.side': 'WEST' },
      })),
      ...outs.map((pin, j) => ({
        id: `${n.id}#o:${pin}`,
        x: width,
        y: ((j + 1) * pinBodyHeight(n, height)) / (outs.length + 1),
        layoutOptions: { 'elk.port.side': 'EAST' },
      })),
    ]
    return {
      id: String(n.id),
      width,
      height,
      layoutOptions: {
        ...boundaryLayoutOptions,
        'elk.portConstraints': 'FIXED_POS',
      },
      ports,
    }
  })

  const pinId = (
    map: Map<number, Map<string, number>>,
    id: number,
    pin: string,
    prefix: 'i' | 'o',
  ): string => (map.get(id)?.has(pin) ? `${id}#${prefix}:${pin}` : String(id))
  const sourcePortId = (edge: LayoutInputEdge): string =>
    regIds.has(edge.from)
      ? `${edge.from}#out`
      : pinId(pins.outgoingIndex, edge.from, edge.fromPort, 'o')
  const targetPortId = (edge: LayoutInputEdge): string =>
    regIds.has(edge.to)
      ? edge.control
        ? `${edge.to}#control:${edge.toPort}`
        : `${edge.to}#in`
      : pinId(pins.incomingIndex, edge.to, edge.toPort, 'i')

  const groupedMemberIds = new Set(
    input.groups?.flatMap((group) => group.members) ?? [],
  )
  const childById = new Map(
    nodeChildren.map((child) => [Number(child.id), child]),
  )
  const groupIdByMember = new Map<number, number>()
  for (const group of input.groups ?? []) {
    if (!group.members.some((member) => childById.has(member))) continue
    for (const member of group.members) groupIdByMember.set(member, group.id)
  }

  // Collect every net that crosses a group boundary, keyed by the member pin it
  // terminates on. A vertically stacked group turns each of these into its own
  // proxy port at that pin's exact height, so ELK routes the net straight to
  // the pin instead of funnelling the whole group through one point on the
  // frame edge and doubling back along a perimeter rail.
  // A net is identified by the pin that drives it, so every edge leaving the
  // same driver pin shares a track inside a group's channels.
  const groupEndpoints = new Map<number, {
    west: Map<string, { member: number; net: string }>
    east: Map<string, { member: number; net: string }>
  }>()
  const endpointsFor = (groupId: number) => {
    let entry = groupEndpoints.get(groupId)
    if (!entry) {
      entry = { west: new Map(), east: new Map() }
      groupEndpoints.set(groupId, entry)
    }
    return entry
  }
  for (const edge of input.edges) {
    const fromGroupId = groupIdByMember.get(edge.from)
    const toGroupId = groupIdByMember.get(edge.to)
    if (fromGroupId === toGroupId) continue
    const net = netKeyOf(edge)
    if (fromGroupId != null) {
      endpointsFor(fromGroupId).east.set(sourcePortId(edge), {
        member: edge.from,
        net,
      })
    }
    if (toGroupId != null) {
      endpointsFor(toGroupId).west.set(targetPortId(edge), {
        member: edge.to,
        net,
      })
    }
  }

  const groupChildren: ElkNode[] = (input.groups ?? []).flatMap((group) => {
    const members = group.members.flatMap((member) => {
      const child = childById.get(member)
      return child ? [child] : []
    })
    if (members.length === 0) return []

    // Prefer one aligned vertical stack. If that stack would exceed twice the
    // height of the schematic the user expanded from, form the fewest clean
    // grid columns needed to stay within that vertical budget. Cross-boundary
    // nets terminate at compound proxy ports during ELK placement, then regain
    // their exact member-pin endpoints through collision-free frame corridors.
    const singleColumnHeight = expandedGroupSingleColumnHeight(members)
    // Callers outside the interactive expansion path may not have a reference
    // layout. Preserve the bounded legacy fallback for those inputs.
    const stackVertically = shouldStackExpandedGroup(group, members)
    // A vertical stack is placed deterministically: header band, then members
    // in canonical order separated by one spacing step. `interpretResult`
    // repacks the laid-out members onto these same offsets, so a proxy port
    // derived from them lands exactly on its member pin.
    const memberOffsetY = new Map<string, number>()
    let stackOffsetY = EXPANDED_GROUP_TOP_PADDING
    for (const member of members) {
      memberOffsetY.set(member.id, stackOffsetY)
      stackOffsetY += (member.height ?? 0) + EXPANDED_GROUP_NODE_SPACING
    }
    const proxyPortY = (member: number, portId: string): number => {
      const child = childById.get(member)
      const offsetY = child ? memberOffsetY.get(child.id) : undefined
      if (!child || offsetY == null) return singleColumnHeight / 2
      const port = child.ports?.find((candidate) => candidate.id === portId)
      return offsetY + (port?.y ?? (child.height ?? 0) / 2)
    }
    const columnCount = expandedGroupColumnCount(group, members)
    const endpointsForGroup = groupEndpoints.get(group.id)
    const lattice = stackVertically ? null : planGridLattice(
      group.members.filter((member) => childById.has(member)),
      columnCount,
      (member) => {
        const child = childById.get(member)
        return { width: child?.width ?? 0, height: child?.height ?? 0 }
      },
      [...(endpointsForGroup?.west ?? [])].map(([portId, entry]) =>
        ({ portId, ...entry })),
      [...(endpointsForGroup?.east ?? [])].map(([portId, entry]) =>
        ({ portId, ...entry })),
    )
    const memberIndex = new Map(
      group.members.filter((m) => childById.has(m)).map((m, i) => [m, i]),
    )
    // Pin height inside a member, used to place a boundary port that faces it.
    const pinOffsetY = (member: number, portId: string): number => {
      const child = childById.get(member)
      if (!child) return 0
      const port = child.ports?.find((candidate) => candidate.id === portId)
      return port?.y ?? (child.height ?? 0) / 2
    }
    const latticePortY = (member: number, portId: string): number => {
      if (!lattice) return 0
      const track = lattice.trackY(portId)
      if (track != null) return track
      const index = memberIndex.get(member)
      if (index == null) return lattice.height / 2
      return lattice.cellOf(index).y + pinOffsetY(member, portId)
    }
    const arrangedMembers = stackVertically
      ? members.map((member, index) => {
          return {
            ...member,
            layoutOptions: {
              ...member.layoutOptions,
              // External nets terminate at proxy ports on the compound, so
              // FIRST is legal here and puts every member in one x-aligned
              // layer. The in-layer relation keeps the member ordering stable.
              'elk.layered.layering.layerConstraint': 'FIRST',
              ...(members[index + 1]
                ? {
                    'elk.layered.crossingMinimization.inLayerPredOf':
                      members[index + 1].id,
                  }
                : {}),
            },
          }
        })
      : members.map((member) => {
          const index = memberIndex.get(Number(member.id))
          if (!lattice || index == null) return member
          const cell = lattice.cellOf(index)
          return { ...member, x: cell.x, y: cell.y }
        })
    const layoutEdges: ElkExtendedEdge[] = []
    for (let index = 0; index + 1 < members.length; index += 1) {
      if (stackVertically || lattice || (index + 1) % columnCount === 0) continue
      layoutEdges.push({
        id: `group-layout:${group.id}:${index}`,
        sources: [members[index].id],
        targets: [members[index + 1].id],
      })
    }
    const groupWidth = Math.max(
      ...members.map((member) => member.width ?? 0),
    ) + 2 * EXPANDED_GROUP_SIDE_PADDING
    const endpoints = groupEndpoints.get(group.id)
    const proxyPorts = (
      side: 'in' | 'out',
      endpointsBySide: Map<string, { member: number; net: string }> | undefined,
    ) => {
      const ports = [...(endpointsBySide ?? [])].map(([portId, { member }]) => ({
        id: `group:${group.id}#${side}:${portId}`,
        ...(stackVertically
          ? { x: side === 'in' ? 0 : groupWidth, y: proxyPortY(member, portId) }
          : lattice
            ? {
                x: side === 'in' ? 0 : lattice.width,
                y: latticePortY(member, portId),
              }
            : {}),
        width: 0,
        height: 0,
        layoutOptions: {
          'elk.port.side': side === 'in' ? 'WEST' : 'EAST',
        },
      }))
      return stackVertically
        ? ports.sort((left, right) => (left.y ?? 0) - (right.y ?? 0))
        : ports
    }
    return [{
      id: `group:${group.id}`,
      children: arrangedMembers,
      edges: layoutEdges,
      ports: [
        ...proxyPorts('in', endpoints?.west),
        ...proxyPorts('out', endpoints?.east),
      ],
      ...(stackVertically
        ? { width: groupWidth, height: singleColumnHeight }
        : lattice
          ? { width: lattice.width, height: lattice.height }
          : {}),
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        'elk.edgeRouting': 'ORTHOGONAL',
        ...(stackVertically
          ? {
              'elk.portConstraints': 'FIXED_POS',
              'elk.nodeSize.constraints': '[MINIMUM_SIZE]',
              'elk.nodeSize.minimum': `(${groupWidth},${singleColumnHeight})`,
            }
          : lattice
            ? {
                // Positions are ours; ELK only places the block and routes to
                // the boundary ports we declared.
                'elk.algorithm': 'fixed',
                'elk.portConstraints': 'FIXED_POS',
                'elk.nodeSize.constraints': '[MINIMUM_SIZE]',
                'elk.nodeSize.minimum': `(${lattice.width},${lattice.height})`,
              }
            : { 'elk.portConstraints': 'FIXED_SIDE' }),
        'elk.padding':
          `[top=${EXPANDED_GROUP_TOP_PADDING},left=${EXPANDED_GROUP_SIDE_PADDING}` +
          `,bottom=${EXPANDED_GROUP_SIDE_PADDING},right=${EXPANDED_GROUP_SIDE_PADDING}]`,
        'elk.spacing.nodeNode': '18',
        'elk.layered.spacing.nodeNodeBetweenLayers': '18',
        'elk.layered.nodePlacement.strategy':
          members.length >= DENSE_LAYOUT_NODE_THRESHOLD
            ? 'BRANDES_KOEPF'
            : nodePlacement,
        ...(members.length >= DENSE_LAYOUT_NODE_THRESHOLD
          ? { 'elk.layered.thoroughness': '1' }
          : {}),
      },
    }]
  })
  const children: ElkNode[] = [
    ...nodeChildren.filter((child) => !groupedMemberIds.has(Number(child.id))),
    ...groupChildren,
  ]

  const groupProxyPortId = (
    groupId: number,
    side: 'in' | 'out',
    portId: string,
  ): string => `group:${groupId}#${side}:${portId}`

  const edges: ElkExtendedEdge[] = input.edges.flatMap((e, i) => {
    const fromGroupId = groupIdByMember.get(e.from)
    const toGroupId = groupIdByMember.get(e.to)
    // Internal member nets are routed inside the compound after layout; an
    // ELK edge between the compound's own proxy ports becomes a large exterior
    // self-loop and contributes no useful placement information.
    if (fromGroupId != null && fromGroupId === toGroupId) return []
    const from = sourcePortId(e)
    const to = targetPortId(e)
    return [{
          id: `e${i}`,
          sources: [
            fromGroupId != null
              ? groupProxyPortId(fromGroupId, 'out', from)
              : from,
          ],
          targets: [
            toGroupId != null ? groupProxyPortId(toGroupId, 'in', to) : to,
          ],
        }]
  })
  const edgeDensity = input.edges.length / Math.max(1, input.nodes.length)
  const useDenseFastPath =
    nodePlacement === 'BRANDES_KOEPF' &&
    input.nodes.length >= DENSE_LAYOUT_NODE_THRESHOLD &&
    edgeDensity >= REDUCED_THOROUGHNESS_EDGE_DENSITY
  const useDenseLayering =
    nodePlacement === 'BRANDES_KOEPF' &&
    input.nodes.length >= DENSE_LAYOUT_NODE_THRESHOLD &&
    edgeDensity >= DENSE_LONGEST_PATH_EDGE_DENSITY
  const keepGlobalBoundaries = shouldKeepGlobalBoundaries(input)

  return {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      // Expanded quotient groups are real compound nodes. ELK lays out their
      // physical members together and routes surrounding nets around the
      // compound boundary instead of through an after-the-fact SVG rectangle.
      // Leave this unset for ordinary flat graphs: INCLUDE_CHILDREN disables
      // ELK's compact packing of large disconnected views.
      ...(groupChildren.length > 0
        ? { 'elk.hierarchyHandling': 'INCLUDE_CHILDREN' }
        : {}),
      // Keep ordinary views in one coordinate system so FIRST_SEPARATE/LEFT and
      // LAST_SEPARATE/RIGHT are global boundaries. Let ELK pack highly
      // disconnected views independently instead of stacking hundreds of
      // orphan nodes into one extremely tall layer.
      'elk.separateConnectedComponents': keepGlobalBoundaries ? 'false' : 'true',
      'elk.layered.spacing.nodeNodeBetweenLayers': '66',
      'elk.spacing.nodeNode': '30',
      'elk.layered.spacing.edgeNodeBetweenLayers': '20',
      'elk.layered.mergeEdges': 'true',
      'elk.layered.nodePlacement.strategy': nodePlacement,
      ...(nodePlacement === 'BRANDES_KOEPF'
        ? {
            // Dense circuit graphs spend disproportionately more time in
            // repeated layered sweeps. Use the lower-cost path only where
            // topology makes it robust; sparse/grouped graphs retain the
            // higher-quality passes selected by graph size.
            'elk.layered.thoroughness':
              useDenseFastPath
                ? '1'
                : input.nodes.length >= REDUCED_THOROUGHNESS_NODE_THRESHOLD
                ? '3'
                : '4',
            ...(useDenseLayering
              ? { 'elk.layered.layering.strategy': 'LONGEST_PATH' }
              : {}),
          }
        : {}),
    },
    children,
    edges,
  }
}

function assertRenderableSubgraph(sub: Subgraph): void {
  if (sub.nodes.length > MAX_GROUP_EXPANSION_RENDER_NODES) {
    throw new Error(
      `cone too large (${sub.nodes.length} nodes) — reduce depth or pick a narrower signal`,
    )
  }
  if (sub.edges.length > MAX_GRAPH_EDGES) {
    throw new Error(
      `cone too dense (${sub.edges.length} merged edges; limit ${MAX_GRAPH_EDGES}) — reduce depth or pick a narrower signal`,
    )
  }
}

export function interpretResult(input: LayoutInput, root: ElkNode): LayoutGeometry {
  const byId = new Map(input.nodes.map((node) => [node.id, node]))
  const pins = collectPinCatalog(input.edges)

  const nodes: LayoutGeometry['nodes'] = []
  const groups: LaidOutGroup[] = []
  const visitChildren = (
    parent: ElkNode,
    parentX: number,
    parentY: number,
  ) => {
    for (const child of parent.children ?? []) {
      const x = parentX + (child.x ?? 0)
      const y = parentY + (child.y ?? 0)
      const groupMatch = /^group:(-?\d+)$/.exec(child.id)
      if (groupMatch) {
        groups.push({
          id: Number(groupMatch[1]),
          x,
          y,
          width: child.width ?? 0,
          height: child.height ?? 0,
        })
        visitChildren(child, x, y)
        continue
      }
      const id = Number(child.id)
      const node = byId.get(id)
      if (!node) continue
      const fallback = dimensionsForPins(
        node,
        pins.incoming.get(id)?.length ?? 0,
        pins.outgoing.get(id)?.length ?? 0,
      )
      nodes.push({
        id,
        x,
        y,
        width: child.width ?? fallback.width,
        height: child.height ?? fallback.height,
      })
      visitChildren(child, x, y)
    }
  }
  visitChildren(root, 0, 0)

  const laidOutById = new Map(nodes.map((node) => [node.id, node]))
  // ELK can pack disconnected members in an arbitrary in-layer order even
  // when their model-order hints are identical. Reassign the already allocated
  // vertical slots to the canonical member order before deriving pin routes.
  // This changes neither the compound bounds nor surrounding node placement.
  const endpointPortIdFor = (edge: LayoutInputEdge, output: boolean): string => {
    const id = output ? edge.from : edge.to
    const pin = output ? edge.fromPort : edge.toPort
    if (byId.get(id)?.register) {
      if (output) return `${id}#out`
      return edge.control ? `${id}#control:${pin}` : `${id}#in`
    }
    const index = output ? pins.outgoingIndex : pins.incomingIndex
    return index.get(id)?.has(pin)
      ? `${id}#${output ? 'o' : 'i'}:${pin}`
      : String(id)
  }
  const groupById = new Map(groups.map((group) => [group.id, group]))
  // Grid groups are placed on the same lattice toElkGraph planned, so the
  // routing below meets every pin exactly.
  const latticeByGroup = new Map<number, GridLattice>()
  // Cell index per member, built once: the routing below runs per edge and must
  // not rescan the group's member list.
  const latticeIndexByGroup = new Map<number, Map<number, number>>()
  const gridGroups = new Map<number, {
    group: ExpandedGroupLayout
    frame: LaidOutGroup
    present: number[]
    members: LayoutGeometry['nodes']
  }>()
  for (const group of input.groups ?? []) {
    const frame = groupById.get(group.id)
    const present = group.members.filter((member) => laidOutById.has(member))
    const members = present.flatMap((member) => {
      const node = laidOutById.get(member)
      return node ? [node] : []
    })
    if (!frame || members.length === 0) continue
    if (shouldStackExpandedGroup(group, members)) continue
    gridGroups.set(group.id, { group, frame, present, members })
  }
  const gridGroupOfMember = new Map<number, number>()
  for (const [id, entry] of gridGroups) {
    for (const member of entry.present) gridGroupOfMember.set(member, id)
  }
  // One sweep over the edges collects every group's boundary endpoints, keyed
  // exactly as toElkGraph keyed its ports so tracks and ports line up.
  type Endpoint = { member: number; net: string }
  const westByGroup = new Map<number, Map<string, Endpoint>>()
  const eastByGroup = new Map<number, Map<string, Endpoint>>()
  const endpointsInto = (
    store: Map<number, Map<string, Endpoint>>,
    groupId: number,
  ) => {
    let entry = store.get(groupId)
    if (!entry) {
      entry = new Map()
      store.set(groupId, entry)
    }
    return entry
  }
  for (const edge of input.edges) {
    const fromGroup = gridGroupOfMember.get(edge.from)
    const toGroup = gridGroupOfMember.get(edge.to)
    const net = netKeyOf(edge)
    if (toGroup != null && toGroup !== fromGroup) {
      endpointsInto(westByGroup, toGroup)
        .set(endpointPortIdFor(edge, false), { member: edge.to, net })
    }
    if (fromGroup != null && fromGroup !== toGroup) {
      endpointsInto(eastByGroup, fromGroup)
        .set(endpointPortIdFor(edge, true), { member: edge.from, net })
    }
  }
  for (const [id, { group, frame, present, members }] of gridGroups) {
    const sizeById = new Map(members.map((member) => [member.id, member]))
    const lattice = planGridLattice(
      present,
      expandedGroupColumnCount(group, members),
      (member) => {
        const node = sizeById.get(member)
        return { width: node?.width ?? 0, height: node?.height ?? 0 }
      },
      [...(westByGroup.get(id) ?? [])].map(([portId, entry]) =>
        ({ portId, ...entry })),
      [...(eastByGroup.get(id) ?? [])].map(([portId, entry]) =>
        ({ portId, ...entry })),
    )
    latticeByGroup.set(id, lattice)
    latticeIndexByGroup.set(
      id,
      new Map(present.map((member, index) => [member, index])),
    )
    present.forEach((member, index) => {
      const node = laidOutById.get(member)
      if (!node) return
      const cell = lattice.cellOf(index)
      node.x = frame.x + cell.x
      node.y = frame.y + cell.y
    })
  }
  for (const group of input.groups ?? []) {
    const members = group.members.flatMap((member) => {
      const node = laidOutById.get(member)
      return node ? [node] : []
    })
    if (
      members.length === 0 ||
      !shouldStackExpandedGroup(group, members)
    ) continue
    // Anchor on the frame's own header band rather than on wherever ELK landed
    // the topmost member. `toElkGraph` derives its per-net proxy port heights
    // from the same offsets, so the two agree exactly and every boundary net
    // meets its member pin without a vertical correction.
    const frame = groupById.get(group.id)
    let memberY = frame
      ? frame.y + EXPANDED_GROUP_TOP_PADDING
      : Math.min(...members.map((member) => member.y))
    members.forEach((member) => {
      member.y = memberY
      memberY += member.height + EXPANDED_GROUP_NODE_SPACING
    })
  }

  const groupIdByMember = new Map(
    (input.groups ?? []).flatMap((group) =>
      group.members.map((member) => [member, group.id] as const),
    ),
  )
  const rootEdges = (root.edges ?? []) as ElkExtendedEdge[]
  const routedByInputIndex = new Map<number, ElkExtendedEdge>()
  for (const edge of rootEdges) {
    const match = /^e(\d+)$/.exec(edge.id)
    if (match) routedByInputIndex.set(Number(match[1]), edge)
  }
  const fallbackPoint = (id: number, output: boolean, edge: LayoutInputEdge): Point => {
    const laidOut = laidOutById.get(id)
    if (!laidOut) return { x: 0, y: 0 }
    const node = byId.get(id)
    if (!node) return { x: 0, y: 0 }
    const registerYFraction = output
      ? REG_DATA_OUT_Y_FRAC
      : edge.control
        ? registerControlYFraction(controlRoleForPin(edge.toPort))
        : REG_DATA_IN_Y_FRAC
    if (!node.register) {
      const names = output ? pins.outgoing.get(id) : pins.incoming.get(id)
      const positions = output ? pins.outgoingIndex.get(id) : pins.incomingIndex.get(id)
      const pin = output ? edge.fromPort : edge.toPort
      const index = positions?.get(pin)
      const height = pinBodyHeight(node, laidOut.height)
      return {
        x: laidOut.x + (output ? laidOut.width : 0),
        y: laidOut.y + (index == null || names == null
          ? height / 2
          : ((index + 1) * height) / (names.length + 1)),
      }
    }
    return {
      x: laidOut.x + (output ? laidOut.width : 0),
      y: laidOut.y + Math.min(laidOut.height, REG_BODY_HEIGHT) * registerYFraction,
    }
  }
  const compoundRouteById = new Map<number, {
    frame: LaidOutGroup
    stacked: boolean
    topRailY: number
    bottomRailY: number
    accessByMember: Map<number, { leftRailX: number; rightRailX: number }>
  }>()
  for (const group of input.groups ?? []) {
    const frame = groupById.get(group.id)
    if (!frame) continue
    const members = group.members.flatMap((member) => {
      const laidOut = laidOutById.get(member)
      return laidOut ? [laidOut] : []
    })
    if (members.length === 0) continue
    const columnCount = expandedGroupColumnCount(group, members)
    const columns = Array.from({ length: columnCount }, () => ({
      left: Number.POSITIVE_INFINITY,
      right: Number.NEGATIVE_INFINITY,
    }))
    members.forEach((member, index) => {
      const column = columns[index % columnCount]
      column.left = Math.min(column.left, member.x)
      column.right = Math.max(column.right, member.x + member.width)
    })
    const frameLeftRail = frame.x + 8
    const frameRightRail = frame.x + frame.width - 8
    const accessByMember = new Map(
      members.map((member, index) => {
        const column = columns[index % columnCount]
        return [
          member.id,
          {
            leftRailX: Math.max(frameLeftRail, column.left - 8),
            rightRailX: Math.min(frameRightRail, column.right + 8),
          },
        ] as const
      }),
    )
    compoundRouteById.set(group.id, {
      frame,
      stacked: shouldStackExpandedGroup(group, members),
      topRailY: frame.y + 25,
      bottomRailY: frame.y + frame.height - 8,
      accessByMember,
    })
  }
  const perimeterRailY = (
    startY: number,
    endY: number,
    route: NonNullable<ReturnType<typeof compoundRouteById.get>>,
  ) =>
    Math.abs(startY - route.topRailY) + Math.abs(endY - route.topRailY) <=
        Math.abs(startY - route.bottomRailY) +
          Math.abs(endY - route.bottomRailY)
      ? route.topRailY
      : route.bottomRailY
  const memberToBoundary = (
    memberId: number,
    start: Point,
    boundary: Point,
    route: NonNullable<ReturnType<typeof compoundRouteById.get>>,
  ): Point[] => {
    const access = route.accessByMember.get(memberId)
    if (!access) return [start, boundary]
    // Each net owns a boundary port at its pin's height, so the leg stays in
    // the side gutter.
    return compactRoute([
      start,
      { x: access.rightRailX, y: start.y },
      { x: access.rightRailX, y: boundary.y },
      boundary,
    ])
  }
  const boundaryToMember = (
    boundary: Point,
    memberId: number,
    end: Point,
    route: NonNullable<ReturnType<typeof compoundRouteById.get>>,
  ): Point[] => {
    const access = route.accessByMember.get(memberId)
    if (!access) return [boundary, end]
    return compactRoute([
      boundary,
      { x: access.leftRailX, y: boundary.y },
      { x: access.leftRailX, y: end.y },
      end,
    ])
  }
  // ELK rounds the boundary port it routed to, so a stacked group's last leg can
  // miss its member pin by a fraction of a pixel. Slide the trailing run of the
  // routed polyline onto the pin's own height instead of leaving a hairline jog
  // beside the frame. The run is horizontal, so this stays orthogonal.
  const snapRunToPin = (points: Point[], pinY: number, fromEnd: boolean) => {
    const order = fromEnd
      ? [...points.keys()].reverse()
      : [...points.keys()]
    const runY = points[order[0]]?.y
    if (runY == null || runY === pinY) return points
    const snapped = [...points]
    for (const index of order.slice(0, -1)) {
      if (snapped[index].y !== runY) break
      snapped[index] = { x: snapped[index].x, y: pinY }
    }
    return snapped
  }
  // Mirror of the endpoint port ids toElkGraph assigned, so a boundary net can
  // find the lead edge ELK routed for it inside the compound.
  // Route a crossing net on the lattice: ride the planned channel to the gutter
  // beside the target column, hop to the pin's height, then straight in. Every
  // leg lies in space reserved for wires, so nothing crosses a member.
  // Where a crossing net meets the frame: its channel track, or the pin's own
  // height when it needs no horizontal transit.
  const latticeBoundaryY = (
    groupId: number,
    edge: LayoutInputEdge,
    output: boolean,
  ): number | undefined => {
    const lattice = latticeByGroup.get(groupId)
    const frame = groupById.get(groupId)
    if (!lattice || !frame) return undefined
    const track = lattice.trackY(endpointPortIdFor(edge, output))
    return track == null ? undefined : frame.y + track
  }

  const latticeLeg = (
    groupId: number,
    member: number,
    edge: LayoutInputEdge,
    output: boolean,
    boundary: Point,
    pin: Point,
  ): Point[] | undefined => {
    const lattice = latticeByGroup.get(groupId)
    const frame = groupById.get(groupId)
    const index = latticeIndexByGroup.get(groupId)?.get(member)
    if (!lattice || !frame || index == null) return undefined
    const column = lattice.columnOf(index)
    const track = lattice.trackY(endpointPortIdFor(edge, output))
    if (track == null) {
      // Column 0 inbound / last column outbound: the port already faces the
      // pin, so this is one straight run. Correct any residual offset in the
      // frame margin rather than against the member's edge.
      return compactRoute(
        output
          ? [pin, { x: boundary.x, y: pin.y }, boundary]
          : [boundary, { x: boundary.x, y: pin.y }, pin],
      )
    }
    const trackAbs = frame.y + track
    const gutter = frame.x + (output
      ? lattice.gutterRightOf(column)
      : lattice.gutterLeftOf(column))
    return output
      ? compactRoute([
          pin,
          { x: gutter, y: pin.y },
          { x: gutter, y: trackAbs },
          { x: boundary.x, y: trackAbs },
          boundary,
        ])
      : compactRoute([
          boundary,
          // Turn onto the track at the frame edge, so the run stays orthogonal
          // even when the boundary point is not exactly on it.
          { x: boundary.x, y: trackAbs },
          { x: gutter, y: trackAbs },
          { x: gutter, y: pin.y },
          pin,
        ])
  }

  const edges: LayoutGeometry['edges'] = input.edges.map((edge, inputIndex) => {
    const routed = routedByInputIndex.get(inputIndex)
    const points: Point[] = []
    const section = routed?.sections?.[0]
    const fromGroupId = groupIdByMember.get(edge.from)
    const toGroupId = groupIdByMember.get(edge.to)
    const fromRoute =
      fromGroupId == null ? null : compoundRouteById.get(fromGroupId)
    const toRoute =
      toGroupId == null ? null : compoundRouteById.get(toGroupId)
    if (section) {
      let routedPoints = [
        section.startPoint,
        ...(section.bendPoints ?? []),
        section.endPoint,
      ]
      if (fromRoute?.stacked) {
        routedPoints = snapRunToPin(
          routedPoints,
          fallbackPoint(edge.from, true, edge).y,
          false,
        )
      }
      if (toRoute?.stacked) {
        routedPoints = snapRunToPin(
          routedPoints,
          fallbackPoint(edge.to, false, edge).y,
          true,
        )
      }
      if (fromRoute) {
        const start = fallbackPoint(edge.from, true, edge)
        const leg =
          latticeLeg(fromGroupId!, edge.from, edge, true, routedPoints[0], start) ??
          memberToBoundary(edge.from, start, routedPoints[0], fromRoute)
        points.push(...leg.slice(0, -1))
      }
      points.push(...routedPoints)
      if (toRoute) {
        const end = fallbackPoint(edge.to, false, edge)
        const boundary = routedPoints[routedPoints.length - 1]
        const leg =
          latticeLeg(toGroupId!, edge.to, edge, false, boundary, end) ??
          boundaryToMember(boundary, edge.to, end, toRoute)
        points.push(...leg.slice(1))
      }
    } else {
      // Preserve the structural edge even if ELK omits a routed section. This
      // is especially important for grouped register D inputs: without the
      // fallback the driver cone and register render as disconnected islands.
      const start = fallbackPoint(edge.from, true, edge)
      const end = fallbackPoint(edge.to, false, edge)
      if (!fromRoute && toRoute) {
        const boundary = {
          x: toRoute.frame.x,
          y: toRoute.stacked
            ? end.y
            : latticeBoundaryY(toGroupId!, edge, false)
              ?? toRoute.frame.y + toRoute.frame.height / 2,
        }
        const entryX = boundary.x - 8
        points.push(
          start,
          { x: entryX, y: start.y },
          { x: entryX, y: boundary.y },
          ...(latticeLeg(toGroupId!, edge.to, edge, false, boundary, end)
            ?? boundaryToMember(boundary, edge.to, end, toRoute)),
        )
      } else if (fromRoute && !toRoute) {
        const boundary = {
          x: fromRoute.frame.x + fromRoute.frame.width,
          y: fromRoute.stacked
            ? start.y
            : latticeBoundaryY(fromGroupId!, edge, true)
              ?? fromRoute.frame.y + fromRoute.frame.height / 2,
        }
        const exitX = boundary.x + 8
        points.push(
          ...(latticeLeg(fromGroupId!, edge.from, edge, true, boundary, start)
            ?? memberToBoundary(edge.from, start, boundary, fromRoute)),
          { x: exitX, y: boundary.y },
          { x: exitX, y: end.y },
          end,
        )
      } else if (
        fromRoute &&
        toRoute &&
        fromGroupId === toGroupId
      ) {
        const sourceAccess = fromRoute.accessByMember.get(edge.from)
        const targetAccess = toRoute.accessByMember.get(edge.to)
        const railY = perimeterRailY(start.y, end.y, fromRoute)
        points.push(
          start,
          ...(sourceAccess
            ? [
                { x: sourceAccess.rightRailX, y: start.y },
                { x: sourceAccess.rightRailX, y: railY },
              ]
            : []),
          ...(targetAccess
            ? [
                { x: targetAccess.leftRailX, y: railY },
                { x: targetAccess.leftRailX, y: end.y },
              ]
            : []),
          end,
        )
      } else if (fromRoute && toRoute) {
        const fromBoundary = {
          x: fromRoute.frame.x + fromRoute.frame.width,
          y: fromRoute.stacked
            ? start.y
            : latticeBoundaryY(fromGroupId!, edge, true)
              ?? fromRoute.frame.y + fromRoute.frame.height / 2,
        }
        const toBoundary = {
          x: toRoute.frame.x,
          y: toRoute.stacked
            ? end.y
            : latticeBoundaryY(toGroupId!, edge, false)
              ?? toRoute.frame.y + toRoute.frame.height / 2,
        }
        points.push(
          ...(latticeLeg(fromGroupId!, edge.from, edge, true, fromBoundary, start)
            ?? memberToBoundary(edge.from, start, fromBoundary, fromRoute)),
          ...localEdgePoints(fromBoundary, toBoundary).slice(1),
          ...(latticeLeg(toGroupId!, edge.to, edge, false, toBoundary, end)
            ?? boundaryToMember(toBoundary, edge.to, end, toRoute)).slice(1),
        )
      } else {
        points.push(start, end)
      }
    }
    return {
      inputIndex,
      points: compactRoute(points),
    }
  })

  return {
    nodes,
    edges,
    ...(groups.length > 0 ? { groups } : {}),
    width: root.width ?? 0,
    height: root.height ?? 0,
  }
}

export function hydrateLayoutResult(sub: Subgraph, geometry: LayoutGeometry): LaidOutGraph {
  const byId = new Map(sub.nodes.map((node) => [node.id, node]))
  return {
    nodes: geometry.nodes.map((laidOut) => {
      const node = byId.get(laidOut.id)
      if (!node) throw new Error(`layout returned unknown node ${laidOut.id}`)
      return { ...laidOut, node }
    }),
    edges: geometry.edges.map(({ inputIndex, points }) => {
      const edge = sub.edges[inputIndex]
      if (!edge) throw new Error(`layout returned unknown edge ${inputIndex}`)
      return { from: edge.from, to: edge.to, points, edge }
    }),
    ...(geometry.groups ? { groups: geometry.groups } : {}),
    width: geometry.width,
    height: geometry.height,
  }
}

function localEdgePoints(
  start: Point,
  end: Point,
): Point[] {
  const middleX = (start.x + end.x) / 2
  return [
    start,
    { x: middleX, y: start.y },
    { x: middleX, y: end.y },
    end,
  ]
}

function compactRoute(points: Point[]): Point[] {
  const unique = points.filter((point, index) => {
    const previous = points[index - 1]
    return !previous || point.x !== previous.x || point.y !== previous.y
  })
  return unique.filter((point, index) => {
    const previous = unique[index - 1]
    const next = unique[index + 1]
    if (!previous || !next) return true
    const vertical = previous.x === point.x && point.x === next.x
    const horizontal = previous.y === point.y && point.y === next.y
    return !vertical && !horizontal
  })
}

let worker: Worker | null = null
let seq = 0
const pending = new Map<
  number,
  { resolve: (g: LayoutGeometry) => void; reject: (e: Error) => void }
>()
export const LAYOUT_DEADLINE_MS = 10_000

function abortError(): Error {
  const error = new Error('layout aborted')
  error.name = 'AbortError'
  return error
}

function layoutTimeoutError(): Error {
  const error = new Error('layout exceeded the 10 second safety deadline')
  error.name = 'LayoutTimeoutError'
  return error
}

function terminateWorker(instance: Worker, reason: Error) {
  if (worker !== instance) return
  instance.onmessage = null
  instance.onerror = null
  instance.terminate()
  worker = null
  for (const entry of pending.values()) entry.reject(reason)
  pending.clear()
}

function getWorker(): Worker {
  if (worker) return worker
  const w = new Worker(new URL('../../workers/elk.worker.ts', import.meta.url), {
    type: 'module',
  })
  w.onmessage = (ev: MessageEvent<ElkResponse>) => {
    const msg = ev.data
    const entry = pending.get(msg.id)
    if (!entry) return
    pending.delete(msg.id)
    if (msg.ok) entry.resolve(msg.result)
    else entry.reject(new Error(msg.error))
  }
  w.onerror = (ev) => {
    // The worker is dead — drop the singleton so the next layout spawns a
    // fresh one instead of posting into a void forever.
    terminateWorker(w, new Error(ev.message || 'elk worker error'))
  }
  worker = w
  return w
}

/** Load and initialize the reusable ELK worker before the first schematic opens. */
export function prewarmLayoutWorker(): void {
  getWorker()
}

/** Lay out and adapt a Subgraph in the worker. */
function runLayout(
  input: LayoutInput,
  placement: NodePlacement,
  signal?: AbortSignal,
): Promise<LayoutGeometry> {
  const w = getWorker()
  const id = ++seq
  return new Promise<LayoutGeometry>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    let timeout: ReturnType<typeof setTimeout> | undefined
    const onAbort = () => {
      if (!pending.has(id)) return
      // ELK cannot cancel an in-flight layout. Terminating prevents a stale,
      // superseded job from monopolising the singleton ahead of its replacement.
      terminateWorker(w, abortError())
    }
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort)
      if (timeout) clearTimeout(timeout)
    }
    pending.set(id, {
      resolve: (value) => {
        cleanup()
        resolve(value)
      },
      reject: (error) => {
        cleanup()
        reject(error)
      },
    })
    signal?.addEventListener('abort', onAbort, { once: true })
    timeout = setTimeout(
      () => terminateWorker(w, layoutTimeoutError()),
      LAYOUT_DEADLINE_MS,
    )
    const req: ElkRequest = { id, input, placement }
    w.postMessage(req)
  })
}

// Above this size NETWORK_SIMPLEX becomes unsafe in elkjs: on deep datapath
// cones it either overflows the stack or spins for tens of seconds. The robust
// placement is chosen upfront so a large schematic never hangs on a spinner;
// small graphs (the common case) keep the tighter alignment. The catch below is
// a backstop for anything under the threshold that still fails fast.
export const NETWORK_SIMPLEX_NODE_LIMIT = 120
export const NETWORK_SIMPLEX_EDGE_LIMIT = 240

/** The safe upfront node placement for a subgraph's size. */
export function placementForLayout(sub: Subgraph): NodePlacement {
  return sub.nodes.length > NETWORK_SIMPLEX_NODE_LIMIT ||
    sub.edges.length > NETWORK_SIMPLEX_EDGE_LIMIT
    ? 'BRANDES_KOEPF'
    : 'NETWORK_SIMPLEX'
}

export async function layoutSubgraph(
  sub: Subgraph,
  signal?: AbortSignal,
  expandedGroups: ExpandedGroupLayout[] = [],
): Promise<LaidOutGraph> {
  assertRenderableSubgraph(sub)
  if (signal?.aborted) throw abortError()
  const input = prepareLayoutInput(sub, expandedGroups)
  const placement = placementForLayout(sub)
  const cacheKey = layoutGeometryKey(input, placement)
  const cached = cachedLayoutGeometry(cacheKey)
  if (cached) return hydrateLayoutResult(sub, cached)
  if (placement === 'BRANDES_KOEPF') {
    const geometry = await runLayout(input, 'BRANDES_KOEPF', signal)
    cacheLayoutGeometry(cacheKey, geometry)
    return hydrateLayoutResult(sub, geometry)
  }
  try {
    const geometry = await runLayout(input, 'NETWORK_SIMPLEX', signal)
    cacheLayoutGeometry(cacheKey, geometry)
    return hydrateLayoutResult(sub, geometry)
  } catch (error) {
    // Never retry an aborted (superseded) request.
    if (signal?.aborted || (error instanceof Error && error.name === 'LayoutTimeoutError')) {
      throw error
    }
    // A tight layout can fail because of either this topology or transient
    // worker infrastructure. Keep robust fallback geometry under its actual
    // placement so the next equivalent request still retries the preferred
    // tight placement, while a repeat topology failure can reuse the fallback.
    const fallbackKey = layoutGeometryKey(input, 'BRANDES_KOEPF')
    const cachedFallback = cachedLayoutGeometry(fallbackKey)
    if (cachedFallback) return hydrateLayoutResult(sub, cachedFallback)
    const geometry = await runLayout(input, 'BRANDES_KOEPF', signal)
    cacheLayoutGeometry(fallbackKey, geometry)
    return hydrateLayoutResult(sub, geometry)
  }
}
