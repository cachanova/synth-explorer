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
} from '../types'
import type { ElkRequest, ElkResponse } from '../workers/elk.worker'
import type {
  SchemWeaveWorkerRequest,
  SchemWeaveWorkerResponse,
} from '../workers/schemweaveProtocol'
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
  boundaryBundles?: LaidOutBoundaryBundle[]
  schemWeaveSnapshot?: SchemWeaveSnapshot
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

export interface BoundaryBundleSegment {
  start: Point
  end: Point
}

export interface LaidOutBoundaryBundle {
  id: number
  endpoint: { node: number; port: number }
  role: 'input' | 'output'
  width: number
  collector: BoundaryBundleSegment
  spine: BoundaryBundleSegment
  ownerIndexes: number[]
}

export function layoutsShareNode(
  previous: LaidOutGraph | null | undefined,
  next: LaidOutGraph,
): boolean {
  if (!previous) return false
  const previousIds = new Set(previous.nodes.map((node) => node.id))
  return next.nodes.some((node) => previousIds.has(node.id))
}

export function shouldRefitProjection(
  previous: LaidOutGraph | null | undefined,
  next: LaidOutGraph,
  sameDesign: boolean,
  sameProjection: boolean,
): boolean {
  if (!sameDesign) return true
  if (sameProjection) return false
  return !layoutsShareNode(previous, next)
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
  cycleBreaker?: boolean
  boundary: PortBoundaryRole
  boundaryWidth?: number
  boundaryMembers?: BoundaryMember[]
}

export interface LayoutInputEdge {
  from: number
  to: number
  fromPort: string
  toPort: string
  control: boolean
  net?: number
  netBits?: number[]
  netKey?: string
  sourceBoundaryMembers?: EdgeBoundaryMember[]
  targetBoundaryMembers?: EdgeBoundaryMember[]
}

export interface LayoutInput {
  nodes: LayoutInputNode[]
  edges: LayoutInputEdge[]
  groups?: ExpandedGroupLayout[]
}

export const MAX_GLOBAL_LAYOUT_COMPONENTS = 32
export const EXPANDED_GROUP_VERTICAL_LIMIT_MULTIPLIER = 1.5
const EXPANDED_GROUP_NODE_SPACING = 18
const EXPANDED_GROUP_VERTICAL_PADDING = 46

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
  const maxMemberWidth = Math.max(
    1,
    ...members.map((member) => member.width ?? 0),
  )
  const maxMemberHeight = Math.max(
    1,
    ...members.map((member) => member.height ?? 0),
  )
  return Math.min(
    members.length,
    Math.max(
      2,
      Math.ceil(
        Math.sqrt(
          members.length *
          (maxMemberHeight + EXPANDED_GROUP_NODE_SPACING) /
          (maxMemberWidth + EXPANDED_GROUP_NODE_SPACING),
        ),
      )
    ),
  )
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
  edges: Array<{ inputIndex: number; points: Point[]; netBits?: number[] }>
  groups?: LaidOutGroup[]
  boundaryBundles?: Array<{
    id: number
    endpoint: { node: number; port: number }
    role: 'input' | 'output'
    width: number
    collector: BoundaryBundleSegment
    spine: BoundaryBundleSegment
    ownerIndexes: number[]
  }>
  schemWeaveSnapshot?: SchemWeaveSnapshot
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

export type LayoutEngine = 'elk' | 'schemweave'

function layoutGeometryKey(
  input: LayoutInput,
  engine: LayoutEngine,
  placement?: NodePlacement,
): string {
  const layoutInput = engine === 'elk'
    ? {
        ...input,
        edges: input.edges.map(({ netBits: _netBits, netKey: _netKey, ...edge }) =>
          edge
        ),
      }
    : input
  return `${engine}:${placement ?? 'max'}:${JSON.stringify(layoutInput)}`
}

/** SchemWeave is selectable only in local development; ELK remains default. */
export function comparisonLayoutEngine(
  search: string,
  development = import.meta.env.DEV,
): LayoutEngine {
  return development &&
    new URLSearchParams(search).get('layout') === 'schemweave'
    ? 'schemweave'
    : 'elk'
}

function estimatedRetainedBytes(key: string, geometry: LayoutGeometry): number {
  const pointCount = geometry.edges.reduce(
    (total, edge) => total + edge.points.length,
    0,
  )
  const fragmentBitCount = geometry.edges.reduce(
    (total, edge) => total + (edge.netBits?.length ?? 0),
    0,
  )
  // Conservative object/array allowances plus UTF-16 key storage. This is a
  // retained-memory budget, not a wire-size estimate.
  return (
    key.length * 2 +
    geometry.nodes.length * 128 +
    geometry.edges.length * 96 +
    (geometry.groups?.length ?? 0) * 80 +
    (geometry.boundaryBundles?.length ?? 0) * 320 +
    (geometry.schemWeaveSnapshot
      ? geometry.schemWeaveSnapshot.request.graph.nodes.length * 128 +
        geometry.schemWeaveSnapshot.request.graph.edges.length * 96 +
        geometry.schemWeaveSnapshot.layout.nodes.length * 64 +
        geometry.schemWeaveSnapshot.layout.edges.length * 96
      : 0) +
    pointCount * 48 +
    fragmentBitCount * 8 +
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
  const translated = (
    before: LaidOutNode,
    after: LaidOutNode,
  ): ViewportTransform => {
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
  const nearestMember = (
    group: LaidOutNode,
    memberGeometry: LaidOutNode[],
  ) => memberGeometry.reduce((nearest, member) => {
    const distance =
      (member.x - group.x) ** 2 +
      (member.y - group.y) ** 2
    const nearestDistance =
      (nearest.x - group.x) ** 2 +
      (nearest.y - group.y) ** 2
    return distance < nearestDistance ? member : nearest
  })
  for (const group of previous.nodes) {
    if (nextById.has(group.id) || !group.node.members?.length) continue
    const members = group.node.members
      .map((id) => nextById.get(id))
      .filter((node): node is LaidOutNode => node != null)
    if (members.length > 0) return translated(group, nearestMember(group, members))
  }
  for (const group of next.nodes) {
    if (previousById.has(group.id) || !group.node.members?.length) continue
    const members = group.node.members
      .map((id) => previousById.get(id))
      .filter((node): node is LaidOutNode => node != null)
    if (members.length > 0) return translated(nearestMember(group, members), group)
  }
  const candidates = [
    ...preferredIds,
    ...previous.nodes.map((node) => node.id),
  ]
  for (const id of candidates) {
    if (id == null) continue
    const before = previousById.get(id)
    const after = nextById.get(id)
    if (!before || !after) continue
    return translated(before, after)
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

function compareNumberArrays(left: readonly number[], right: readonly number[]): number {
  const common = Math.min(left.length, right.length)
  for (let index = 0; index < common; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return left.length - right.length
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
  const netByBits = new Map<string, number>()
  const netForEdge = (edge: GraphEdge, index: number): number => {
    const boundaryNetBits = [
      ...(edge.source_boundary_members ?? []),
      ...(edge.target_boundary_members ?? []),
    ].flatMap((mapping) => mapping.net_bits)
    const bits = [...new Set(
      boundaryNetBits.length > 0 ? boundaryNetBits : edge.bits,
    )].sort((left, right) => left - right)
    const key = bits.length > 0 ? `bits:${bits.join(',')}` : `edge:${index}`
    const existing = netByBits.get(key)
    if (existing != null) return existing
    const net = netByBits.size
    netByBits.set(key, net)
    return net
  }
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
        cycleBreaker: node.seq === true,
        boundary: boundaryById.get(node.id) ?? 'internal',
        ...(node.member_count != null
          ? { boundaryWidth: node.member_count }
          : {}),
        ...(boundaryMembers != null ? { boundaryMembers } : {}),
      }
    }),
    edges: sub.edges.map((edge, index) => {
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
        net: netForEdge(edge, index),
        netBits: [...new Set(edge.bits)].sort((left, right) => left - right),
        ...(edge.net_name ? { netKey: `name:${edge.net_name}` } : {}),
        ...(sourceBoundaryMembers != null ? { sourceBoundaryMembers } : {}),
        ...(targetBoundaryMembers != null ? { targetBoundaryMembers } : {}),
      }
    }),
    ...(groups.length > 0 ? { groups } : {}),
  }
}

export interface SchemWeavePort {
  id: number
  side: 'east' | 'west'
  offset: number
}

export interface SchemWeaveGraph {
  nodes: Array<{
    id: number
    width: number
    height: number
    cycle_breaker: boolean
    ports: SchemWeavePort[]
  }>
  edges: Array<{
    id: number
    source: { node: number; port: number }
    target: { node: number; port: number }
    net: number
    participates_in_ranking: boolean
  }>
}

export interface SchemWeaveBoundaryBundleConstraint {
  id: number
  endpoint: { node: number; port: number }
  width: number
  members: Array<{ edge: number; slots: number[] }>
}

