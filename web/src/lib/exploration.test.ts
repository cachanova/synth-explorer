import { describe, expect, it } from 'vitest'
import type { ExplorationNode, ExplorationSnapshot } from '../types'
import { analyzeSourceSelection, prepareExploration } from './exploration'

const options = {
  maxNodes: 400,
  hideControl: true,
  hideConst: true,
  groupVectors: false,
}

describe('browser source exploration', () => {
  it('follows prepared assignment direction without including downstream consumers', () => {
    const snapshot = fixture()
    snapshot.source_by_line['top.sv:4'] = [1]
    snapshot.source_hints.push({
      file: 'top.sv',
      start_line: 4,
      end_line: 4,
      direction: 'fanin',
      kind: 'signal',
    })

    const response = analyzeSourceSelection(prepareExploration(snapshot), 'top.sv', 4, 4, options)

    expect(response.status).toBe('mapped')
    expect(response.graph.nodes.map((node) => node.id)).toEqual([0, 1])
    expect(response.graph.nodes.find((node) => node.id === 1)?.is_root).toBe(true)
    expect(response.directIds).toEqual([1])
  })

  it('follows prepared input declarations through fanout', () => {
    const snapshot = fixture()
    snapshot.source_by_line['top.sv:2'] = [0]
    snapshot.source_hints.push({
      file: 'top.sv',
      start_line: 2,
      end_line: 2,
      direction: 'fanout',
      kind: 'signal',
    })

    const response = analyzeSourceSelection(prepareExploration(snapshot), 'top.sv', 2, 2, options)

    expect(response.graph.nodes.map((node) => node.id)).toEqual([0, 1, 2])
    expect(response.graph.nodes.find((node) => node.id === 2)?.is_boundary).toBe(true)
    expect(response.directIds).toEqual([0])
  })

  it('keeps upstream context visible without highlighting it as direct source logic', () => {
    const snapshot = fixture()
    snapshot.nodes.splice(
      2,
      0,
      node(2, 'cell', { name: 'selected_logic', comb: true, depth: 2 }),
    )
    snapshot.nodes[3] = node(3, 'port', {
      name: 'y',
      boundary: true,
      output_frontier: true,
    })
    snapshot.edges = [edge(0, 1, 'a', 'A'), edge(1, 2, 'Y', 'A'), edge(2, 3, 'Y', 'y')]
    snapshot.source_by_line['top.sv:4'] = [2]
    snapshot.source_hints.push({
      file: 'top.sv',
      start_line: 4,
      end_line: 4,
      direction: 'fanin',
      kind: 'signal',
    })

    const response = analyzeSourceSelection(prepareExploration(snapshot), 'top.sv', 4, 4, options)

    expect(response.graph.nodes.map((entry) => entry.id)).toEqual([0, 1, 2])
    expect(response.graph.nodes.filter((entry) => entry.is_root).map((entry) => entry.id)).toEqual([2])
    expect(response.directIds).toEqual([2])
  })

  it('narrows block-attributed roots to the selected procedural target', () => {
    const snapshot = fixture()
    snapshot.nodes.push(
      node(3, 'cell', { name: 'state_a', seq: true, register: true, src: 'top.sv:8.1-14.3' }),
      node(4, 'cell', { name: 'state_b', seq: true, register: true, src: 'top.sv:8.1-14.3' }),
    )
    snapshot.source_by_line['top.sv:10'] = [3, 4]
    snapshot.source_hints.push({
      file: 'top.sv',
      start_line: 10,
      end_line: 10,
      direction: 'fanin',
      kind: 'procedural',
    })
    snapshot.procedural_targets['top.sv'] = { '10': [3] }

    const response = analyzeSourceSelection(prepareExploration(snapshot), 'top.sv', 10, 10, options)

    expect(response.graph.nodes.filter((entry) => entry.is_root).map((entry) => entry.id)).toEqual([3])
    expect(response.directIds).toEqual([3])
  })

  it('queries sparse targets without walking every line of a large procedural block', () => {
    const snapshot = fixture()
    snapshot.source_hints.push({
      file: 'top.sv',
      start_line: 1,
      end_line: 1_000_000_000,
      direction: 'fanin',
      kind: 'block',
    })
    snapshot.procedural_targets['top.sv'] = { '999999999': [1] }

    const response = analyzeSourceSelection(
      prepareExploration(snapshot),
      'top.sv',
      500_000_000,
      500_000_000,
      options,
    )

    expect(response.status).toBe('mapped')
    expect(response.graph.nodes.find((entry) => entry.id === 1)?.is_root).toBe(true)
  })

  it('distinguishes optimized source from unmapped text using the prepared source index', () => {
    const snapshot = fixture()
    snapshot.source_seen_lines.push('top.sv:20')
    const prepared = prepareExploration(snapshot)

    expect(analyzeSourceSelection(prepared, 'top.sv', 20, 20, options).status).toBe(
      'optimized_or_absorbed',
    )
    expect(analyzeSourceSelection(prepared, 'top.sv', 21, 21, options).status).toBe('unmapped')
  })

  it('expands a directly connected output register through its data input', () => {
    const snapshot = fixture()
    snapshot.nodes.splice(
      2,
      0,
      node(2, 'cell', {
        name: 'registered',
        seq: true,
        register: true,
        boundary: true,
        register_type: true,
      }),
    )
    snapshot.nodes[3] = node(3, 'port', {
      name: 'y',
      boundary: true,
      output_frontier: true,
    })
    snapshot.edges = [edge(0, 1, 'a', 'A'), edge(1, 2, 'Y', 'D'), edge(2, 3, 'Q', 'y')]
    snapshot.source_by_line['top.sv:5'] = [3]
    snapshot.source_hints.push({
      file: 'top.sv',
      start_line: 5,
      end_line: 5,
      direction: 'fanin',
      kind: 'output_port',
    })

    const response = analyzeSourceSelection(prepareExploration(snapshot), 'top.sv', 5, 5, options)

    expect(response.graph.nodes.map((entry) => entry.id)).toEqual([0, 1, 2, 3])
  })

  it('uses a bidirectional envelope when Rust prepared no directional hint', () => {
    const snapshot = fixture()
    snapshot.source_by_line['top.sv:7'] = [1]

    const response = analyzeSourceSelection(prepareExploration(snapshot), 'top.sv', 7, 7, options)

    expect(response.graph.nodes.map((entry) => entry.id)).toEqual([0, 1, 2])
    expect(response.directIds).toEqual([1])
  })

  it('projects prepared vector groups and gives incomplete mapping precedence', () => {
    const snapshot = fixture()
    snapshot.nodes.push(node(3, 'cell', {
      name: 'logic_2',
      comb: true,
      depth: 1,
      group_id: 0,
      src: 'top.sv:3-3|top.sv:9-12',
      group_src: 'top.sv:9-12',
    }))
    snapshot.nodes[1].group_id = 0
    snapshot.nodes[1].src = 'top.sv:2-2|top.sv:9-12'
    snapshot.nodes[1].group_src = 'top.sv:9-12'
    snapshot.groups.push({ kind: 'comb', members: [1, 3], label: 'logic[1:0]', cell_type: '$and' })
    snapshot.source_ranges.push({
      file: 'top.sv',
      start_line: 9,
      end_line: 9,
      node_ids: [1, 3],
      mapping_incomplete: true,
    })
    snapshot.source_hints.push({
      file: 'top.sv',
      start_line: 9,
      end_line: 9,
      direction: 'fanin',
      kind: 'signal',
    })

    const response = analyzeSourceSelection(prepareExploration(snapshot), 'top.sv', 9, 9, {
      ...options,
      groupVectors: true,
    })

    expect(response.status).toBe('mapping_incomplete')
    const group = response.graph.nodes.find((entry) => entry.members?.length === 2)
    expect(group).toMatchObject({
      id: 4,
      name: 'logic[1:0]',
      is_root: true,
      src: 'top.sv:9-12',
      width: 2,
    })
    expect(response.directIds).toEqual([4])
    expect(group).not.toHaveProperty('controls')
  })

  it('omits recovered source metadata from grouped ports like the production projection', () => {
    const snapshot = fixture()
    snapshot.nodes[0].group_id = 0
    snapshot.nodes[0].src = 'top.sv:2-2'
    snapshot.nodes.push(node(3, 'port', {
      name: 'a_2',
      boundary: true,
      group_id: 0,
      src: 'top.sv:2-2',
    }))
    snapshot.groups.push({ kind: 'port', members: [0, 3], label: 'a[1:0]', cell_type: '' })
    snapshot.source_by_line['top.sv:2'] = [0, 3]

    const response = analyzeSourceSelection(prepareExploration(snapshot), 'top.sv', 2, 2, {
      ...options,
      groupVectors: true,
    })

    const group = response.graph.nodes.find((entry) => entry.members?.length === 2)
    expect(group).toMatchObject({ id: 4, name: 'a[1:0]', width: 2 })
    expect(group).not.toHaveProperty('src')
    expect(group).not.toHaveProperty('controls')
  })
})

