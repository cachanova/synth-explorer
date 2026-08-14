import { describe, expect, it } from 'vitest'
import type { ConeGraphRequest, SourceGraphRequest } from '../../store'
import type { GraphOptions } from '../../lib/graph/graphSettings'
import {
  coneRequestOptions,
  fullGraphRequestOptions,
  graphDataKeys,
  groupExpansionRequestOptions,
  neighborhoodRequestOptions,
  sourceRequestOptions,
} from './useGraphData'

const options: GraphOptions = {
  maxDepth: 7,
  maxNodes: 900,
  hideControl: true,
  hideConst: false,
  groupVectors: true,
  groupMemories: false,
  focus: true,
}

describe('graph data orchestration', () => {
  it('keys the full graph independently of cone depth, focus, and request nonce', () => {
    const first = graphDataKeys('design-1', 11, options)
    const nextRequest = graphDataKeys('design-1', 12, options)
    const nextDepth = graphDataKeys('design-1', 11, {
      ...options,
      maxDepth: 99,
      focus: false,
    })

    expect(first.fullGraphKey).toBe(nextRequest.fullGraphKey)
    expect(first.fullGraphKey).toBe(nextDepth.fullGraphKey)
    expect(first.currentRequestKey).not.toBe(nextRequest.currentRequestKey)
    expect(first.currentRequestKey).not.toBe(nextDepth.currentRequestKey)
  })

  it('keeps full-graph requests capped and infrastructure-free', () => {
    expect(fullGraphRequestOptions(options)).toEqual({
      max_nodes: 900,
      show_infrastructure: false,
      group_vectors: true,
      group_memories: false,
      hide_control: true,
      hide_const: false,
    })
  })

  it('preserves multi-root and boundary-port cone options', () => {
    const request: ConeGraphRequest = {
      kind: 'cone',
      designId: 'design-1',
      node: 4,
      nodes: [4, 8],
      dir: 'fanin',
      label: 'inputs',
      highlight: [4],
      rootPort: 'A',
      rootPortBit: 2,
      rootPortBits: [2, 3],
      nonce: 1,
    }

    expect(coneRequestOptions(request, options)).toEqual({
      node: 4,
      nodes: [4, 8],
      dir: 'fanin',
      max_depth: 7,
      max_nodes: 900,
      hide_control: true,
      hide_const: false,
      show_infrastructure: false,
      group_vectors: true,
      group_memories: false,
      root_port: 'A',
      root_port_bit: 2,
      root_port_bits: [2, 3],
    })
  })

  it('keeps source selection coordinates separate from graph filters', () => {
    const request: SourceGraphRequest = {
      kind: 'source',
      file: 'top.sv',
      startLine: 8,
      startColumn: 3,
      endLine: 9,
      endColumn: 7,
      fallbackStartColumn: 1,
      fallbackEndColumn: 12,
      selectionTruncated: false,
      label: 'counter',
      highlight: [],
      nonce: 3,
    }

    expect(sourceRequestOptions(request, options)).toEqual({
      selection: {
        file: 'top.sv',
        startLine: 8,
        startColumn: 3,
        endLine: 9,
        endColumn: 7,
        fallbackStartColumn: 1,
        fallbackEndColumn: 12,
      },
      filters: {
        maxNodes: 900,
        hideControl: true,
        hideConst: false,
        groupVectors: true,
        groupMemories: false,
      },
    })
  })

  it('bounds group and one-hop expansion requests independently', () => {
    expect(groupExpansionRequestOptions(14, [14, 21], options)).toEqual({
      node: 14,
      expanded_nodes: [14, 21],
      max_nodes: 4_096,
      hide_control: true,
      hide_const: false,
      group_vectors: true,
      group_memories: false,
    })
    expect(neighborhoodRequestOptions(14, 'fanout', options)).toEqual({
      node: 14,
      nodes: undefined,
      dir: 'fanout',
      max_depth: 1,
      max_nodes: 900,
      hide_control: true,
      hide_const: false,
      show_infrastructure: false,
      group_vectors: true,
      group_memories: false,
    })
  })
})
