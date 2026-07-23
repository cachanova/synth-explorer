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
import {
  SCHEMWEAVE_BOUNDARY_BUNDLE_FALLBACK,
  type SchemWeaveRequest,
  type SchemWeaveResponse,
} from '../workers/schemweaveRuntime'
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
  members: Array<{ height?: number }>,
): number {
  if (shouldStackExpandedGroup(group, members)) return 1
  const verticalLimit = group.referenceHeight == null
    ? null
    : group.referenceHeight * EXPANDED_GROUP_VERTICAL_LIMIT_MULTIPLIER
  const maxMemberHeight = Math.max(
    1,
    ...members.map((member) => member.height ?? 0),
  )
  const maxGridRows = verticalLimit == null
    ? Math.max(1, Math.ceil(Math.sqrt(members.length / 0.65)))
    : Math.max(
        1,
        Math.floor(
          (
            verticalLimit -
            EXPANDED_GROUP_VERTICAL_PADDING +
            EXPANDED_GROUP_NODE_SPACING
          ) /
            (maxMemberHeight + EXPANDED_GROUP_NODE_SPACING),
        ),
      )
  return Math.max(1, Math.ceil(members.length / maxGridRows))
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
  boundaryBundles?: Array<{
    id: number
    endpoint: { node: number; port: number }
    role: 'input' | 'output'
    width: number
    collector: BoundaryBundleSegment
    spine: BoundaryBundleSegment
    ownerIndexes: number[]
  }>
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
  return `${engine}:${placement ?? 'max'}:${JSON.stringify(input)}`
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
  // Conservative object/array allowances plus UTF-16 key storage. This is a
  // retained-memory budget, not a wire-size estimate.
  return (
    key.length * 2 +
    geometry.nodes.length * 128 +
    geometry.edges.length * 96 +
    (geometry.groups?.length ?? 0) * 80 +
    (geometry.boundaryBundles?.length ?? 0) * 320 +
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

interface SchemWeaveGraphCatalog {
  graph: SchemWeaveGraph
  portIds: Map<string, number>
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
  const edges = input.edges.map((edge, id) => {
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
      id,
      source: { node: edge.from, port: portId(edge.from, sourceKey) },
      target: { node: edge.to, port: portId(edge.to, targetKey) },
      net: edge.net ?? id,
      participates_in_ranking: true,
    }
  })
  return { graph: { nodes, edges }, portIds }
}

export function toSchemWeaveGraph(input: LayoutInput): SchemWeaveGraph {
  return buildSchemWeaveGraph(input).graph
}

function boundaryBundleConstraints(
  input: LayoutInput,
  graph: SchemWeaveGraph,
): SchemWeaveBoundaryBundleConstraint[] {
  const nodeById = new Map(input.nodes.map((node) => [node.id, node]))
  const builders = new Map<string, {
    role: 'input' | 'output'
    endpoint: { node: number; port: number }
    width: number
    members: Array<{ edge: number; slots: number[] }>
  }>()

  const addMember = (
    role: 'input' | 'output',
    edgeIndex: number,
    nodeId: number,
    portId: number,
    mappings: EdgeBoundaryMember[] | undefined,
  ) => {
    if (!mappings || mappings.length === 0) return
    const node = nodeById.get(nodeId)
    if (!node) throw new Error(`boundary bundle references unknown node ${nodeId}`)
    // Quotient metadata describes the grouped declaration even when the
    // visible topology proves that declaration is not a primary boundary
    // (notably inouts and direction-conflicting partial projections). Keep
    // those nodes internal and omit an impossible boundary constraint.
    if (node.boundary === 'internal') return
    if (node.boundary !== role) {
      throw new Error(
        `boundary bundle ${role} metadata references ${node.boundary} node ${nodeId}`,
      )
    }
    const slotByMember = new Map(
      node.boundaryMembers?.map((member) => [member.member, member.bit] as const),
    )
    const slots = [...new Set(mappings.map((mapping) => {
      const slot = slotByMember.get(mapping.member)
      if (slot == null) {
        throw new Error(
          `boundary bundle node ${nodeId} has no declaration slot for member ${mapping.member}`,
        )
      }
      return slot
    }))].sort((left, right) => left - right)
    if (slots.length === 0) return
    const requiredWidth = slots[slots.length - 1] + 1
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
    const key = `${role}:${nodeId}:${portId}`
    const existing = builders.get(key)
    if (existing && existing.width !== width) {
      throw new Error(`inconsistent boundary bundle width for node ${nodeId}`)
    }
    const builder = existing ?? {
      role,
      endpoint: { node: nodeId, port: portId },
      width,
      members: [],
    }
    builder.members.push({ edge: edgeIndex, slots })
    builders.set(key, builder)
  }

  input.edges.forEach((edge, edgeIndex) => {
    const schemEdge = graph.edges[edgeIndex]
    addMember(
      'input',
      edgeIndex,
      edge.from,
      schemEdge.source.port,
      edge.sourceBoundaryMembers,
    )
    addMember(
      'output',
      edgeIndex,
      edge.to,
      schemEdge.target.port,
      edge.targetBoundaryMembers,
    )
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
export function toSchemWeaveLayoutRequest(
  input: LayoutInput,
): SchemWeaveLayoutRequest {
  const { graph } = buildSchemWeaveGraph(input)
  const boundaryIds = (boundary: LayoutInputNode['boundary']) =>
    input.nodes
      .filter((node) => node.boundary === boundary)
      .map((node) => node.id)
      .sort((left, right) => left - right)
  const boundaryBundles = boundaryBundleConstraints(input, graph)
  return {
    graph,
    constraints: {
      inputs: boundaryIds('input'),
      outputs: boundaryIds('output'),
      ...(boundaryBundles.length > 0
        ? { boundary_bundles: boundaryBundles }
        : {}),
    },
  }
}

export function interpretSchemWeaveResult(
  layout: SchemWeaveLayout,
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
    edgeIds.add(id)
    if (!Array.isArray(edge.points)) {
      throw new Error(`layout edge ${id} points must be an array`)
    }
    edge.points.forEach((value, pointIndex) =>
      point(value, `layout edge ${id} point ${pointIndex}`))
  })

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

  return {
    nodes: layout.nodes,
    edges: layout.edges.map((edge) => ({
      inputIndex: edge.id,
      points: edge.points,
    })),
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
              bundle.members.map((member) => member.edge),
            )].sort((left, right) => left - right),
          })),
        }
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

    // Prefer one aligned vertical stack. If that stack would exceed twice the
    // height of the schematic the user expanded from, form the fewest clean
    // grid columns needed to stay within that vertical budget. Cross-boundary
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
    edges: geometry.edges.map(({ inputIndex, points }) => {
      const edge = sub.edges[inputIndex]
      if (!edge) throw new Error(`layout returned unknown edge ${inputIndex}`)
      return { from: edge.from, to: edge.to, points, edge }
    }),
    ...(geometry.groups ? { groups: geometry.groups } : {}),
    boundaryBundles: geometry.boundaryBundles ?? [],
    width: geometry.width,
    height: geometry.height,
  }
}

