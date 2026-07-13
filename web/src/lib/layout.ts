// Converts a Subgraph into an ELK layered layout via the worker, and back into
// positioned nodes + routed edges for SVG rendering.

import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api'
import type { GraphEdge, GraphNode, Subgraph } from '../types'
import type { ElkRequest, ElkResponse } from '../workers/elk.worker'
import { MAX_GRAPH_EDGES, MAX_GRAPH_RENDER_NODES } from './graphLimits'
import { nodeLabel } from './prettyType'
import { controlLabel, controlsFor, symbolKind } from './symbols'

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

export interface ViewportTransform {
  x: number
  y: number
  k: number
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
): ViewportTransform | null {
  if (
    !Number.isFinite(viewportWidth) ||
    !Number.isFinite(viewportHeight) ||
    viewportWidth <= padding ||
    viewportHeight <= padding
  ) {
    return null
  }

  const width =
    Number.isFinite(contentWidth) && contentWidth > 0 ? contentWidth : 1
  const height =
    Number.isFinite(contentHeight) && contentHeight > 0 ? contentHeight : 1
  const scale = Math.min(
    (viewportWidth - padding) / width,
    (viewportHeight - padding) / height,
    maxScale,
  )
  if (!(scale > 0) || !Number.isFinite(scale)) return null

  return {
    x: (viewportWidth - width * scale) / 2,
    y: (viewportHeight - height * scale) / 2,
    k: scale,
  }
}

const CHAR_WIDTH = 7.2
const PAD_X = 24

function textWidth(node: GraphNode): number {
  const label = nodeLabel(node)
  const name = node.name?.startsWith('$') ? '' : node.name ?? ''
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
      (max, control) => Math.max(max, controlLabel(control).length * 6.2 + PAD_X),
      0,
    )
    width = Math.max(width, Math.round(controlWidth))
    height = base.height + controls.length * 13
  }
  // Grouped vector nodes reserve an extra row and room for a "×N" bit badge.
  const groupWidth = node.width ?? 0
  if (groupWidth >= 2) {
    const badge = `×${groupWidth}`
    width = Math.max(width, Math.round(badge.length * CHAR_WIDTH + PAD_X))
    height += 14
  }
  return { width, height }
}

/** Build the ELK graph description from a Subgraph. */
export function toElkGraph(sub: Subgraph): ElkNode {
  assertRenderableSubgraph(sub)
  const children: ElkNode[] = sub.nodes.map((n) => {
    const { width, height } = nodeDimensions(n)
    return { id: String(n.id), width, height }
  })

  const edges: ElkExtendedEdge[] = sub.edges.map((e, i) => ({
    id: `e${i}`,
    sources: [String(e.from)],
    targets: [String(e.to)],
  }))

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
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    },
    children,
    edges,
  }
}

function assertRenderableSubgraph(sub: Subgraph): void {
  if (sub.nodes.length > MAX_GRAPH_RENDER_NODES) {
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

function interpretResult(sub: Subgraph, root: ElkNode): LaidOutGraph {
  const byId = new Map<number, GraphNode>()
  for (const n of sub.nodes) byId.set(n.id, n)

  const nodes: LaidOutNode[] = (root.children ?? []).map((c) => {
    const id = Number(c.id)
    const node = byId.get(id)!
    const fallback = nodeDimensions(node)
    return {
      id,
      x: c.x ?? 0,
      y: c.y ?? 0,
      width: c.width ?? fallback.width,
      height: c.height ?? fallback.height,
      node,
    }
  })

  const rootEdges = (root.edges ?? []) as ElkExtendedEdge[]
  const edges: LaidOutEdge[] = rootEdges.map((e, i) => {
    const src = sub.edges[i]
    const points: Point[] = []
    const section = e.sections?.[0]
    if (section) {
      points.push(section.startPoint)
      if (section.bendPoints) points.push(...section.bendPoints)
      points.push(section.endPoint)
    }
    return {
      from: Number(e.sources[0]),
      to: Number(e.targets[0]),
      points,
      edge: src,
    }
  })

  return {
    nodes,
    edges,
    width: root.width ?? 0,
    height: root.height ?? 0,
  }
}

let worker: Worker | null = null
let seq = 0
const pending = new Map<
  number,
  { resolve: (g: ElkNode) => void; reject: (e: Error) => void }
>()

function abortError(): Error {
  const error = new Error('layout aborted')
  error.name = 'AbortError'
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

/** Lay out a Subgraph in the worker. Rejects before worker/SVG work at either cap. */
export async function layoutSubgraph(
  sub: Subgraph,
  signal?: AbortSignal,
): Promise<LaidOutGraph> {
  const graph = toElkGraph(sub)
  const w = getWorker()
  const id = ++seq
  const result = await new Promise<ElkNode>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const onAbort = () => terminateWorker(w, abortError())
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
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
    const req: ElkRequest = { id, graph }
    w.postMessage(req)
  })
  return interpretResult(sub, result)
}