export interface SchemWeaveLayoutRequest {
  graph: SchemWeaveGraph
  constraints: {
    inputs: number[]
    outputs: number[]
    boundary_bundles?: SchemWeaveBoundaryBundleConstraint[]
  }
}

export interface SchemWeaveLayout {
  nodes: LayoutGeometry['nodes']
  edges: Array<{ id: number; points: Point[] }>
  boundary_bundles?: Array<{
    id: number
    endpoint: { node: number; port: number }
    role: 'input' | 'output'
    width: number
    collector: BoundaryBundleSegment
    spine: BoundaryBundleSegment
    members: Array<{ edge: number; slots: number[]; tap: Point }>
  }>
  width: number
  height: number
}

export interface SchemWeaveSnapshot {
  request: SchemWeaveLayoutRequest
  layout: SchemWeaveLayout
  catalog: SchemWeaveGraphCatalog
  expandedGroups?: ExpandedGroupLayout[]
}

export interface SchemWeaveExpansionRequest {
  compact_graph: SchemWeaveGraph
  compact_layout: SchemWeaveLayout
  expanded_graph: SchemWeaveGraph
  reference_height: number
  expansion: {
    anchor: number
    members: number[]
    boundary_trunks: Array<{
      expanded_edge: number
      compact_edge: number
    }>
  }
  constraints: SchemWeaveLayoutRequest['constraints']
}

export interface SchemWeaveCollapseRequest {
  expanded_graph: SchemWeaveGraph
  expanded_layout: SchemWeaveLayout
  compact_graph: SchemWeaveGraph
  expansion: SchemWeaveExpansionRequest['expansion']
  constraints: SchemWeaveLayoutRequest['constraints']
}

export interface SchemWeaveGraphCatalog {
  graph: SchemWeaveGraph
  portIds: Map<string, number>
  fragments: Array<{
    inputIndex: number
    netKey: string
    netBits?: number[]
    sourceBundle?: {
      endpoint: { node: number; port: number }
      width: number
      slots: number[]
    }
    targetBundle?: {
      endpoint: { node: number; port: number }
      width: number
      slots: number[]
    }
  }>
}

