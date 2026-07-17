import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { EndpointsResponse } from '../../types'

let endpointsData: EndpointsResponse

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 32,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 32,
      })),
    measureElement: vi.fn(),
    scrollToIndex: vi.fn(),
  }),
}))
vi.mock('../../lib/useDesignData', () => ({
  useDesignData: () => ({ data: endpointsData, loading: false, error: null }),
}))
vi.mock('../../useStore', () => ({
  shallowEqual: Object.is,
  useStore: () => ({
    design: { design_id: 'design' },
    analysisState: 'current',
    openCone: vi.fn(),
  }),
}))

import { Endpoints } from './Endpoints'

describe('Endpoints result completeness', () => {
  it('renders every logical endpoint instead of stopping at 100 rows', () => {
    endpointsData = {
      registers: [],
      inputs: [],
      outputs: Array.from({ length: 101 }, (_, index) => ({
        name: `endpoint-${index + 1}`,
        width: 1,
        worst_depth: index,
        bits: [{ bit: 0, node_id: index, depth: index }],
      })),
    }

    const markup = renderToStaticMarkup(<Endpoints />)

    expect(markup).toContain('Logical endpoints (101 matched / 101)')
    expect(markup.match(/<tr[^>]*class="clickable"/g)).toHaveLength(101)
    expect(markup).toContain('endpoint-101')
  })
})