const LOCAL_GROUP_COLUMN_GAP = 20
const LOCAL_GROUP_ROW_GAP = 16
const LOCAL_GROUP_MARGIN_X = 14
const LOCAL_GROUP_MARGIN_TOP = 28
const LOCAL_GROUP_COLLISION_GAP = 12
const LOCAL_GROUP_EDGE_RAIL_GAP = 8
const LOCAL_GROUP_ROUTE_MARGIN_X = 20
const LOCAL_GROUP_ROUTE_MARGIN_TOP = 28
const LOCAL_GROUP_ROUTE_MARGIN_BOTTOM = 20

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

function segmentIntersectsRectangle(
  start: Point,
  end: Point,
  left: number,
  top: number,
  right: number,
  bottom: number,
): boolean {
  return Math.max(start.x, end.x) > left &&
    Math.min(start.x, end.x) < right &&
    Math.max(start.y, end.y) > top &&
    Math.min(start.y, end.y) < bottom
}

interface LocalRouteGrid {
  gridX: number
  gridY: number
  maxMemberWidth: number
  maxMemberHeight: number
  columns: number
  rows: number
  cells: Array<LaidOutNode | undefined>
  leftRail: number
  rightRail: number
  topRail: number
  bottomRail: number
  headerLeft: number
  headerTop: number
  headerRight: number
  headerBottom: number
}