/** Map the renderer's fixed-pin contract to SchemWeave's numeric graph ABI. */
function buildSchemWeaveGraph(input: LayoutInput): SchemWeaveGraphCatalog {
  const pins = collectPinCatalog(input.edges)
  const nodeById = new Map(input.nodes.map((node) => [node.id, node]))
  const controlPins = new Map<number, Map<string, ControlRole>>()
  for (const edge of input.edges) {
    const node = nodeById.get(edge.to)
    if (!edge.control || !node?.register) continue
    let controls = controlPins.get(edge.to)
    if (!controls) {
      controls = new Map()
      controlPins.set(edge.to, controls)
    }
    controls.set(edge.toPort, controlRoleForPin(edge.toPort))
  }

  const portIds = new Map<string, number>()
  const nodes = [...input.nodes]
    .sort((left, right) => left.id - right.id)
    .map((node) => {
      const incoming = pins.incoming.get(node.id) ?? []
      const outgoing = pins.outgoing.get(node.id) ?? []
      const { width, height } = dimensionsForPins(
        node,
        incoming.length,
        outgoing.length,
      )
      const ports: SchemWeavePort[] = []
      const add = (
        key: string,
        side: SchemWeavePort['side'],
        offset: number,
      ) => {
        const id = ports.length
        ports.push({ id, side, offset })
        portIds.set(`${node.id}:${key}`, id)
      }
      if (node.register) {
        const body = Math.min(height, REG_BODY_HEIGHT)
        add('in', 'west', body * REG_DATA_IN_Y_FRAC)
        const controls = [...(controlPins.get(node.id)?.entries() ?? [])].sort(
          ([pinA, roleA], [pinB, roleB]) =>
            registerControlYFraction(roleA) -
              registerControlYFraction(roleB) ||
            pinA.localeCompare(pinB),
        )
        for (const [pin, role] of controls) {
          add(
            `control:${pin}`,
            'west',
            body * registerControlYFraction(role),
          )
        }
        add('out', 'east', body * REG_DATA_OUT_Y_FRAC)
      } else {
        const body = pinBodyHeight(node, height)
        incoming.forEach((pin, index) =>
          add(
            `i:${pin}`,
            'west',
            ((index + 1) * body) / (incoming.length + 1),
          ),
        )
        outgoing.forEach((pin, index) =>
          add(
            `o:${pin}`,
            'east',
            ((index + 1) * body) / (outgoing.length + 1),
          ),
        )
      }
      return {
        id: node.id,
        width,
        height,
        cycle_breaker: node.cycleBreaker === true,
        ports,
      }
    })

  const portId = (node: number, key: string): number => {
    const id = portIds.get(`${node}:${key}`)
    if (id == null) throw new Error(`missing layout port ${node}:${key}`)
    return id
  }
  const endpoints = input.edges.map((edge) => {
    const sourceNode = nodeById.get(edge.from)
    const targetNode = nodeById.get(edge.to)
    if (!sourceNode || !targetNode) {
      throw new Error('layout edge references an unknown node')
    }
    const sourceKey = sourceNode.register ? 'out' : `o:${edge.fromPort}`
    const targetKey = targetNode.register
      ? edge.control
        ? `control:${edge.toPort}`
        : 'in'
      : `i:${edge.toPort}`
    return {
      source: { node: edge.from, port: portId(edge.from, sourceKey) },
      target: { node: edge.to, port: portId(edge.to, targetKey) },
    }
  })

  interface BoundarySide {
    endpoint: { node: number; port: number }
    width: number
    entries: Array<{ slot: number; netBits: number[] }>
  }
  const boundarySide = (
    role: 'input' | 'output',
    nodeId: number,
    endpoint: { node: number; port: number },
    mappings: EdgeBoundaryMember[] | undefined,
  ): BoundarySide | undefined => {
    if (!mappings || mappings.length === 0) return undefined
    const node = nodeById.get(nodeId)
    if (!node) throw new Error(`boundary bundle references unknown node ${nodeId}`)
    if (node.boundary === 'internal') return undefined
    if (node.boundary !== role) {
      throw new Error(
        `boundary bundle ${role} metadata references ${node.boundary} node ${nodeId}`,
      )
    }
    const slotByMember = new Map(
      node.boundaryMembers?.map((member) => [member.member, member.bit] as const),
    )
    const entries = normalizeEdgeBoundaryMembers(
      mappings,
      node.boundaryMembers,
    )?.map((mapping) => {
      const slot = slotByMember.get(mapping.member)
      if (slot == null) {
        throw new Error(
          `boundary bundle node ${nodeId} has no declaration slot for member ${mapping.member}`,
        )
      }
      const netBits = [...new Set(mapping.net_bits)]
        .sort((left, right) => left - right)
      if (netBits.length === 0) {
        throw new Error(
          `${role} endpoint ${endpoint.node}:${endpoint.port} slot ${slot} has no electrical net bits`,
        )
      }
      return { slot, netBits }
    }) ?? []
    if (entries.length === 0) return undefined
    const requiredWidth = Math.max(...entries.map((entry) => entry.slot)) + 1
    const width = node.boundaryWidth ??
      Math.max(
        requiredWidth,
        ...(node.boundaryMembers?.map((member) => member.bit + 1) ?? [1]),
      )
    if (width < requiredWidth) {
      throw new Error(
        `boundary bundle node ${nodeId} width ${width} excludes slot ${requiredWidth - 1}`,
      )
    }
    return { endpoint, width, entries }
  }

  interface ElectricalCandidate {
    id: number
    inputIndex: number
    netKey: string
    netBits?: number[]
    source?: {
      endpoint: { node: number; port: number }
      width: number
      slots: Set<number>
    }
    target?: {
      endpoint: { node: number; port: number }
      width: number
      slots: Set<number>
    }
    sourceCohorts: number[][]
    targetCohorts: number[][]
  }
  const candidates: ElectricalCandidate[] = []
  input.edges.forEach((edge, inputIndex) => {
    const endpoint = endpoints[inputIndex]
    const source = boundarySide(
      'input',
      edge.from,
      endpoint.source,
      edge.sourceBoundaryMembers,
    )
    const target = boundarySide(
      'output',
      edge.to,
      endpoint.target,
      edge.targetBoundaryMembers,
    )
    const byNet = new Map<string, ElectricalCandidate>()
    const membershipsByBit = new Map<number, {
      sourceSlots: Set<number>
      targetSlots: Set<number>
    }>()
    const addMemberships = (
      side: 'sourceSlots' | 'targetSlots',
      entries: readonly { slot: number; netBits: number[] }[],
    ) => {
      for (const entry of entries) {
        for (const bit of entry.netBits) {
          const memberships = membershipsByBit.get(bit) ?? {
            sourceSlots: new Set<number>(),
            targetSlots: new Set<number>(),
          }
          memberships[side].add(entry.slot)
          membershipsByBit.set(bit, memberships)
        }
      }
    }
    addMemberships('sourceSlots', source?.entries ?? [])
    addMemberships('targetSlots', target?.entries ?? [])
    const bitsBySlotSignature = new Map<string, {
      bits: number[]
      sourceSlots: number[]
      targetSlots: number[]
    }>()
    for (const [bit, memberships] of [...membershipsByBit].sort(
      ([left], [right]) => left - right,
    )) {
      const sourceSlots = [...memberships.sourceSlots]
        .sort((left, right) => left - right)
      const targetSlots = [...memberships.targetSlots]
        .sort((left, right) => left - right)
      const signature = `source:${sourceSlots.join(',')};target:${targetSlots.join(',')}`
      const cohort = bitsBySlotSignature.get(signature) ?? {
        bits: [],
        sourceSlots,
        targetSlots,
      }
      cohort.bits.push(bit)
      bitsBySlotSignature.set(signature, cohort)
    }
    for (const cohort of [...bitsBySlotSignature.values()].sort((left, right) =>
      compareNumberArrays(left.bits, right.bits)
    )) {
      const netKey = `bits:${cohort.bits.join(',')}`
      byNet.set(netKey, {
        id: -1,
        inputIndex,
        netKey,
        netBits: cohort.bits,
        ...(cohort.sourceSlots.length > 0 && source
          ? {
              source: {
                endpoint: source.endpoint,
                width: source.width,
                slots: new Set(cohort.sourceSlots),
              },
            }
          : {}),
        ...(cohort.targetSlots.length > 0 && target
          ? {
              target: {
                endpoint: target.endpoint,
                width: target.width,
                slots: new Set(cohort.targetSlots),
              },
            }
          : {}),
        sourceCohorts: [],
        targetCohorts: [],
      })
    }
    if (byNet.size === 0) {
      const netBits = [...new Set(edge.netBits ?? [])]
        .sort((left, right) => left - right)
      const netKey = edge.netKey ??
        (netBits.length > 0
          ? `bits:${netBits.join(',')}`
          : `logical:${edge.net ?? inputIndex}`)
      byNet.set(netKey, {
        id: -1,
        inputIndex,
        netKey,
        ...(netBits.length > 0 ? { netBits } : {}),
        sourceCohorts: [],
        targetCohorts: [],
      })
    }
    for (const candidate of [...byNet.values()].sort((left, right) =>
      left.netKey.localeCompare(right.netKey)
    )) {
      candidate.id = candidates.length
      candidates.push(candidate)
    }
  })

  const formatNetKey = (key: string): string =>
    `[${key.startsWith('bits:') ? key.slice('bits:'.length) : key}]`
  const slotElectricalKey = new Map<string, string>()
  const cohortBuilders = new Map<string, {
    role: 'input' | 'output'
    endpoint: { node: number; port: number }
    width: number
    ownersBySlot: Map<number, Set<number>>
  }>()
  const addBoundaryOwner = (
    role: 'input' | 'output',
    candidate: ElectricalCandidate,
    owner: NonNullable<ElectricalCandidate['source']>,
  ) => {
    for (const slot of owner.slots) {
      const slotKey = `${role}:${owner.endpoint.node}:${owner.endpoint.port}:${slot}`
      const prior = slotElectricalKey.get(slotKey)
      if (prior != null && prior !== candidate.netKey) {
        throw new Error(
          `${role} endpoint ${owner.endpoint.node}:${owner.endpoint.port} slot ${slot} ` +
          `has conflicting electrical net bits ${formatNetKey(prior)} and ${formatNetKey(candidate.netKey)}`,
        )
      }
      slotElectricalKey.set(slotKey, candidate.netKey)
    }
    const builderKey =
      `${role}:${owner.endpoint.node}:${owner.endpoint.port}:${candidate.netKey}`
    let builder = cohortBuilders.get(builderKey)
    if (!builder) {
      builder = {
        role,
        endpoint: owner.endpoint,
        width: owner.width,
        ownersBySlot: new Map(),
      }
      cohortBuilders.set(builderKey, builder)
    } else if (builder.width !== owner.width) {
      throw new Error(
        `inconsistent boundary bundle width for node ${owner.endpoint.node}`,
      )
    }
    for (const slot of owner.slots) {
      const owners = builder.ownersBySlot.get(slot) ?? new Set<number>()
      owners.add(candidate.id)
      builder.ownersBySlot.set(slot, owners)
    }
  }
  for (const candidate of candidates) {
    if (candidate.source) addBoundaryOwner('input', candidate, candidate.source)
    if (candidate.target) addBoundaryOwner('output', candidate, candidate.target)
  }
  for (const builder of [...cohortBuilders.values()].sort((left, right) =>
    (left.role === right.role ? 0 : left.role === 'input' ? -1 : 1) ||
    left.endpoint.node - right.endpoint.node ||
    left.endpoint.port - right.endpoint.port
  )) {
    const slotsByOwnerSet = new Map<string, number[]>()
    for (const [slot, owners] of [...builder.ownersBySlot].sort(
      ([left], [right]) => left - right,
    )) {
      const ownerKey = [...owners].sort((left, right) => left - right).join(',')
      const slots = slotsByOwnerSet.get(ownerKey) ?? []
      slots.push(slot)
      slotsByOwnerSet.set(ownerKey, slots)
    }
    for (const [ownerKey, slots] of [...slotsByOwnerSet].sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      for (const ownerId of ownerKey.split(',').map(Number)) {
        const candidate = candidates[ownerId]
        const cohorts = builder.role === 'input'
          ? candidate.sourceCohorts
          : candidate.targetCohorts
        cohorts.push(slots)
      }
    }
  }

  const netIds = new Map(
    [...new Set(candidates.map((candidate) => candidate.netKey))]
      .sort()
      .map((key, index) => [key, index] as const),
  )
  const fragments: SchemWeaveGraphCatalog['fragments'] = []
  const edges: SchemWeaveGraph['edges'] = []
  for (const candidate of candidates) {
    candidate.sourceCohorts.sort(compareNumberArrays)
    candidate.targetCohorts.sort(compareNumberArrays)
    const fragmentCount = Math.max(
      1,
      candidate.sourceCohorts.length,
      candidate.targetCohorts.length,
    )
    const endpoint = endpoints[candidate.inputIndex]
    for (let fragmentIndex = 0; fragmentIndex < fragmentCount; fragmentIndex += 1) {
      const sourceSlots = candidate.sourceCohorts.length > 0
        ? candidate.sourceCohorts[fragmentIndex % candidate.sourceCohorts.length]
        : undefined
      const targetSlots = candidate.targetCohorts.length > 0
        ? candidate.targetCohorts[fragmentIndex % candidate.targetCohorts.length]
        : undefined
      const id = edges.length
      edges.push({
        id,
        source: endpoint.source,
        target: endpoint.target,
        net: netIds.get(candidate.netKey)!,
        participates_in_ranking: true,
      })
      fragments.push({
        inputIndex: candidate.inputIndex,
        netKey: candidate.netKey,
        ...(candidate.netBits ? { netBits: candidate.netBits } : {}),
        ...(sourceSlots && candidate.source
          ? {
              sourceBundle: {
                endpoint: candidate.source.endpoint,
                width: candidate.source.width,
                slots: sourceSlots,
              },
            }
          : {}),
        ...(targetSlots && candidate.target
          ? {
              targetBundle: {
                endpoint: candidate.target.endpoint,
                width: candidate.target.width,
                slots: targetSlots,
              },
            }
          : {}),
      })
    }
  }
  if (edges.length > MAX_GRAPH_EDGES) {
    throw new Error(
      `cone too dense (${edges.length} electrical layout edges after boundary expansion; ` +
      `limit ${MAX_GRAPH_EDGES}) — reduce depth or pick a narrower signal`,
    )
  }
  return { graph: { nodes, edges }, portIds, fragments }
}

export function toSchemWeaveGraph(input: LayoutInput): SchemWeaveGraph {
  return buildSchemWeaveGraph(input).graph
}

