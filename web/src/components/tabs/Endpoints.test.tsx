import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { EndpointsResponse } from '../../types'
import { boundaryFaninRequest, boundaryPathPinSelection } from '../../lib/endpointCone'

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
    files: [],
    openCone: vi.fn(),
  }),
}))

import { Endpoints } from './Endpoints'

describe('Endpoints result completeness', () => {
  it('builds pin- and bit-specific cone requests for primitive inputs', () => {
    expect(boundaryFaninRequest(42, 'memory.ADDR (fanin)', 'ADDR')).toMatchObject({
      node: 42,
      dir: 'fanin',
      rootPort: 'ADDR',
      rootPortBit: undefined,
    })
    expect(boundaryFaninRequest(42, 'memory.ADDR[1] (fanin)', 'ADDR', 1)).toMatchObject({
      node: 42,
      rootPort: 'ADDR',
      rootPortBit: 1,
    })
  })

  it('preserves the selected boundary path bit cohort in graph requests', () => {
    expect(boundaryPathPinSelection('blackbox', 'ADDR', [1, 3])).toEqual({
      rootPort: 'ADDR',
      rootPortBits: [1, 3],
    })
    expect(boundaryPathPinSelection('register', 'D', [0])).toEqual({})
  })

  it('renders every logical endpoint instead of stopping at 100 rows', () => {
    endpointsData = {
      registers: [],
      inputs: [],
      boundaries: [],
      boundaries_truncated: false,
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

  it('renders connected memory input pins as logical endpoints', () => {
    endpointsData = {
      registers: [],
      inputs: [],
      outputs: [],
      boundaries: [
        {
          name: 'memory',
          node_id: 42,
          cell_type: 'RAM32M',
          port: 'ADDR',
          width: 5,
          worst_depth: 3,
          bits: [
            { bit: 0, node_id: 42, depth: 2 },
            { bit: 1, node_id: 42, depth: 3 },
          ],
          bits_truncated: false,
        },
        {
          name: 'memory',
          node_id: 42,
          cell_type: 'RAM32M',
          port: 'WE',
          width: 1,
          worst_depth: 1,
          bits: [{ bit: 0, node_id: 42, depth: 1 }],
          bits_truncated: false,
        },
      ],
      boundaries_truncated: false,
    }

    const markup = renderToStaticMarkup(<Endpoints />)

    expect(markup).toContain('Logical endpoints (2 matched / 2)')
    expect(markup).toContain('memory.ADDR')
    expect(markup).toContain('memory.WE')
    expect(markup).toContain('Memory input')
    expect(markup).not.toContain('UNUSED')
  })

  it('marks a connected boundary port whose bit details were capped', () => {
    endpointsData = {
      registers: [],
      inputs: [],
      outputs: [],
      boundaries: [{
        name: 'memory',
        node_id: 42,
        cell_type: 'RAM32M',
        port: 'LATE',
        width: 1,
        worst_depth: 2,
        bits: [],
        bits_truncated: true,
      }],
      boundaries_truncated: true,
    }

    const markup = renderToStaticMarkup(<Endpoints />)

    expect(markup).toContain('memory.LATE')
    expect(markup).toContain('0+')
    expect(markup).toContain('Additional connected bits omitted by the safety limit')
  })
})