function segmentCrossesRouteGrid(
  start: Point,
  end: Point,
  grid: LocalRouteGrid,
): boolean {
  if (start.x !== end.x && start.y !== end.y) return true
  if (start.x === end.x && start.y === end.y) return false
  if (segmentIntersectsRectangle(
    start,
    end,
    grid.headerLeft,
    grid.headerTop,
    grid.headerRight,
    grid.headerBottom,
  )) return true
  const stepX = grid.maxMemberWidth + LOCAL_GROUP_COLUMN_GAP
  const stepY = grid.maxMemberHeight + LOCAL_GROUP_ROW_GAP
  if (start.y === end.y) {
    const relativeY = start.y - grid.gridY
    const row = Math.floor(relativeY / stepY)
    if (
      row < 0 ||
      row >= grid.rows ||
      relativeY - row * stepY > grid.maxMemberHeight
    ) return false
    const minX = Math.min(start.x, end.x)
    const maxX = Math.max(start.x, end.x)
    const firstColumn = Math.max(0, Math.floor((minX - grid.gridX) / stepX))
    const lastColumn = Math.min(
      grid.columns - 1,
      Math.floor((maxX - grid.gridX) / stepX),
    )
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      const node = grid.cells[row * grid.columns + column]
      if (node && segmentIntersectsRectangle(
        start,
        end,
        node.x,
        node.y,
        node.x + node.width,
        node.y + node.height,
      )) return true
    }
    return false
  }
  const relativeX = start.x - grid.gridX
  const column = Math.floor(relativeX / stepX)
  if (
    column < 0 ||
    column >= grid.columns ||
    relativeX - column * stepX > grid.maxMemberWidth
  ) return false
  const minY = Math.min(start.y, end.y)
  const maxY = Math.max(start.y, end.y)
  const firstRow = Math.max(0, Math.floor((minY - grid.gridY) / stepY))
  const lastRow = Math.min(
    grid.rows - 1,
    Math.floor((maxY - grid.gridY) / stepY),
  )
  for (let row = firstRow; row <= lastRow; row += 1) {
    const node = grid.cells[row * grid.columns + column]
    if (node && segmentIntersectsRectangle(
      start,
      end,
      node.x,
      node.y,
      node.x + node.width,
      node.y + node.height,
    )) return true
  }
  return false
}

function memberAccessX(
  column: number,
  side: 'incoming' | 'outgoing',
  grid: LocalRouteGrid,
): number {
  if (side === 'incoming') {
    if (column === 0) return grid.leftRail
    return grid.gridX +
      column * (grid.maxMemberWidth + LOCAL_GROUP_COLUMN_GAP) -
      LOCAL_GROUP_COLUMN_GAP / 2
  }
  if (column === grid.columns - 1) return grid.rightRail
  return grid.gridX +
    (column + 1) * grid.maxMemberWidth +
    column * LOCAL_GROUP_COLUMN_GAP +
    LOCAL_GROUP_COLUMN_GAP / 2
}

function perimeterAccess(point: Point, grid: LocalRouteGrid): Point {
  if (point.x <= grid.leftRail || point.x >= grid.rightRail) return point
  if (point.y <= grid.topRail || point.y >= grid.bottomRail) {
    return {
      x: point.x - grid.leftRail <= grid.rightRail - point.x
        ? grid.leftRail
        : grid.rightRail,
      y: point.y,
    }
  }
  return point
}

function routeAroundMemberGrid(
  start: Point,
  end: Point,
  grid: LocalRouteGrid,
  startColumn?: number,
  endColumn?: number,
): Point[] | null {
  const startAccess = startColumn == null
    ? perimeterAccess(start, grid)
    : { x: memberAccessX(startColumn, 'outgoing', grid), y: start.y }
  const endAccess = endColumn == null
    ? perimeterAccess(end, grid)
    : { x: memberAccessX(endColumn, 'incoming', grid), y: end.y }
  const candidates: Point[][] = [
    [start, end],
    localEdgePoints(start, end),
    [start, { x: end.x, y: start.y }, end],
    [start, { x: start.x, y: end.y }, end],
    ...[grid.topRail, grid.bottomRail].map((y) => [
      start,
      startAccess,
      { x: startAccess.x, y },
      { x: endAccess.x, y },
      endAccess,
      end,
    ]),
  ].map(compactRoute)
  const clearCandidates = candidates.filter((points) =>
    points.slice(1).every((point, index) =>
      !segmentCrossesRouteGrid(points[index], point, grid)
    )
  )
  const routeScore = (points: Point[]) =>
    points.slice(1).reduce((score, point, index) => {
      const previous = points[index]
      return score +
        Math.abs(point.x - previous.x) +
        Math.abs(point.y - previous.y)
    }, 0) +
    Math.max(0, points.length - 2) * LOCAL_GROUP_EDGE_RAIL_GAP
  clearCandidates.sort((a, b) => routeScore(a) - routeScore(b))
  return clearCandidates[0] ?? null
}