function boundaryBundleConstraints(
  catalog: SchemWeaveGraphCatalog,
): SchemWeaveBoundaryBundleConstraint[] {
  const builders = new Map<string, {
    role: 'input' | 'output'
    endpoint: { node: number; port: number }
    width: number
    members: Array<{ edge: number; slots: number[] }>
  }>()
  const addMember = (
    role: 'input' | 'output',
    edgeIndex: number,
    owner: NonNullable<
      SchemWeaveGraphCatalog['fragments'][number]['sourceBundle']
    > | undefined,
  ) => {
    if (!owner) return
    const key = `${role}:${owner.endpoint.node}:${owner.endpoint.port}`
    const existing = builders.get(key)
    if (existing && existing.width !== owner.width) {
      throw new Error(
        `inconsistent boundary bundle width for node ${owner.endpoint.node}`,
      )
    }
    const builder = existing ?? {
      role,
      endpoint: owner.endpoint,
      width: owner.width,
      members: [],
    }
    builder.members.push({ edge: edgeIndex, slots: owner.slots })
    builders.set(key, builder)
  }
  catalog.fragments.forEach((fragment, edgeIndex) => {
    addMember('input', edgeIndex, fragment.sourceBundle)
    addMember('output', edgeIndex, fragment.targetBundle)
  })

  return [...builders.values()]
    .sort((left, right) =>
      (left.role === right.role ? 0 : left.role === 'input' ? -1 : 1) ||
      left.endpoint.node - right.endpoint.node ||
      left.endpoint.port - right.endpoint.port,
    )
    .map((bundle, id) => ({
      id,
      endpoint: bundle.endpoint,
      width: bundle.width,
      members: bundle.members.sort((left, right) => left.edge - right.edge),
    }))
}

/** Wrap graph geometry and exact grouped-boundary semantics for WASM. */
export function buildSchemWeaveLayoutRequest(
  input: LayoutInput,
): {
  request: SchemWeaveLayoutRequest
  catalog: SchemWeaveGraphCatalog
} {
  const catalog = buildSchemWeaveGraph(input)
  const boundaryIds = (boundary: LayoutInputNode['boundary']) =>
    input.nodes
      .filter((node) => node.boundary === boundary)
      .map((node) => node.id)
      .sort((left, right) => left - right)
  const boundaryBundles = boundaryBundleConstraints(catalog)
  return {
    catalog,
    request: {
      graph: catalog.graph,
      constraints: {
        inputs: boundaryIds('input'),
        outputs: boundaryIds('output'),
        ...(boundaryBundles.length > 0
          ? { boundary_bundles: boundaryBundles }
          : {}),
      },
    },
  }
}

export function toSchemWeaveLayoutRequest(
  input: LayoutInput,
): SchemWeaveLayoutRequest {
  return buildSchemWeaveLayoutRequest(input).request
}

function fragmentSignature(
  edge: SchemWeaveGraph['edges'][number],
  fragment: SchemWeaveGraphCatalog['fragments'][number],
): string {
  const sourceSlots = fragment.sourceBundle?.slots.join(',') ?? ''
  const targetSlots = fragment.targetBundle?.slots.join(',') ?? ''
  return (
    `${edge.source.node}:${edge.source.port}->` +
    `${edge.target.node}:${edge.target.port}|${fragment.netKey}|` +
    `source:${sourceSlots}|target:${targetSlots}`
  )
}

function boundaryFragmentKey(
  edge: SchemWeaveGraph['edges'][number],
  fragment: SchemWeaveGraphCatalog['fragments'][number],
  members: ReadonlySet<number>,
  anchor?: number,
): string | null {
  const sourceInside = anchor == null
    ? members.has(edge.source.node)
    : edge.source.node === anchor
  const targetInside = anchor == null
    ? members.has(edge.target.node)
    : edge.target.node === anchor
  if (sourceInside === targetInside) return null
  return sourceInside
    ? `out:${edge.target.node}:${edge.target.port}|${fragment.netKey}`
    : `in:${edge.source.node}:${edge.source.port}|${fragment.netKey}`
}

/**
 * Preserve compact edge ids for retained geometry and assign each replacement
 * boundary edge to the exact collapsed trunk it supersedes.
 */
export function buildSchemWeaveExpansionRequest(
  compact: SchemWeaveSnapshot,
  expandedInput: LayoutInput,
  group: ExpandedGroupLayout,
): {
  request: SchemWeaveExpansionRequest
  expandedRequest: SchemWeaveLayoutRequest
  catalog: SchemWeaveGraphCatalog
} {
  const expanded = buildSchemWeaveLayoutRequest(expandedInput)
  const compactGraph = compact.request.graph
  const compactFragments = compact.catalog.fragments
  const members = new Set(group.members)
  const compactNodeById = new Map(
    compactGraph.nodes.map((node) => [node.id, node] as const),
  )
  const portEntriesByNode = (
    catalog: SchemWeaveGraphCatalog,
  ) => {
    const byNode = new Map<number, Array<[string, number]>>()
    for (const [key, port] of catalog.portIds) {
      const separator = key.indexOf(':')
      const node = Number(key.slice(0, separator))
      const entries = byNode.get(node) ?? []
      entries.push([key, port])
      byNode.set(node, entries)
    }
    for (const entries of byNode.values()) {
      entries.sort(([left], [right]) => left.localeCompare(right))
    }
    return byNode
  }
  const compactPortsByNode = portEntriesByNode(compact.catalog)
  const expandedPortsByNode = portEntriesByNode(expanded.catalog)
  const portRemapByNode = new Map<number, Map<number, number>>()
  const normalizedNodes = expanded.request.graph.nodes.map((node) => {
    if (members.has(node.id)) return node
    const compactNode = compactNodeById.get(node.id)
    if (!compactNode) {
      throw new Error(`expanded projection introduced retained node ${node.id}`)
    }
    if (
      node.width !== compactNode.width ||
      node.height !== compactNode.height ||
      node.cycle_breaker !== compactNode.cycle_breaker
    ) {
      throw new Error(`expanded projection changed retained node ${node.id}`)
    }
    const compactPorts = compactPortsByNode.get(node.id) ?? []
    const expandedPorts = expandedPortsByNode.get(node.id) ?? []
    if (
      compactPorts.length !== expandedPorts.length ||
      compactPorts.some(([key], index) => key !== expandedPorts[index][0])
    ) {
      throw new Error(`expanded projection changed retained pins on node ${node.id}`)
    }
    const compactPortById = new Map(
      compactNode.ports.map((port) => [port.id, port] as const),
    )
    const expandedPortById = new Map(
      node.ports.map((port) => [port.id, port] as const),
    )
    const remap = new Map<number, number>()
    compactPorts.forEach(([key, compactPortId], index) => {
      const expandedPortId = expandedPorts[index][1]
      const compactPort = compactPortById.get(compactPortId)
      const expandedPort = expandedPortById.get(expandedPortId)
      if (
        !compactPort ||
        !expandedPort ||
        compactPort.side !== expandedPort.side ||
        compactPort.offset !== expandedPort.offset
      ) {
        throw new Error(`expanded projection changed retained pin ${key}`)
      }
      remap.set(expandedPortId, compactPortId)
    })
    portRemapByNode.set(node.id, remap)
    return compactNode
  })
  const remapEndpoint = (endpoint: { node: number; port: number }) => {
    const port = portRemapByNode.get(endpoint.node)?.get(endpoint.port)
    return port == null ? endpoint : { ...endpoint, port }
  }
  const expandedGraph: SchemWeaveGraph = {
    nodes: normalizedNodes,
    edges: expanded.request.graph.edges.map((edge) => ({
      ...edge,
      source: remapEndpoint(edge.source),
      target: remapEndpoint(edge.target),
    })),
  }
  const compactRetainedBySignature = new Map<string, number[]>()
  const compactTrunksByKey = new Map<string, number[]>()

  compactGraph.edges.forEach((edge) => {
    const fragment = compactFragments[edge.id]
    if (!fragment) {
      throw new Error(`compact SchemWeave snapshot is missing edge ${edge.id}`)
    }
    const boundaryKey = boundaryFragmentKey(
      edge,
      fragment,
      members,
      group.id,
    )
    const catalog = boundaryKey == null
      ? compactRetainedBySignature
      : compactTrunksByKey
    const key = boundaryKey ?? fragmentSignature(edge, fragment)
    const ids = catalog.get(key) ?? []
    ids.push(edge.id)
    catalog.set(key, ids)
  })
  for (const ids of [
    ...compactRetainedBySignature.values(),
    ...compactTrunksByKey.values(),
  ]) {
    ids.sort((left, right) => left - right)
  }

  const boundaryByKey = new Map<string, number[]>()
  const retainedAssignments = new Map<number, number>()
  const internalEdges: number[] = []
  expandedGraph.edges.forEach((edge) => {
    const fragment = expanded.catalog.fragments[edge.id]
    const sourceMember = members.has(edge.source.node)
    const targetMember = members.has(edge.target.node)
    if (sourceMember !== targetMember) {
      const key = boundaryFragmentKey(edge, fragment, members)
      if (key == null) throw new Error('failed to classify expansion boundary edge')
      const ids = boundaryByKey.get(key) ?? []
      ids.push(edge.id)
      boundaryByKey.set(key, ids)
      return
    }
    if (sourceMember) {
      internalEdges.push(edge.id)
      return
    }
    const key = fragmentSignature(edge, fragment)
    const compactIds = compactRetainedBySignature.get(key)
    const compactId = compactIds?.shift()
    if (compactId == null) {
      throw new Error(
        `expanded projection changed retained electrical edge ${key}`,
      )
    }
    retainedAssignments.set(edge.id, compactId)
  })
  const unmatchedRetained = [...compactRetainedBySignature.entries()]
    .find(([, ids]) => ids.length > 0)
  if (unmatchedRetained) {
    throw new Error(
      `expanded projection omitted retained electrical edge ${unmatchedRetained[0]}`,
    )
  }

  const boundaryAssignments = new Map<number, number>()
  const boundaryTrunks = new Map<number, number>()
  for (const [key, compactIds] of compactTrunksByKey) {
    const expandedIds = boundaryByKey.get(key) ?? []
    if (expandedIds.length < compactIds.length) {
      throw new Error(`expanded group omitted collapsed boundary trunk ${key}`)
    }
    compactIds.forEach((compactId, index) => {
      const expandedId = expandedIds[index]
      boundaryAssignments.set(expandedId, compactId)
      boundaryTrunks.set(expandedId, compactId)
    })
    expandedIds.slice(compactIds.length).forEach((expandedId) => {
      boundaryTrunks.set(expandedId, compactIds[0])
    })
    boundaryByKey.delete(key)
  }
  const unmatchedBoundary = [...boundaryByKey.keys()][0]
  if (unmatchedBoundary) {
    throw new Error(
      `expanded group introduced an unmapped boundary edge ${unmatchedBoundary}`,
    )
  }

  let nextId = compactGraph.edges.length
  const remappedId = new Map<number, number>([
    ...retainedAssignments,
    ...boundaryAssignments,
  ])
  for (const oldId of [
    ...boundaryTrunks.keys(),
    ...internalEdges,
  ].sort((left, right) => left - right)) {
    if (!remappedId.has(oldId)) remappedId.set(oldId, nextId++)
  }
  if (nextId !== expandedGraph.edges.length) {
    throw new Error('expanded electrical edge ids are not contiguous')
  }

  const compactEdgeById = new Map(
    compactGraph.edges.map((edge) => [edge.id, edge] as const),
  )
  const edges = expandedGraph.edges
    .map((edge) => {
      const id = remappedId.get(edge.id)
      if (id == null) throw new Error(`failed to remap expanded edge ${edge.id}`)
      const compactId = retainedAssignments.get(edge.id) ??
        boundaryTrunks.get(edge.id)
      return {
        ...edge,
        id,
        ...(compactId == null
          ? {}
          : { net: compactEdgeById.get(compactId)!.net }),
      }
    })
    .sort((left, right) => left.id - right.id)
  const fragments = Array.from(
    { length: expanded.catalog.fragments.length },
    () => null as SchemWeaveGraphCatalog['fragments'][number] | null,
  )
  expanded.catalog.fragments.forEach((fragment, oldId) => {
    const id = remappedId.get(oldId)
    if (id == null) throw new Error(`failed to remap fragment ${oldId}`)
    fragments[id] = fragment
  })
  if (fragments.some((fragment) => fragment == null)) {
    throw new Error('expanded electrical fragment ids are not contiguous')
  }
  const remapBundleMembers = (
    bundle: SchemWeaveBoundaryBundleConstraint,
  ): SchemWeaveBoundaryBundleConstraint => ({
    ...bundle,
    members: bundle.members.map((member) => {
      const edge = remappedId.get(member.edge)
      if (edge == null) {
        throw new Error(`failed to remap boundary bundle edge ${member.edge}`)
      }
      return { ...member, edge }
    }),
  })
  const constraints = {
    ...expanded.request.constraints,
    ...(expanded.request.constraints.boundary_bundles
      ? {
          boundary_bundles:
            expanded.request.constraints.boundary_bundles.map((bundle) =>
              remapBundleMembers({
                ...bundle,
                endpoint: remapEndpoint(bundle.endpoint),
              })
            ),
        }
      : {}),
  }
  const catalog: SchemWeaveGraphCatalog = {
    ...expanded.catalog,
    graph: { nodes: expandedGraph.nodes, edges },
    fragments: fragments as SchemWeaveGraphCatalog['fragments'],
  }

  return {
    catalog,
    expandedRequest: {
      ...expanded.request,
      graph: catalog.graph,
      constraints,
    },
    request: {
      compact_graph: compactGraph,
      compact_layout: compact.layout,
      expanded_graph: catalog.graph,
      reference_height: group.referenceHeight ?? compact.layout.height,
      expansion: {
        anchor: group.id,
        members: [...group.members].sort((left, right) => left - right),
        boundary_trunks: [...boundaryTrunks]
          .map(([oldExpandedId, compactId]) => ({
            expanded_edge: remappedId.get(oldExpandedId)!,
            compact_edge: compactId,
          }))
          .sort((left, right) =>
            left.expanded_edge - right.expanded_edge ||
            left.compact_edge - right.compact_edge
          ),
      },
      constraints,
    },
  }
}

