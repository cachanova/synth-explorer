// Owns the reusable ELK worker, request lifecycle, and client-side geometry cache.

import type { Subgraph } from '../../types'
import type { ElkRequest, ElkResponse } from '../../workers/elk.worker'
import { MAX_GRAPH_EDGES, MAX_GROUP_EXPANSION_RENDER_NODES } from './graphLimits'
import {
  hydrateLayoutResult,
  prepareLayoutInput,
  type ExpandedGroupLayout,
  type LaidOutGraph,
  type LayoutGeometry,
  type LayoutInput,
  type NodePlacement,
} from './elkGraph'

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