function pointInsideRouteFrame(point: Point, grid: LocalRouteGrid): boolean {
  return point.x > grid.leftRail &&
    point.x < grid.rightRail &&
    point.y > grid.topRail &&
    point.y < grid.bottomRail
}

function segmentEntryToRouteFrame(
  start: Point,
  end: Point,
  grid: LocalRouteGrid,
): Point | null {
  if (start.x === end.x) {
    if (start.x < grid.leftRail || start.x > grid.rightRail) return null
    if (start.y < grid.topRail && end.y >= grid.topRail) {
      return { x: start.x, y: grid.topRail }
    }
    if (start.y > grid.bottomRail && end.y <= grid.bottomRail) {
      return { x: start.x, y: grid.bottomRail }
    }
    return null
  }
  if (start.y !== end.y) return null
  if (start.y < grid.topRail || start.y > grid.bottomRail) return null
  if (start.x < grid.leftRail && end.x >= grid.leftRail) {
    return { x: grid.leftRail, y: start.y }
  }
  if (start.x > grid.rightRail && end.x <= grid.rightRail) {
    return { x: grid.rightRail, y: start.y }
  }
  return null
}

function trunkPrefixToRouteFrame(
  points: Point[],
  grid: LocalRouteGrid,
): Point[] {
  if (points.length === 0) return []
  const retained = [points[0]]
  if (pointInsideRouteFrame(points[0], grid)) return retained
  for (let index = 1; index < points.length; index += 1) {
    const entry = segmentEntryToRouteFrame(points[index - 1], points[index], grid)
    if (entry) return compactRoute([...retained, entry])
    if (pointInsideRouteFrame(points[index], grid)) return compactRoute(retained)
    retained.push(points[index])
  }
  return compactRoute(retained)
}

function trunkSuffixFromRouteFrame(
  points: Point[],
  grid: LocalRouteGrid,
): Point[] {
  return trunkPrefixToRouteFrame([...points].reverse(), grid).reverse()
}

/**
 * Open one quotient group without asking the selected engine to redraw the whole projection.
 * Existing nodes and routes keep their exact geometry. Members form a compact
 * grid centered on the quotient node's former position, while new boundary
 * wiring reuses the quotient edge trunks where possible.
 */