/**
 * Reconstruct the exact expansion contract in reverse so the engine can
 * collapse one group without moving any other active group.
 */
export function buildSchemWeaveCollapseRequest(
  expanded: SchemWeaveSnapshot,
  expandedInput: LayoutInput,
  compactInput: LayoutInput,
  group: ExpandedGroupLayout,
): {
  request: SchemWeaveCollapseRequest
  compactRequest: SchemWeaveLayoutRequest
  catalog: SchemWeaveGraphCatalog
} {
  const compact = buildSchemWeaveLayoutRequest(compactInput)
  const reconstructed = buildSchemWeaveExpansionRequest(
    {
      request: compact.request,
      layout: expanded.layout,
      catalog: compact.catalog,
    },
    expandedInput,
    group,
  )
  const portKeyByEndpoint = (catalog: SchemWeaveGraphCatalog) => {
    const keys = new Map<string, string>()
    for (const [key, port] of catalog.portIds) {
      const separator = key.indexOf(':')
      const node = key.slice(0, separator)
      keys.set(`${node}:${port}`, key.slice(separator + 1))
    }
    return keys
  }
  const currentPortKeys = portKeyByEndpoint(expanded.catalog)
  const reconstructedPortKeys = portKeyByEndpoint(reconstructed.catalog)
  const semanticNodes = (
    graph: SchemWeaveGraph,
    portKeys: Map<string, string>,
  ) => graph.nodes.map((node) => ({
    id: node.id,
    width: node.width,
    height: node.height,
    cycle_breaker: node.cycle_breaker,
    ports: node.ports.map((port) => ({
      key: portKeys.get(`${node.id}:${port.id}`),
      side: port.side,
      offset: port.offset,
    })).sort((left, right) => (left.key ?? '').localeCompare(right.key ?? '')),
  })).sort((left, right) => left.id - right.id)
  if (
    JSON.stringify(semanticNodes(expanded.request.graph, currentPortKeys)) !==
    JSON.stringify(
      semanticNodes(
        reconstructed.expandedRequest.graph,
        reconstructedPortKeys,
      ),
    )
  ) {
    throw new Error('current SchemWeave snapshot changed collapse nodes')
  }
  const edgeSignature = (
    edge: SchemWeaveGraph['edges'][number],
    fragment: SchemWeaveGraphCatalog['fragments'][number],
    portKeys: Map<string, string>,
  ) => [
    `${edge.source.node}:${portKeys.get(`${edge.source.node}:${edge.source.port}`)}`,
    `${edge.target.node}:${portKeys.get(`${edge.target.node}:${edge.target.port}`)}`,
    fragment.netKey,
    fragment.sourceBundle?.slots.join(',') ?? '',
    fragment.targetBundle?.slots.join(',') ?? '',
    edge.participates_in_ranking,
  ].join('|')
  const reconstructedIdsBySignature = new Map<string, number[]>()
  for (const edge of reconstructed.expandedRequest.graph.edges) {
    const fragment = reconstructed.catalog.fragments[edge.id]
    if (!fragment) {
      throw new Error(`reconstructed collapse graph omitted edge ${edge.id}`)
    }
    const signature = edgeSignature(
      edge,
      fragment,
      reconstructedPortKeys,
    )
    const ids = reconstructedIdsBySignature.get(signature) ?? []
    ids.push(edge.id)
    reconstructedIdsBySignature.set(signature, ids)
  }
  const remappedEdgeId = new Map<number, number>()
  for (const edge of [...expanded.request.graph.edges].sort(
    (left, right) => left.id - right.id,
  )) {
    const fragment = expanded.catalog.fragments[edge.id]
    if (!fragment) {
      throw new Error(`current SchemWeave snapshot omitted edge ${edge.id}`)
    }
    const signature = edgeSignature(edge, fragment, currentPortKeys)
    const ids = reconstructedIdsBySignature.get(signature)
    const id = ids?.shift()
    if (id == null) {
      throw new Error('current SchemWeave snapshot changed collapse edges')
    }
    remappedEdgeId.set(edge.id, id)
  }
  if ([...reconstructedIdsBySignature.values()].some((ids) => ids.length > 0)) {
    throw new Error('current SchemWeave snapshot omitted collapse edges')
  }
  const remapEndpoint = (endpoint: { node: number; port: number }) => {
    const key = currentPortKeys.get(`${endpoint.node}:${endpoint.port}`)
    const port = key == null
      ? undefined
      : reconstructed.catalog.portIds.get(`${endpoint.node}:${key}`)
    if (port == null) {
      throw new Error('current SchemWeave snapshot changed collapse ports')
    }
    return { node: endpoint.node, port }
  }
  const remappedLayout: SchemWeaveLayout = {
    ...expanded.layout,
    edges: expanded.layout.edges.map((edge) => {
      const id = remappedEdgeId.get(edge.id)
      if (id == null) {
        throw new Error(`current SchemWeave layout omitted edge ${edge.id}`)
      }
      return { ...edge, id }
    }).sort((left, right) => left.id - right.id),
    ...(expanded.layout.boundary_bundles
      ? {
          boundary_bundles: expanded.layout.boundary_bundles.map((bundle) => ({
            ...bundle,
            endpoint: remapEndpoint(bundle.endpoint),
            members: bundle.members.map((member) => {
              const edge = remappedEdgeId.get(member.edge)
              if (edge == null) {
                throw new Error(
                  `current SchemWeave bundle omitted edge ${member.edge}`,
                )
              }
              return { ...member, edge }
            }),
          })),
        }
      : {}),
  }
  return {
    catalog: compact.catalog,
    compactRequest: compact.request,
    request: {
      expanded_graph: reconstructed.expandedRequest.graph,
      expanded_layout: remappedLayout,
      compact_graph: compact.request.graph,
      expansion: reconstructed.request.expansion,
      constraints: compact.request.constraints,
    },
  }
}

