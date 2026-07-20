import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { PathsResponse, TimingPath } from '../../types'

const getPathsMock = vi.hoisted(() => vi.fn())
const virtualKeys = vi.hoisted(() => [] as Array<string | number>)
let pathsData: PathsResponse

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({
    count,
    getItemKey,
  }: {
    count: number
    getItemKey: (index: number) => string | number
  }) => {
    virtualKeys.splice(
      0,
      virtualKeys.length,
      ...Array.from({ length: count }, (_, index) => getItemKey(index)),
    )
    return {
      getTotalSize: () => count * 32,
      getVirtualItems: () =>
        virtualKeys.map((key, index) => ({
          index,
          key,
          start: index * 32,
        })),
      measureElement: vi.fn(),
      scrollToIndex: vi.fn(),
    }
  },
}))
vi.mock('../../api', () => ({ getPaths: getPathsMock }))
vi.mock('../../lib/timingSettings', () => ({
  loadTimingSettings: () => ({
    profile: 'auto',
    speedGrade: '-1',
    overrides: null,
  }),
  resolveTimingView: () => ({ showTiming: false }),
  timingRequestForView: () => ({ speed_grade: '-1' }),
}))
vi.mock('../../lib/useDesignData', () => ({
  useDesignData: (id: string, fetcher: (designId: string) => unknown) => {
    fetcher(id)
    return { data: pathsData, loading: false, error: null }
  },
}))
vi.mock('../../useStore', () => ({
  shallowEqual: Object.is,
  useStore: () => ({
    design: {
      design_id: 'design',
      tool: 'yosys',
      mode: 'rtl',
      delay_profile: 'generic',
    },
    showPathInGraph: vi.fn(),
  }),
}))

import { Paths } from './Paths'
import { nextPathSort, sortPaths } from './pathSorting'

function path(index: number): TimingPath {
  const startpoint = { id: index * 2, kind: 'port' as const, name: `input-${index}` }
  const endpoint = { id: index * 2 + 1, kind: 'port' as const, name: `endpoint-${index}` }
  return {
    depth: index,
    class: 'input_to_output',
    endpoint_group: endpoint.name,
    endpoint_kind: 'output',
    bits: [0],
    output_aliases: [],
    startpoint,
    endpoint,
    endpoint_port: 'Y',
    nodes: [startpoint, endpoint],
  }
}

describe('Paths result completeness', () => {
  it('requests and renders path variants beyond the former top-25 cutoff', () => {
    getPathsMock.mockClear()
    pathsData = {
      paths: Array.from({ length: 26 }, (_, index) => path(index + 1)),
      comb_loops: [],
      truncated: false,
    }
    getPathsMock.mockResolvedValue(pathsData)

    const markup = renderToStaticMarkup(<Paths />)

    expect(getPathsMock).toHaveBeenCalledWith('design', {
      sort: 'depth',
      speed_grade: '-1',
    })
    expect(getPathsMock.mock.calls[0][1]).not.toHaveProperty('limit')
    expect(markup).toContain('Longest logical path variants (26)')
    expect(markup).not.toContain('Est. delay')
    expect(markup.match(/<tr[^>]*class="clickable"/g)).toHaveLength(26)
    expect(markup).toContain('endpoint-26')
  })

  it('keeps distinct structural routes distinct in the virtual row keys', () => {
    getPathsMock.mockClear()
    const first = path(1)
    const second: TimingPath = {
      ...first,
      nodes: [
        first.startpoint,
        { id: 999, kind: 'cell', name: 'alternate-route', cell_type: '$not' },
        first.endpoint,
      ],
    }
    pathsData = {
      paths: [first, second],
      comb_loops: [],
      truncated: false,
    }
    getPathsMock.mockResolvedValue(pathsData)

    const markup = renderToStaticMarkup(<Paths />)

    expect(new Set(virtualKeys)).toHaveProperty('size', 2)
    expect(markup.match(/<tr[^>]*class="clickable"/g)).toHaveLength(2)
  })
})

describe('Paths table sorting', () => {
  const paths = [
    { ...path(1), depth: 1, estimated_delay_ns: 0.41 },
    { ...path(2), depth: 3, estimated_delay_ns: 0.31 },
    { ...path(3), depth: 2, estimated_delay_ns: 0.43 },
  ]

  it('sorts the same reported result set in either direction', () => {
    const delayDescending = sortPaths(paths, { key: 'delay', direction: 'desc' })
    const delayAscending = sortPaths(paths, { key: 'delay', direction: 'asc' })

    expect(delayDescending.map((item) => item.depth)).toEqual([2, 1, 3])
    expect(delayAscending.map((item) => item.depth)).toEqual([3, 1, 2])
    expect(sortPaths(paths, { key: 'depth', direction: 'desc' }).map((item) => item.depth))
      .toEqual([3, 2, 1])
    expect(sortPaths(paths, { key: 'depth', direction: 'asc' }).map((item) => item.depth))
      .toEqual([1, 2, 3])
    expect(new Set(delayDescending)).toEqual(new Set(paths))
    expect(new Set(delayAscending)).toEqual(new Set(paths))
    expect(paths.map((item) => item.depth)).toEqual([1, 3, 2])
  })

  it('starts a newly selected column descending, then alternates direction', () => {
    const first = nextPathSort(null, 'delay')
    const second = nextPathSort(first, 'delay')
    const third = nextPathSort(second, 'delay')

    expect(first).toEqual({ key: 'delay', direction: 'desc' })
    expect(second).toEqual({ key: 'delay', direction: 'asc' })
    expect(third).toEqual({ key: 'delay', direction: 'desc' })
    expect(nextPathSort(third, 'depth')).toEqual({ key: 'depth', direction: 'desc' })
  })
})