export function layoutExpandedGroupInPlace(
  sub: Subgraph,
  base: LaidOutGraph,
  group: ExpandedGroupLayout,
): LaidOutGraph | null {
  // Bundle owner indexes and rewritten tap routes are a whole-layout contract.
  // A local quotient rewrite cannot safely remap them, so request a fresh
  // engine layout instead of returning disconnected collector geometry.
  if ((base.boundaryBundles?.length ?? 0) > 0) return null
  const anchor = base.nodes.find((node) => node.id === group.id)
  if (!anchor) return null

  const memberIds = new Set(group.members)
  const subNodeById = new Map(sub.nodes.map((node) => [node.id, node]))
  const memberNodes = group.members
    .map((id) => subNodeById.get(id))
    .filter((node): node is GraphNode => node != null)
  if (memberNodes.length === 0) return null

  const input = prepareLayoutInput(sub)
  const pins = collectPinCatalog(input.edges)
  const inputNodeById = new Map(input.nodes.map((node) => [node.id, node]))
  const dimensions = new Map(input.nodes.map((node) => [
    node.id,
    dimensionsForPins(
      node,
      pins.incoming.get(node.id)?.length ?? 0,
      pins.outgoing.get(node.id)?.length ?? 0,
    ),
  ]))
  const maxMemberWidth = Math.max(
    ...memberNodes.map((node) => dimensions.get(node.id)?.width ?? anchor.width),
  )
  const maxMemberHeight = Math.max(
    ...memberNodes.map((node) => dimensions.get(node.id)?.height ?? anchor.height),
  )
  const columns = Math.max(
    1,
    Math.ceil(Math.sqrt(
      memberNodes.length *
      (maxMemberHeight + LOCAL_GROUP_ROW_GAP) /
      (maxMemberWidth + LOCAL_GROUP_COLUMN_GAP),
    )),
  )
  const rows = Math.ceil(memberNodes.length / columns)
  const gridWidth =
    columns * maxMemberWidth + Math.max(0, columns - 1) * LOCAL_GROUP_COLUMN_GAP
  const gridHeight =
    rows * maxMemberHeight + Math.max(0, rows - 1) * LOCAL_GROUP_ROW_GAP
  const centeredX = anchor.x + anchor.width / 2 - gridWidth / 2
  const centeredY = anchor.y + anchor.height / 2 - gridHeight / 2
  const stepX = gridWidth + LOCAL_GROUP_COLUMN_GAP * 2
  const stepY = gridHeight + LOCAL_GROUP_ROW_GAP * 2
  const candidateOffsets = [
    [0, 0],
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
    [2, 0],
    [-2, 0],
    [0, 2],
    [0, -2],
  ] as const
  const blockers = base.nodes.filter((node) => node.id !== group.id)
  const routeBlockers = base.edges
    .filter((edge) => edge.from !== group.id && edge.to !== group.id)
    .flatMap((edge) => edge.points.slice(1).map((point, index) => ({
      start: edge.points[index],
      end: point,
    })))
  const rightmostBlocker = Math.max(
    LOCAL_GROUP_MARGIN_X,
    ...blockers.map((node) => node.x + node.width),
  )
  const bottommostBlocker = Math.max(
    LOCAL_GROUP_MARGIN_TOP,
    ...blockers.map((node) => node.y + node.height),
  )
  const candidatePositions = [
    ...candidateOffsets.map(([column, row]) => ({
      x: centeredX + column * stepX,
      y: centeredY + row * stepY,
    })),
    // These two positions are guaranteed to clear every existing node, so a
    // dense graph never forces unrelated logic inside the expanded frame.
    {
      x: rightmostBlocker +
        LOCAL_GROUP_COLLISION_GAP +
        LOCAL_GROUP_ROUTE_MARGIN_X,
      y: centeredY,
    },
    {
      x: centeredX,
      y: bottommostBlocker + LOCAL_GROUP_COLLISION_GAP + LOCAL_GROUP_MARGIN_TOP,
    },
  ]
  const candidates = candidatePositions.map((position) => {
    const x = Math.max(LOCAL_GROUP_ROUTE_MARGIN_X, position.x)
    const y = Math.max(LOCAL_GROUP_MARGIN_TOP, position.y)
    const left = x - LOCAL_GROUP_ROUTE_MARGIN_X
    const top = y - LOCAL_GROUP_MARGIN_TOP
    const right = x + gridWidth + LOCAL_GROUP_ROUTE_MARGIN_X
    const bottom = y + gridHeight + LOCAL_GROUP_ROUTE_MARGIN_BOTTOM
    const overlap = blockers.reduce((area, node) => {
      const overlapWidth = Math.max(
        0,
        Math.min(right, node.x + node.width + LOCAL_GROUP_COLLISION_GAP) -
          Math.max(left, node.x - LOCAL_GROUP_COLLISION_GAP),
      )
      const overlapHeight = Math.max(
        0,
        Math.min(bottom, node.y + node.height + LOCAL_GROUP_COLLISION_GAP) -
          Math.max(top, node.y - LOCAL_GROUP_COLLISION_GAP),
      )
      return area + overlapWidth * overlapHeight
    }, 0)
    const routeIntersections = routeBlockers.reduce(
      (count, segment) =>
        count +
        Number(segmentIntersectsRectangle(
          segment.start,
          segment.end,
          left,
          top,
          right,
          bottom,
        )),
      0,
    )
    const distance =
      (x + gridWidth / 2 - (anchor.x + anchor.width / 2)) ** 2 +
      (y + gridHeight / 2 - (anchor.y + anchor.height / 2)) ** 2
    return { x, y, overlap, routeIntersections, distance }
  })
  candidates.sort((a, b) =>
    a.overlap - b.overlap ||
    a.routeIntersections - b.routeIntersections ||
    a.distance - b.distance
  )
  const gridX = candidates[0].x
  const gridY = candidates[0].y

  const memberGeometry = new Map<number, LaidOutNode>()
  memberNodes.forEach((node, index) => {
    const size = dimensions.get(node.id) ?? {
      width: anchor.width,
      height: anchor.height,
    }
    const column = index % columns
    const row = Math.floor(index / columns)
    memberGeometry.set(node.id, {
      id: node.id,
      x: gridX + column * (maxMemberWidth + LOCAL_GROUP_COLUMN_GAP) +
        (maxMemberWidth - size.width) / 2,
      y: gridY + row * (maxMemberHeight + LOCAL_GROUP_ROW_GAP) +
        (maxMemberHeight - size.height) / 2,
      width: size.width,
      height: size.height,
      node,
    })
  })

  const baseNodeById = new Map(base.nodes.map((node) => [node.id, node]))
  if (sub.nodes.some((node) =>
    !memberIds.has(node.id) && !baseNodeById.has(node.id)
  )) {
    // This local composer only replaces one existing quotient node. Fall back
    // to ELK if a future caller introduces additional context nodes.
    return null
  }
  const nodes = sub.nodes.flatMap((node) => {
    const member = memberGeometry.get(node.id)
    if (member) return [member]
    const existing = baseNodeById.get(node.id)
    return existing ? [{ ...existing, node }] : []
  })
  const laidOutById = new Map(nodes.map((node) => [node.id, node]))
  const memberLeft = Math.min(
    ...[...memberGeometry.values()].map((node) => node.x),
  )
  const memberRight = Math.max(
    ...[...memberGeometry.values()].map((node) => node.x + node.width),
  )
  const memberTop = Math.min(
    ...[...memberGeometry.values()].map((node) => node.y),
  )
  const memberBottom = Math.max(
    ...[...memberGeometry.values()].map((node) => node.y + node.height),
  )
  const memberColumnById = new Map(
    memberNodes.map((node, index) => [node.id, index % columns]),
  )
  const routeGrid: LocalRouteGrid = {
    gridX,
    gridY,
    maxMemberWidth,
    maxMemberHeight,
    columns,
    rows,
    cells: memberNodes.map((node) => memberGeometry.get(node.id)),
    leftRail: memberLeft - LOCAL_GROUP_ROUTE_MARGIN_X,
    rightRail: memberRight + LOCAL_GROUP_ROUTE_MARGIN_X,
    topRail: memberTop - LOCAL_GROUP_ROUTE_MARGIN_TOP,
    bottomRail: memberBottom + LOCAL_GROUP_ROUTE_MARGIN_BOTTOM,
    headerLeft: memberLeft - 12,
    headerTop: memberTop - 20,
    headerRight: memberRight + 12,
    headerBottom: memberTop,
  }
  const baseEdgeKey = (edge: GraphEdge) =>
    `${edge.from}->${edge.to}|${edge.from_port}|${edge.to_port}|${edge.net_name}|${edge.bits.join(',')}`
  const baseEdgesByKey = new Map(
    base.edges.map((edge) => [baseEdgeKey(edge.edge), edge]),
  )
  const outgoingTrunks = base.edges.filter((edge) => edge.from === group.id)
  const incomingTrunks = base.edges.filter((edge) => edge.to === group.id)
  const outgoingTrunkByTarget = new Map<number, (typeof base.edges)[number]>()
  const outgoingTrunkByTargetPort = new Map<string, (typeof base.edges)[number]>()
  const outgoingTrunkByPorts = new Map<string, (typeof base.edges)[number]>()
  const incomingTrunkBySource = new Map<number, (typeof base.edges)[number]>()
  const incomingTrunkBySourcePort = new Map<string, (typeof base.edges)[number]>()
  const incomingTrunkByPorts = new Map<string, (typeof base.edges)[number]>()
  for (const trunk of outgoingTrunks) {
    if (!outgoingTrunkByTarget.has(trunk.to)) {
      outgoingTrunkByTarget.set(trunk.to, trunk)
    }
    const key = `${trunk.to}|${trunk.edge.to_port}`
    if (!outgoingTrunkByTargetPort.has(key)) {
      outgoingTrunkByTargetPort.set(key, trunk)
    }
    const portKey = `${trunk.edge.from_port}|${key}`
    if (!outgoingTrunkByPorts.has(portKey)) {
      outgoingTrunkByPorts.set(portKey, trunk)
    }
  }
  for (const trunk of incomingTrunks) {
    if (!incomingTrunkBySource.has(trunk.from)) {
      incomingTrunkBySource.set(trunk.from, trunk)
    }
    const key = `${trunk.from}|${trunk.edge.from_port}`
    if (!incomingTrunkBySourcePort.has(key)) {
      incomingTrunkBySourcePort.set(key, trunk)
    }
    const portKey = `${key}|${trunk.edge.to_port}`
    if (!incomingTrunkByPorts.has(portKey)) {
      incomingTrunkByPorts.set(portKey, trunk)
    }
  }

  const pinPoint = (
    laidOut: LaidOutNode,
    edge: GraphEdge,
    side: 'incoming' | 'outgoing',
  ): Point => {
    const layoutNode = inputNodeById.get(laidOut.id)
    if (!layoutNode) {
      return {
        x: side === 'outgoing' ? laidOut.x + laidOut.width : laidOut.x,
        y: laidOut.y + laidOut.height / 2,
      }
    }
    if (layoutNode.register) {
      const body = Math.min(laidOut.height, REG_BODY_HEIGHT)
      const fraction = side === 'outgoing'
        ? REG_DATA_OUT_Y_FRAC
        : edge.control
          ? registerControlYFraction(controlRoleForPin(edge.to_port))
          : REG_DATA_IN_Y_FRAC
      return {
        x: side === 'outgoing' ? laidOut.x + laidOut.width : laidOut.x,
        y: laidOut.y + body * fraction,
      }
    }
    const catalog = side === 'outgoing'
      ? pins.outgoing.get(laidOut.id) ?? []
      : pins.incoming.get(laidOut.id) ?? []
    const index = side === 'outgoing'
      ? pins.outgoingIndex.get(laidOut.id)?.get(edge.from_port)
      : pins.incomingIndex.get(laidOut.id)?.get(edge.to_port)
    return {
      x: side === 'outgoing' ? laidOut.x + laidOut.width : laidOut.x,
      y: index == null
        ? laidOut.y + laidOut.height / 2
        : laidOut.y +
          ((index + 1) * pinBodyHeight(layoutNode, laidOut.height)) /
            (catalog.length + 1),
    }
  }

  let routeFailed = false
  const edges = sub.edges.flatMap((edge) => {
    const existing = baseEdgesByKey.get(baseEdgeKey(edge))
    if (existing) return [{ ...existing, edge }]

    const from = laidOutById.get(edge.from)
    const to = laidOutById.get(edge.to)
    if (!from || !to) return []
    const memberFrom = memberIds.has(edge.from)
    const memberTo = memberIds.has(edge.to)
    if (memberFrom && !memberTo) {
      const trunk =
        outgoingTrunkByPorts.get(`${edge.from_port}|${edge.to}|${edge.to_port}`) ??
        outgoingTrunkByTargetPort.get(`${edge.to}|${edge.to_port}`) ??
        outgoingTrunkByTarget.get(edge.to)
      if (trunk) {
        const memberPin = pinPoint(from, edge, 'outgoing')
        const retainedTrunk = trunkSuffixFromRouteFrame(trunk.points, routeGrid)
        const trunkStart = retainedTrunk[0]
        const route = routeAroundMemberGrid(
          memberPin,
          trunkStart,
          routeGrid,
          memberColumnById.get(edge.from),
        )
        if (!route) {
          routeFailed = true
          return []
        }
        return [{
          from: edge.from,
          to: edge.to,
          points: compactRoute([
            ...route,
            ...retainedTrunk.slice(1),
          ]),
          edge,
        }]
      }
    }
    if (!memberFrom && memberTo) {
      const trunk =
        incomingTrunkByPorts.get(`${edge.from}|${edge.from_port}|${edge.to_port}`) ??
        incomingTrunkBySourcePort.get(`${edge.from}|${edge.from_port}`) ??
        incomingTrunkBySource.get(edge.from)
      if (trunk) {
        const retainedTrunk = trunkPrefixToRouteFrame(trunk.points, routeGrid)
        const trunkEnd = retainedTrunk.at(-1)!
        const memberPin = pinPoint(to, edge, 'incoming')
        const route = routeAroundMemberGrid(
          trunkEnd,
          memberPin,
          routeGrid,
          undefined,
          memberColumnById.get(edge.to),
        )
        if (!route) {
          routeFailed = true
          return []
        }
        return [{
          from: edge.from,
          to: edge.to,
          points: compactRoute([
            ...retainedTrunk,
            ...route.slice(1),
          ]),
          edge,
        }]
      }
    }
    const route = routeAroundMemberGrid(
      pinPoint(from, edge, 'outgoing'),
      pinPoint(to, edge, 'incoming'),
      routeGrid,
      memberFrom ? memberColumnById.get(edge.from) : undefined,
      memberTo ? memberColumnById.get(edge.to) : undefined,
    )
    if (!route) {
      routeFailed = true
      return []
    }
    return [{
      from: edge.from,
      to: edge.to,
      points: route,
      edge,
    }]
  })
  if (routeFailed) return null

  return {
    nodes,
    edges,
    width: Math.max(base.width, memberRight + LOCAL_GROUP_ROUTE_MARGIN_X),
    height: Math.max(base.height, memberBottom + LOCAL_GROUP_ROUTE_MARGIN_BOTTOM),
  }
}

