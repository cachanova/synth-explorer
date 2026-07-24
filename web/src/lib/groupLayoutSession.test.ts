import { describe, expect, it } from 'vitest'
import type { Subgraph } from '../types'
import type { LaidOutGraph } from './layout'
import {
  GROUP_LAYOUT_SESSION_MAX_ENTRIES,
  cacheGroupLayout,
  cachedGroupLayout,
  createGroupLayoutSession,
  resetGroupLayoutSession,
} from './groupLayoutSession'

const base = (): Subgraph => ({
  nodes: [],
  edges: [],
  truncated: false,
})

const layout = (width: number): LaidOutGraph => ({
  nodes: [],
  edges: [],
  boundaryBundles: [],
  width,
  height: 1,
})

describe('group layout session cache', () => {
  it('is isolated by the exact base projection identity', () => {
    const session = createGroupLayoutSession()
    const firstBase = base()
    const secondBase = base()
    cacheGroupLayout(session, firstBase, '1', layout(1))

    expect(cachedGroupLayout(session, firstBase, '1')?.width).toBe(1)
    expect(cachedGroupLayout(session, secondBase, '1')).toBeNull()
    expect(session.entries.size).toBe(0)

    cacheGroupLayout(session, secondBase, '2', layout(2))
    resetGroupLayoutSession(session, null)
    expect(session.base).toBeNull()
    expect(session.entries.size).toBe(0)
    expect(session.retainedBytes).toBe(0)
  })

  it('keeps a bounded LRU of validated prefix layouts', () => {
    const session = createGroupLayoutSession()
    const projection = base()
    for (let index = 0; index < GROUP_LAYOUT_SESSION_MAX_ENTRIES; index++) {
      cacheGroupLayout(session, projection, `${index}`, layout(index))
    }
    expect(cachedGroupLayout(session, projection, '0')?.width).toBe(0)

    cacheGroupLayout(
      session,
      projection,
      `${GROUP_LAYOUT_SESSION_MAX_ENTRIES}`,
      layout(GROUP_LAYOUT_SESSION_MAX_ENTRIES),
    )
    expect(cachedGroupLayout(session, projection, '1')).toBeNull()
    expect(cachedGroupLayout(session, projection, '0')?.width).toBe(0)
    expect(session.entries.size).toBe(GROUP_LAYOUT_SESSION_MAX_ENTRIES)
  })
})
