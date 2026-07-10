// Converts a Subgraph into an ELK layered layout via the worker, and back into
// positioned nodes + routed edges for SVG rendering.

import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api'
import type { GraphEdge, GraphNode, Subgraph } from '../types'
import type { ElkRequest, ElkResponse } from '../workers/elk.worker'
import { nodeLabel } from './prettyType'

export const MAX_LAYOUT_NODES = 1500

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

const NODE_HEIGHT = 46
const MIN_WIDTH = 64
const CHAR_WIDTH = 7.2
const PAD_X = 22

function nodeWidth(node: GraphNode): number {
  const label = nodeLabel(node)
  const name = node.name ?? ''
  const longest = Math.max(label.length, Math.min(name.length, 22))
  return Math.max(MIN_WIDTH, Math.round(longest * CHAR_WIDTH + PAD_X))
}

/** Build the ELK graph description from a Subgraph. */
export function toElkGraph(sub: Subgraph): ElkNode {
  const children: ElkNode[] = sub.nodes.map((n) => ({
    id: String(n.id),
    width: nodeWidth(n),
    height: NODE_HEIGHT,
  }))

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
      'elk.layered.spacing.nodeNodeBetweenLayers': '60',
      'elk.spacing.nodeNode': '26',
      'elk.layered.spacing.edgeNodeBetweenLayers': '20',
      'elk.layered.mergeEdges': 'true',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    },
    children,
    edges,
  }
}

function interpretResult(sub: Subgraph, root: ElkNode): LaidOutGraph {
  const byId = new Map<number, GraphNode>()
  for (const n of sub.nodes) byId.set(n.id, n)

  const nodes: LaidOutNode[] = (root.children ?? []).map((c) => {
    const id = Number(c.id)
    return {
      id,
      x: c.x ?? 0,
      y: c.y ?? 0,
      width: c.width ?? MIN_WIDTH,
      height: c.height ?? NODE_HEIGHT,
      node: byId.get(id)!,
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

function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('../workers/elk.worker.ts', import.meta.url), {
    type: 'module',
  })
  worker.onmessage = (ev: MessageEvent<ElkResponse>) => {
    const msg = ev.data
    const entry = pending.get(msg.id)
    if (!entry) return
    pending.delete(msg.id)
    if (msg.ok) entry.resolve(msg.result)
    else entry.reject(new Error(msg.error))
  }
  worker.onerror = (ev) => {
    for (const entry of pending.values()) entry.reject(new Error(ev.message))
    pending.clear()
  }
  return worker
}

/** Lay out a Subgraph in the worker. Rejects if node count exceeds the cap. */
export async function layoutSubgraph(sub: Subgraph): Promise<LaidOutGraph> {
  if (sub.nodes.length > MAX_LAYOUT_NODES) {
    throw new Error(
      `cone too large (${sub.nodes.length} nodes) — reduce depth or pick a narrower signal`,
    )
  }
  const w = getWorker()
  const id = ++seq
  const graph = toElkGraph(sub)
  const result = await new Promise<ElkNode>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    const req: ElkRequest = { id, graph }
    w.postMessage(req)
  })
  return interpretResult(sub, result)
}