function fixture(): ExplorationSnapshot {
  return {
    design_id: 'design',
    schema_version: 1,
    files: ['top.sv'],
    nodes: [
      node(0, 'port', { name: 'a', boundary: true }),
      node(1, 'cell', { name: 'logic', comb: true, depth: 1 }),
      node(2, 'port', { name: 'y', boundary: true, output_frontier: true }),
    ],
    edges: [
      edge(0, 1, 'a', 'A'),
      edge(1, 2, 'Y', 'y'),
    ],
    source_by_line: {},
    source_ranges: [],
    source_hints: [],
    procedural_targets: {},
    source_seen_lines: [],
    source_seen_ranges: [],
    groups: [],
  }
}

function node(
  id: number,
  kind: 'cell' | 'port' | 'const',
  overrides: Partial<ExplorationNode>,
): ExplorationNode {
  return {
    id,
    kind,
    name: `node_${id}`,
    boundary: false,
    comb: false,
    constant: kind === 'const',
    output_frontier: false,
    addressable_sequential: false,
    register_type: false,
    infrastructure: false,
    transparent_buffer: false,
    ...overrides,
  }
}

function edge(from: number, to: number, fromPort: string, toPort: string) {
  return {
    from,
    to,
    from_port: fromPort,
    to_port: toPort,
    net_name: `${from}_${to}`,
    control: false,
    hidden_control: false,
    depth_input: true,
    depth_output: true,
  }
}