const workers: Partial<Record<LayoutEngine, Worker>> = {}
let seq = 0
interface LayoutRunResult {
  geometry: LayoutGeometry
  degraded: boolean
}

const pending = new Map<
  number,
  {
    engine: LayoutEngine
    allowsBoundaryBundleFallback: boolean
    resolve: (result: LayoutRunResult) => void
    reject: (e: Error) => void
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
}

function getWorker(engine: LayoutEngine): Worker {
  const existing = workers[engine]
  if (existing) return existing
  if (engine === 'schemweave' && !import.meta.env.DEV) {
    throw new Error('SchemWeave comparison is available only in local development')
  }
  // Vite requires the complete Worker(new URL(...)) expression to remain
  // statically analyzable so each module worker and its WASM dependency are
  // compiled rather than copied as untransformed TypeScript.
  const w = engine === 'schemweave'
    ? new Worker(
        new URL('../workers/schemweave.worker.ts', import.meta.url),
        { type: 'module' },
      )
    : new Worker(
        new URL('../workers/elk.worker.ts', import.meta.url),
        { type: 'module' },
      )
  w.onmessage = (
    ev: MessageEvent<ElkResponse | SchemWeaveResponse>,
  ) => {
    const msg = ev.data
    const entry = pending.get(msg.id)
    if (!entry) return
    pending.delete(msg.id)
    if (msg.ok) {
      try {
        if (engine === 'schemweave') {
          const schemResponse = msg as Extract<
            SchemWeaveResponse,
            { ok: true }
          >
          const rawFallback = (schemResponse as { fallback?: unknown }).fallback
          if (
            rawFallback !== undefined &&
            rawFallback !== SCHEMWEAVE_BOUNDARY_BUNDLE_FALLBACK
          ) {
            throw new Error('invalid SchemWeave fallback marker')
          }
          if (
            rawFallback === SCHEMWEAVE_BOUNDARY_BUNDLE_FALLBACK &&
            !entry.allowsBoundaryBundleFallback
          ) {
            throw new Error(
              'SchemWeave fallback marker requires boundary bundle constraints',
            )
          }
          const geometry = interpretSchemWeaveResult(schemResponse.result)
          if (
            rawFallback === SCHEMWEAVE_BOUNDARY_BUNDLE_FALLBACK &&
            (geometry.boundaryBundles?.length ?? 0) > 0
          ) {
            throw new Error(
              'SchemWeave fallback geometry cannot contain boundary bundles',
            )
          }
          entry.resolve({
            geometry,
            degraded:
              rawFallback === SCHEMWEAVE_BOUNDARY_BUNDLE_FALLBACK,
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
  const schemRequest = engine === 'schemweave'
    ? toSchemWeaveLayoutRequest(input)
    : undefined
  const req: ElkRequest | SchemWeaveRequest = schemRequest
    ? { id: ++seq, request: schemRequest }
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
      allowsBoundaryBundleFallback:
        (schemRequest?.constraints.boundary_bundles?.length ?? 0) > 0,
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