export function interpretSchemWeaveResult(
  layout: SchemWeaveLayout,
  catalog?: SchemWeaveGraphCatalog,
  request?: SchemWeaveLayoutRequest,
): LayoutGeometry {
  const raw = layout as unknown as Record<string, unknown> | null
  if (!raw || typeof raw !== 'object') {
    throw new Error('layout result must be an object')
  }
  if (!Array.isArray(raw.nodes)) {
    throw new Error('layout nodes must be an array')
  }
  if (!Array.isArray(raw.edges)) {
    throw new Error('layout edges must be an array')
  }
  const finite = (value: unknown, label: string, nonnegative = false) => {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (nonnegative && value < 0)
    ) {
      throw new Error(
        `${label} must be a finite${nonnegative ? ' nonnegative' : ''} number`,
      )
    }
  }
  const integer = (value: unknown, label: string, nonnegative = false) => {
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      (nonnegative && value < 0)
    ) {
      throw new Error(
        `${label} must be a safe${nonnegative ? ' nonnegative' : ''} integer`,
      )
    }
  }
  const record = (value: unknown, label: string): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${label} must be an object`)
    }
    return value as Record<string, unknown>
  }
  const point = (value: unknown, label: string) => {
    const candidate = record(value, label)
    finite(candidate.x, `${label}.x`)
    finite(candidate.y, `${label}.y`)
  }
  const segment = (value: unknown, label: string) => {
    const candidate = record(value, label)
    point(candidate.start, `${label}.start`)
    point(candidate.end, `${label}.end`)
  }

  finite(raw.width, 'layout width', true)
  finite(raw.height, 'layout height', true)
  const nodeIds = new Set<number>()
  raw.nodes.forEach((value, index) => {
    const node = record(value, `layout node ${index}`)
    integer(node.id, `layout node ${index} id`, true)
    const id = node.id as number
    if (nodeIds.has(id)) throw new Error(`layout returned duplicate node ${id}`)
    nodeIds.add(id)
    finite(node.x, `layout node ${id} x`)
    finite(node.y, `layout node ${id} y`)
    finite(node.width, `layout node ${id} width`, true)
    finite(node.height, `layout node ${id} height`, true)
  })

  const edgeIds = new Set<number>()
  raw.edges.forEach((value, index) => {
    const edge = record(value, `layout edge ${index}`)
    integer(edge.id, `layout edge ${index} id`, true)
    const id = edge.id as number
    if (edgeIds.has(id)) throw new Error(`layout returned duplicate edge ${id}`)
    if (catalog && !catalog.fragments[id]) {
      throw new Error(`layout returned unknown electrical edge ${id}`)
    }
    edgeIds.add(id)
    if (!Array.isArray(edge.points)) {
      throw new Error(`layout edge ${id} points must be an array`)
    }
    edge.points.forEach((value, pointIndex) =>
      point(value, `layout edge ${id} point ${pointIndex}`))
  })
  if (catalog && edgeIds.size !== catalog.fragments.length) {
    const missing = catalog.fragments.findIndex((_, id) => !edgeIds.has(id))
    throw new Error(`layout omitted electrical edge ${missing}`)
  }

  if (raw.boundary_bundles != null) {
    if (!Array.isArray(raw.boundary_bundles)) {
      throw new Error('layout boundary bundles must be an array')
    }
    const bundleIds = new Set<number>()
    raw.boundary_bundles.forEach((value, index) => {
      const bundle = record(value, `boundary bundle ${index}`)
      integer(bundle.id, `boundary bundle ${index} id`, true)
      const id = bundle.id as number
      if (bundleIds.has(id)) {
        throw new Error(`layout returned duplicate boundary bundle ${id}`)
      }
      bundleIds.add(id)
      const endpoint = record(
        bundle.endpoint,
        `boundary bundle ${id} endpoint`,
      )
      integer(endpoint.node, `boundary bundle ${id} endpoint node`, true)
      integer(endpoint.port, `boundary bundle ${id} endpoint port`, true)
      if (!nodeIds.has(endpoint.node as number)) {
        throw new Error(
          `boundary bundle ${id} references unknown node ${endpoint.node}`,
        )
      }
      if (bundle.role !== 'input' && bundle.role !== 'output') {
        throw new Error(`boundary bundle ${id} has invalid role`)
      }
      integer(bundle.width, `boundary bundle ${id} width`, true)
      if (bundle.width === 0) {
        throw new Error(`boundary bundle ${id} width must be positive`)
      }
      segment(bundle.collector, `boundary bundle ${id} collector`)
      segment(bundle.spine, `boundary bundle ${id} spine`)
      if (!Array.isArray(bundle.members)) {
        throw new Error(`boundary bundle ${id} members must be an array`)
      }
      bundle.members.forEach((value, memberIndex) => {
        const member = record(
          value,
          `boundary bundle ${id} member ${memberIndex}`,
        )
        integer(
          member.edge,
          `boundary bundle ${id} member ${memberIndex} edge`,
          true,
        )
        if (!edgeIds.has(member.edge as number)) {
          throw new Error(
            `boundary bundle ${id} references unknown edge ${member.edge}`,
          )
        }
        if (!Array.isArray(member.slots)) {
          throw new Error(
            `boundary bundle ${id} member ${memberIndex} slots must be an array`,
          )
        }
        member.slots.forEach((slot, slotIndex) => {
          integer(
            slot,
            `boundary bundle ${id} member ${memberIndex} slot ${slotIndex}`,
            true,
          )
          if ((slot as number) >= (bundle.width as number)) {
            throw new Error(
              `boundary bundle ${id} slot ${slot} exceeds width ${bundle.width}`,
            )
          }
        })
        point(member.tap, `boundary bundle ${id} member ${memberIndex} tap`)
      })
    })
  }

  const renderedIndexByEdgeId = new Map(
    layout.edges.map((edge, index) => [edge.id, index] as const),
  )
  return {
    nodes: layout.nodes,
    edges: layout.edges.map((edge) => {
      const fragment = catalog?.fragments[edge.id]
      return {
        inputIndex: fragment?.inputIndex ?? edge.id,
        points: edge.points,
        ...(fragment?.netBits ? { netBits: fragment.netBits } : {}),
      }
    }),
    ...(layout.boundary_bundles && layout.boundary_bundles.length > 0
      ? {
          boundaryBundles: layout.boundary_bundles.map((bundle) => ({
            id: bundle.id,
            endpoint: bundle.endpoint,
            role: bundle.role,
            width: bundle.width,
            collector: bundle.collector,
            spine: bundle.spine,
            ownerIndexes: [...new Set(
              bundle.members.map((member) => {
                const renderedIndex = renderedIndexByEdgeId.get(member.edge)
                if (renderedIndex == null) {
                  throw new Error(
                    `boundary bundle ${bundle.id} references unrouted edge ${member.edge}`,
                  )
                }
                return renderedIndex
              }),
            )].sort((left, right) => left - right),
          })),
        }
      : {}),
    ...(catalog && request
      ? { schemWeaveSnapshot: { request, layout, catalog } }
      : {}),
    width: layout.width,
    height: layout.height,
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

  const groupedMemberIds = new Set(
    input.groups?.flatMap((group) => group.members) ?? [],
  )
  const childById = new Map(
    nodeChildren.map((child) => [Number(child.id), child]),
  )
  const groupIdByMember = new Map<number, number>()
  const groupChildren: ElkNode[] = (input.groups ?? []).flatMap((group) => {
    const members = group.members.flatMap((member) => {
      const child = childById.get(member)
      return child ? [child] : []
    })
    if (members.length === 0) return []

    // Prefer one aligned vertical stack. If that stack would exceed 1.5x the
    // height of the schematic the user expanded from, form a balanced clean
    // grid. Cross-boundary
    // nets terminate at compound proxy ports during ELK placement, then regain
    // their exact member-pin endpoints through collision-free frame corridors.
    const singleColumnHeight = expandedGroupSingleColumnHeight(members)
    // Callers outside the interactive expansion path may not have a reference
    // layout. Preserve the bounded legacy fallback for those inputs.
    const stackVertically = shouldStackExpandedGroup(group, members)
    for (const member of group.members) {
      groupIdByMember.set(member, group.id)
    }
    const columnCount = expandedGroupColumnCount(group, members)
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
      : members
    const layoutEdges: ElkExtendedEdge[] = []
    for (let index = 0; index + 1 < members.length; index += 1) {
      if (stackVertically || (index + 1) % columnCount === 0) continue
      layoutEdges.push({
        id: `group-layout:${group.id}:${index}`,
        sources: [members[index].id],
        targets: [members[index + 1].id],
      })
    }
    const groupWidth = Math.max(
      ...members.map((member) => member.width ?? 0),
    ) + 32
    return [{
      id: `group:${group.id}`,
      children: arrangedMembers,
      edges: layoutEdges,
      ports: stackVertically
        ? [
            {
              id: `group:${group.id}#in`,
              x: 0,
              y: singleColumnHeight / 2,
              width: 0,
              height: 0,
              layoutOptions: { 'elk.port.side': 'WEST' },
            },
            {
              id: `group:${group.id}#out`,
              x: groupWidth,
              y: singleColumnHeight / 2,
              width: 0,
              height: 0,
              layoutOptions: { 'elk.port.side': 'EAST' },
            },
          ]
        : [
            {
              id: `group:${group.id}#in`,
              width: 0,
              height: 0,
              layoutOptions: { 'elk.port.side': 'WEST' },
            },
            {
              id: `group:${group.id}#out`,
              width: 0,
              height: 0,
              layoutOptions: { 'elk.port.side': 'EAST' },
            },
          ],
      ...(stackVertically
        ? {
            width: groupWidth,
            height: singleColumnHeight,
          }
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
          : { 'elk.portConstraints': 'FIXED_SIDE' }),
        'elk.padding': '[top=30,left=16,bottom=16,right=16]',
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

  const pinId = (
    map: Map<number, Map<string, number>>,
    id: number,
    pin: string,
    prefix: 'i' | 'o',
  ): string => (map.get(id)?.has(pin) ? `${id}#${prefix}:${pin}` : String(id))

  const edges: ElkExtendedEdge[] = input.edges.flatMap((e, i) => {
    const fromGroupId = groupIdByMember.get(e.from)
    const toGroupId = groupIdByMember.get(e.to)
    // Internal member nets are routed inside the compound after layout; an
    // ELK edge between the compound's own proxy ports becomes a large exterior
    // self-loop and contributes no useful placement information.
    if (fromGroupId != null && fromGroupId === toGroupId) return []
    return [{
          id: `e${i}`,
          sources: [
            fromGroupId != null
              ? `group:${fromGroupId}#out`
              : regIds.has(e.from)
              ? `${e.from}#out`
              : pinId(pins.outgoingIndex, e.from, e.fromPort, 'o'),
          ],
          targets: [
            toGroupId != null
              ? `group:${toGroupId}#in`
              : regIds.has(e.to)
              ? e.control
                ? `${e.to}#control:${e.toPort}`
                : `${e.to}#in`
              : pinId(pins.incomingIndex, e.to, e.toPort, 'i'),
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
  for (const group of input.groups ?? []) {
    const members = group.members.flatMap((member) => {
      const node = laidOutById.get(member)
      return node ? [node] : []
    })
    if (
      members.length === 0 ||
      !shouldStackExpandedGroup(group, members)
    ) continue
    let memberY = Math.min(...members.map((member) => member.y))
    members.forEach((member) => {
      member.y = memberY
      memberY += member.height + EXPANDED_GROUP_NODE_SPACING
    })
  }

  const groupById = new Map(groups.map((group) => [group.id, group]))
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
    const railY = perimeterRailY(start.y, boundary.y, route)
    return compactRoute([
      start,
      { x: access.rightRailX, y: start.y },
      { x: access.rightRailX, y: railY },
      { x: boundary.x, y: railY },
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
    const railY = perimeterRailY(boundary.y, end.y, route)
    return compactRoute([
      boundary,
      { x: boundary.x, y: railY },
      { x: access.leftRailX, y: railY },
      { x: access.leftRailX, y: end.y },
      end,
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
      const routedPoints = [
        section.startPoint,
        ...(section.bendPoints ?? []),
        section.endPoint,
      ]
      if (fromRoute) {
        const start = fallbackPoint(edge.from, true, edge)
        points.push(...memberToBoundary(
          edge.from,
          start,
          section.startPoint,
          fromRoute,
        ).slice(0, -1))
      }
      points.push(...routedPoints)
      if (toRoute) {
        const end = fallbackPoint(edge.to, false, edge)
        points.push(...boundaryToMember(
          section.endPoint,
          edge.to,
          end,
          toRoute,
        ).slice(1))
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
          y: toRoute.frame.y + toRoute.frame.height / 2,
        }
        const entryX = boundary.x - 8
        points.push(
          start,
          { x: entryX, y: start.y },
          { x: entryX, y: boundary.y },
          ...boundaryToMember(boundary, edge.to, end, toRoute),
        )
      } else if (fromRoute && !toRoute) {
        const boundary = {
          x: fromRoute.frame.x + fromRoute.frame.width,
          y: fromRoute.frame.y + fromRoute.frame.height / 2,
        }
        const exitX = boundary.x + 8
        points.push(
          ...memberToBoundary(edge.from, start, boundary, fromRoute),
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
          y: fromRoute.frame.y + fromRoute.frame.height / 2,
        }
        const toBoundary = {
          x: toRoute.frame.x,
          y: toRoute.frame.y + toRoute.frame.height / 2,
        }
        points.push(
          ...memberToBoundary(edge.from, start, fromBoundary, fromRoute),
          ...localEdgePoints(fromBoundary, toBoundary).slice(1),
          ...boundaryToMember(toBoundary, edge.to, end, toRoute).slice(1),
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
    edges: geometry.edges.map(({ inputIndex, points, netBits }) => {
      const edge = sub.edges[inputIndex]
      if (!edge) throw new Error(`layout returned unknown edge ${inputIndex}`)
      return {
        from: edge.from,
        to: edge.to,
        points,
        edge: netBits ? { ...edge, bits: netBits } : edge,
      }
    }),
    ...(geometry.groups ? { groups: geometry.groups } : {}),
    boundaryBundles: geometry.boundaryBundles ?? [],
    ...(geometry.schemWeaveSnapshot
      ? { schemWeaveSnapshot: geometry.schemWeaveSnapshot }
      : {}),
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

const workers: Partial<Record<LayoutEngine, Worker>> = {}
let workerFactory: ((engine: LayoutEngine) => Worker) | null = null
let seq = 0
interface LayoutRunResult {
  geometry: LayoutGeometry
  degraded: boolean
}

const pending = new Map<
  number,
  {
    engine: LayoutEngine
    resolve: (result: LayoutRunResult) => void
    reject: (e: Error) => void
  }
>()
const expansionPending = new Map<
  number,
  {
    resolve: (geometry: LayoutGeometry | null) => void
    reject: (error: Error) => void
  }
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

function terminateWorker(
  engine: LayoutEngine,
  instance: Worker,
  reason: Error,
) {
  if (workers[engine] !== instance) return
  instance.onmessage = null
  instance.onerror = null
  instance.terminate()
  delete workers[engine]
  for (const [id, entry] of pending) {
    if (entry.engine !== engine) continue
    entry.reject(reason)
    pending.delete(id)
  }
  for (const [id, entry] of expansionPending) {
    entry.reject(reason)
    expansionPending.delete(id)
  }
}

function getWorker(engine: LayoutEngine): Worker {
  const existing = workers[engine]
  if (existing) return existing
  if (engine === 'schemweave' && !import.meta.env.DEV) {
    throw new Error('SchemWeave comparison is available only in local development')
  }
  if (!workerFactory) {
    throw new Error('layout worker factory is not configured')
  }
  const w = workerFactory(engine)
  w.onmessage = (
    ev: MessageEvent<ElkResponse | SchemWeaveWorkerResponse>,
  ) => {
    const msg = ev.data
    const expansionEntry = expansionPending.get(msg.id)
    if (engine === 'schemweave' && expansionEntry) {
      expansionPending.delete(msg.id)
      if (!msg.ok) {
        expansionEntry.reject(new Error(msg.error))
        return
      }
      try {
        const result = (
          msg as Extract<SchemWeaveWorkerResponse, { ok: true }>
        ).result
        if (result.status === 'needs_full_relayout') {
          expansionEntry.resolve(null)
          return
        }
        if (result.status !== 'layout') {
          throw new Error('invalid SchemWeave expansion response')
        }
        expansionEntry.resolve(result.geometry)
      } catch (error) {
        expansionEntry.reject(
          error instanceof Error ? error : new Error(String(error)),
        )
      }
      return
    }
    const entry = pending.get(msg.id)
    if (!entry) return
    pending.delete(msg.id)
    if (msg.ok) {
      try {
        if (engine === 'schemweave') {
          const schemResponse = msg as Extract<
            SchemWeaveWorkerResponse,
            { ok: true }
          >
          if (schemResponse.result.status !== 'layout') {
            throw new Error(
              'full SchemWeave layout requested another full relayout',
            )
          }
          entry.resolve({
            geometry: schemResponse.result.geometry,
            degraded: schemResponse.result.degraded,
          })
        } else {
          entry.resolve({
            geometry: (msg as Extract<ElkResponse, { ok: true }>).result,
            degraded: false,
          })
        }
      } catch (error) {
        entry.reject(
          error instanceof Error ? error : new Error(String(error)),
        )
      }
    }
    else entry.reject(new Error(msg.error))
  }
  w.onerror = (ev) => {
    // The worker is dead — drop the singleton so the next layout spawns a
    // fresh one instead of posting into a void forever.
    terminateWorker(
      engine,
      w,
      new Error(ev.message || `${engine} worker error`),
    )
  }
  workers[engine] = w
  return w
}

/** Configure browser-owned worker entrypoints before rendering the application. */
export function configureLayoutWorkerFactory(
  factory: (engine: LayoutEngine) => Worker,
): void {
  workerFactory = factory
}

/** Load and initialize the selected reusable worker before the first schematic opens. */
export function prewarmLayoutWorker(engine: LayoutEngine = 'elk'): void {
  getWorker(engine)
}

/** Lay out and adapt a Subgraph in the worker. */
function runLayout(
  input: LayoutInput,
  engine: LayoutEngine,
  placement?: NodePlacement,
  signal?: AbortSignal,
): Promise<LayoutRunResult> {
  const req: ElkRequest | SchemWeaveWorkerRequest =
    engine === 'schemweave'
      ? {
          id: ++seq,
          kind: 'layout',
          input,
        }
      : {
        id: ++seq,
        input,
        placement: placement ?? 'NETWORK_SIMPLEX',
      }
  const id = req.id
  const w = getWorker(engine)
  return new Promise<LayoutRunResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    let timeout: ReturnType<typeof setTimeout> | undefined
    const onAbort = () => {
      if (!pending.has(id)) return
      // Layout engines cannot cancel an in-flight layout. Terminating prevents a stale,
      // superseded job from monopolising the singleton ahead of its replacement.
      terminateWorker(engine, w, abortError())
    }
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort)
      if (timeout) clearTimeout(timeout)
    }
    pending.set(id, {
      engine,
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
      () => terminateWorker(engine, w, layoutTimeoutError()),
      LAYOUT_DEADLINE_MS,
    )
    w.postMessage(req)
  })
}

/** Expand one quotient group through SchemWeave's retained-geometry API. */
export async function layoutExpandedGroupWithSchemWeave(
  sub: Subgraph,
  base: LaidOutGraph,
  group: ExpandedGroupLayout,
  signal?: AbortSignal,
  activeGroups: ExpandedGroupLayout[] = [group],
): Promise<LaidOutGraph | null> {
  if (signal?.aborted) throw abortError()
  const snapshot = base.schemWeaveSnapshot
  if (!snapshot) return null
  const id = ++seq
  const request: SchemWeaveWorkerRequest = {
    id,
    kind: 'expand',
    snapshot,
    input: prepareLayoutInput(sub),
    group,
    activeGroups,
  }
  const worker = getWorker('schemweave')
  const geometry = await new Promise<LayoutGeometry | null>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    let timeout: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort)
      if (timeout) clearTimeout(timeout)
    }
    const onAbort = () => {
      if (!expansionPending.has(id)) return
      terminateWorker('schemweave', worker, abortError())
    }
    expansionPending.set(id, {
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
      () => terminateWorker('schemweave', worker, layoutTimeoutError()),
      LAYOUT_DEADLINE_MS,
    )
    worker.postMessage(request)
  })
  return geometry ? hydrateLayoutResult(sub, geometry) : null
}

/**
 * Collapse one quotient group while preserving every unrelated expanded
 * group. A null result explicitly asks the caller to use a full layout.
 */
export async function layoutCollapsedGroupWithSchemWeave(
  compactSub: Subgraph,
  expandedSub: Subgraph,
  expandedLayout: LaidOutGraph,
  group: ExpandedGroupLayout,
  activeGroups: ExpandedGroupLayout[],
  signal?: AbortSignal,
): Promise<LaidOutGraph | null> {
  if (signal?.aborted) throw abortError()
  const snapshot = expandedLayout.schemWeaveSnapshot
  if (!snapshot) return null
  const id = ++seq
  const request: SchemWeaveWorkerRequest = {
    id,
    kind: 'collapse',
    snapshot,
    expandedInput: prepareLayoutInput(expandedSub),
    compactInput: prepareLayoutInput(compactSub),
    group,
    activeGroups,
  }
  const worker = getWorker('schemweave')
  const geometry = await new Promise<LayoutGeometry | null>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    let timeout: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort)
      if (timeout) clearTimeout(timeout)
    }
    const onAbort = () => {
      if (!expansionPending.has(id)) return
      terminateWorker('schemweave', worker, abortError())
    }
    expansionPending.set(id, {
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
      () => terminateWorker('schemweave', worker, layoutTimeoutError()),
      LAYOUT_DEADLINE_MS,
    )
    worker.postMessage(request)
  })
  return geometry ? hydrateLayoutResult(compactSub, geometry) : null
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
  engineOrExpandedGroups: LayoutEngine | ExpandedGroupLayout[] = 'elk',
  expandedGroupsArgument: ExpandedGroupLayout[] = [],
): Promise<LaidOutGraph> {
  assertRenderableSubgraph(sub)
  if (signal?.aborted) throw abortError()
  const engine = Array.isArray(engineOrExpandedGroups)
    ? 'elk'
    : engineOrExpandedGroups
  const expandedGroups = Array.isArray(engineOrExpandedGroups)
    ? engineOrExpandedGroups
    : expandedGroupsArgument
  const input = prepareLayoutInput(sub, expandedGroups)
  if (engine === 'schemweave') {
    const cacheKey = layoutGeometryKey(input, engine)
    const cached = cachedLayoutGeometry(cacheKey)
    if (cached) return hydrateLayoutResult(sub, cached)
    const result = await runLayout(input, engine, undefined, signal)
    if (!result.degraded) cacheLayoutGeometry(cacheKey, result.geometry)
    return hydrateLayoutResult(sub, result.geometry)
  }
  const placement = placementForLayout(sub)
  const cacheKey = layoutGeometryKey(input, engine, placement)
  const cached = cachedLayoutGeometry(cacheKey)
  if (cached) return hydrateLayoutResult(sub, cached)
  if (placement === 'BRANDES_KOEPF') {
    const result = await runLayout(
      input,
      engine,
      'BRANDES_KOEPF',
      signal,
    )
    cacheLayoutGeometry(cacheKey, result.geometry)
    return hydrateLayoutResult(sub, result.geometry)
  }
  try {
    const result = await runLayout(
      input,
      engine,
      'NETWORK_SIMPLEX',
      signal,
    )
    cacheLayoutGeometry(cacheKey, result.geometry)
    return hydrateLayoutResult(sub, result.geometry)
  } catch (error) {
    // Never retry an aborted (superseded) request.
    if (signal?.aborted || (error instanceof Error && error.name === 'LayoutTimeoutError')) {
      throw error
    }
    // A tight layout can fail because of either this topology or transient
    // worker infrastructure. Keep robust fallback geometry under its actual
    // placement so the next equivalent request still retries the preferred
    // tight placement, while a repeat topology failure can reuse the fallback.
    const fallbackKey = layoutGeometryKey(input, engine, 'BRANDES_KOEPF')
    const cachedFallback = cachedLayoutGeometry(fallbackKey)
    if (cachedFallback) return hydrateLayoutResult(sub, cachedFallback)
    const result = await runLayout(
      input,
      engine,
      'BRANDES_KOEPF',
      signal,
    )
    cacheLayoutGeometry(fallbackKey, result.geometry)
    return hydrateLayoutResult(sub, result.geometry)
  }
}
