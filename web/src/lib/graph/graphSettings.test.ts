import { describe, expect, it } from 'vitest'
import { MAX_GRAPH_RENDER_NODES } from './graphLimits'
import {
  DEFAULT_GRAPH_OPTIONS,
  MIN_GRAPH_MAX_NODES,
  parseStoredGraphOptions,
} from './graphSettings'

const valid = {
  maxDepth: 12,
  maxNodes: 800,
  hideControl: false,
  hideConst: false,
  focus: false,
  groupVectors: false,
  groupMemories: false,
}

describe('stored graph options', () => {
  it('restores every toggle and stepper the graph toolbar writes', () => {
    expect(parseStoredGraphOptions(valid)).toEqual(valid)
  })

  it('falls back to the defaults for absent or malformed values', () => {
    expect(parseStoredGraphOptions(null)).toEqual(DEFAULT_GRAPH_OPTIONS)
    expect(parseStoredGraphOptions('nonsense')).toEqual(DEFAULT_GRAPH_OPTIONS)
    expect(parseStoredGraphOptions({ ...valid, focus: 'yes' })).toEqual(
      DEFAULT_GRAPH_OPTIONS,
    )
    expect(parseStoredGraphOptions({ ...valid, maxNodes: 'many' })).toEqual(
      DEFAULT_GRAPH_OPTIONS,
    )
    expect(parseStoredGraphOptions({ ...valid, maxDepth: Number.NaN })).toEqual(
      DEFAULT_GRAPH_OPTIONS,
    )
  })

  it('clamps stored node counts to the range the stepper allows', () => {
    expect(parseStoredGraphOptions({ ...valid, maxNodes: 1 }).maxNodes).toBe(
      MIN_GRAPH_MAX_NODES,
    )
    expect(
      parseStoredGraphOptions({ ...valid, maxNodes: 99_999 }).maxNodes,
    ).toBe(MAX_GRAPH_RENDER_NODES)
  })

  it('keeps cone depth a positive integer', () => {
    expect(parseStoredGraphOptions({ ...valid, maxDepth: 0 }).maxDepth).toBe(1)
    expect(parseStoredGraphOptions({ ...valid, maxDepth: 7.6 }).maxDepth).toBe(8)
  })
})
