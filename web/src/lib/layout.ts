// Converts a Subgraph into an ELK layered layout via the worker, and back into
// positioned nodes + routed edges for SVG rendering.

import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api'
import type { ControlRole, GraphEdge, GraphNode, Subgraph } from '../types'
import type { ElkRequest, ElkResponse } from '../workers/elk.worker'
import {
  MAX_GRAPH_EDGES,
  MAX_GROUP_EXPANSION_RENDER_NODES,
} from './graphLimits'
import { groupBadgeText, nodeLabel, nodeSublabel } from './prettyType'
import { controlCaption, controlsFor, symbolKind } from './symbols'

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
  width: number
  height: number
}

export interface LayoutInputNode {
  id: number
  baseWidth: number
  baseHeight: number
  controlHeight: number
  register: boolean
}

export interface LayoutInputEdge {
  from: number
  to: number
  fromPort: string
  toPort: string
  control: boolean
}

export interface LayoutInput {
  nodes: LayoutInputNode[]
  edges: LayoutInputEdge[]
}

export interface LayoutGeometry {
  nodes: Array<Omit<LaidOutNode, 'node'>>
  edges: Array<{ inputIndex: number; points: Point[] }>
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

export function prepareLayoutInput(sub: Subgraph): LayoutInput {
  return {
    nodes: sub.nodes.map((node) => {
      const { width, height } = nodeDimensions(node)
      return {
        id: node.id,
        baseWidth: width,
        baseHeight: height,
        controlHeight: controlsFor(node).length * CONTROL_ROW_HEIGHT,
        register: isRegKind(node),
      }
    }),
    edges: sub.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      fromPort: edge.from_port,
      toPort: edge.to_port,
      control: edge.control === true,
    })),
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
  const children: ElkNode[] = input.nodes.map((n) => {
    const ins = inPins.get(n.id) ?? []
    const outs = outPins.get(n.id) ?? []
    const { width, height } = dimensionsForPins(n, ins.length, outs.length)
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
        layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
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
      return { id: String(n.id), width, height }
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
      layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
      ports,
    }
  })

  const pinId = (
    map: Map<number, Map<string, number>>,
    id: number,
    pin: string,
    prefix: 'i' | 'o',
  ): string => (map.get(id)?.has(pin) ? `${id}#${prefix}:${pin}` : String(id))

  const edges: ElkExtendedEdge[] = input.edges.map((e, i) => ({
    id: `e${i}`,
    sources: [
      regIds.has(e.from)
        ? `${e.from}#out`
        : pinId(pins.outgoingIndex, e.from, e.fromPort, 'o'),
    ],
    targets: [
      regIds.has(e.to)
        ? e.control
          ? `${e.to}#control:${e.toPort}`
          : `${e.to}#in`
        : pinId(pins.incomingIndex, e.to, e.toPort, 'i'),
    ],
  }))
  const edgeDensity = input.edges.length / Math.max(1, input.nodes.length)
  const useDenseFastPath =
    nodePlacement === 'BRANDES_KOEPF' &&
    input.nodes.length >= DENSE_LAYOUT_NODE_THRESHOLD &&
    edgeDensity >= REDUCED_THOROUGHNESS_EDGE_DENSITY
  const useDenseLayering =
    nodePlacement === 'BRANDES_KOEPF' &&
    input.nodes.length >= DENSE_LAYOUT_NODE_THRESHOLD &&
    edgeDensity >= DENSE_LONGEST_PATH_EDGE_DENSITY

  return {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
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

  const nodes: LayoutGeometry['nodes'] = (root.children ?? []).map((c) => {
    const id = Number(c.id)
    const node = byId.get(id)!
    const fallback = dimensionsForPins(
      node,
      pins.incoming.get(id)?.length ?? 0,
      pins.outgoing.get(id)?.length ?? 0,
    )
    return {
      id,
      x: c.x ?? 0,
      y: c.y ?? 0,
      width: c.width ?? fallback.width,
      height: c.height ?? fallback.height,
    }
  })

  const laidOutById = new Map(nodes.map((node) => [node.id, node]))
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
  const edges: LayoutGeometry['edges'] = input.edges.map((edge, inputIndex) => {
    const routed = routedByInputIndex.get(inputIndex)
    const points: Point[] = []
    const section = routed?.sections?.[0]
    if (section) {
      points.push(section.startPoint)
      if (section.bendPoints) points.push(...section.bendPoints)
      points.push(section.endPoint)
    } else {
      // Preserve the structural edge even if ELK omits a routed section. This
      // is especially important for grouped register D inputs: without the
      // fallback the driver cone and register render as disconnected islands.
      points.push(
        fallbackPoint(edge.from, true, edge),
        fallbackPoint(edge.to, false, edge),
      )
    }
    return {
      inputIndex,
      points,
    }
  })

  return {
    nodes,
    edges,
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
    width: geometry.width,
    height: geometry.height,
  }
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
  const w = new Worker(new URL('../workers/elk.worker.ts', import.meta.url), {
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
): Promise<LaidOutGraph> {
  assertRenderableSubgraph(sub)
  if (signal?.aborted) throw abortError()
  const input = prepareLayoutInput(sub)
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
