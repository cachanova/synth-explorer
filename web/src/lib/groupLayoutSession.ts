import type { Subgraph } from '../types'
import type { LaidOutGraph } from './layout'

export const GROUP_LAYOUT_SESSION_MAX_ENTRIES = 4
export const GROUP_LAYOUT_SESSION_MAX_BYTES = 16 * 1024 * 1024

interface GroupLayoutSessionEntry {
  layout: LaidOutGraph
  retainedBytes: number
}

export interface GroupLayoutSession {
  base: Subgraph | null
  entries: Map<string, GroupLayoutSessionEntry>
  retainedBytes: number
}

export function createGroupLayoutSession(): GroupLayoutSession {
  return {
    base: null,
    entries: new Map(),
    retainedBytes: 0,
  }
}

export function resetGroupLayoutSession(
  session: GroupLayoutSession,
  base: Subgraph | null,
): void {
  if (session.base === base) return
  session.base = base
  session.entries.clear()
  session.retainedBytes = 0
}

function estimatedRetainedBytes(key: string, layout: LaidOutGraph): number {
  const pointCount = layout.edges.reduce(
    (total, edge) => total + edge.points.length,
    0,
  )
  return (
    key.length * 2 +
    layout.nodes.length * 192 +
    layout.edges.length * 128 +
    (layout.groups?.length ?? 0) * 80 +
    (layout.boundaryBundles?.length ?? 0) * 320 +
    pointCount * 48 +
    256
  )
}

export function cachedGroupLayout(
  session: GroupLayoutSession,
  base: Subgraph,
  key: string,
): LaidOutGraph | null {
  resetGroupLayoutSession(session, base)
  const entry = session.entries.get(key)
  if (!entry) return null
  session.entries.delete(key)
  session.entries.set(key, entry)
  return entry.layout
}

export function cacheGroupLayout(
  session: GroupLayoutSession,
  base: Subgraph,
  key: string,
  layout: LaidOutGraph,
): void {
  resetGroupLayoutSession(session, base)
  const retainedBytes = estimatedRetainedBytes(key, layout)
  if (retainedBytes > GROUP_LAYOUT_SESSION_MAX_BYTES) return
  const prior = session.entries.get(key)
  if (prior) {
    session.retainedBytes -= prior.retainedBytes
    session.entries.delete(key)
  }
  session.entries.set(key, { layout, retainedBytes })
  session.retainedBytes += retainedBytes
  while (
    session.entries.size > GROUP_LAYOUT_SESSION_MAX_ENTRIES ||
    session.retainedBytes > GROUP_LAYOUT_SESSION_MAX_BYTES
  ) {
    const oldestKey = session.entries.keys().next().value
    if (oldestKey == null) break
    const oldest = session.entries.get(oldestKey)
    session.entries.delete(oldestKey)
    session.retainedBytes -= oldest?.retainedBytes ?? 0
  }
}
