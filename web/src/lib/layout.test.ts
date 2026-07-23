import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GraphNode, Subgraph } from '../types'
import {
  MAX_GRAPH_EDGES,
  MAX_GROUP_EXPANSION_RENDER_NODES,
} from './graphLimits'
import {
  clearLayoutGeometryCache,
  controlRoleForPin,
  DENSE_LAYOUT_NODE_THRESHOLD,
  DENSE_LONGEST_PATH_EDGE_DENSITY,
  fitViewportToContent,
  hydrateLayoutResult,
  interpretResult,
  LAYOUT_GEOMETRY_CACHE_MAX_BYTES,
  LAYOUT_GEOMETRY_CACHE_MAX_ENTRIES,
  MAX_GLOBAL_LAYOUT_COMPONENTS,
  layoutExpandedGroupInPlace,
  layoutSubgraph,
  NETWORK_SIMPLEX_EDGE_LIMIT,
  NETWORK_SIMPLEX_NODE_LIMIT,
  nodeDimensions,
  panViewport,
  placementForLayout,
  prewarmLayoutWorker,
  preserveViewportAnchor,
  prepareLayoutInput,
  REG_BODY_HEIGHT,
  REG_DATA_IN_Y_FRAC,
  REG_DATA_OUT_Y_FRAC,
  registerControlYFraction,
  REDUCED_THOROUGHNESS_EDGE_DENSITY,
  REDUCED_THOROUGHNESS_NODE_THRESHOLD,
  shouldRefitProjection,
  toElkGraph,
  type LayoutInput,
  viewportTransformAttribute,
  zoomViewportAt,
} from './layout'

const node = (id: number, cellType: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  id,
  kind: 'cell',
  name: `u${id}`,
  cell_type: cellType,
  ...extra,
})

describe('in-place group expansion layout', () => {
  it('keeps unrelated geometry fixed and opens members around the old group anchor', () => {
    const grouped = node(100, 'FDRE', {
      name: 'count[4:0]',
      members: [1, 2, 3, 4, 5],
      member_count: 5,
    })
    const externalIn = node(9, '$_BUF_')
    const externalOut = node(10, '$_BUF_')
    const unrelated = node(11, '$_AND_')
    const externalClock = node(12, '$_BUF_')
    const members = [1, 2, 3, 4, 5].map((id) => node(id, 'FDRE'))
    const base = {
      nodes: [
        { id: 9, x: 20, y: 120, width: 76, height: 52, node: externalIn },
        { id: 100, x: 260, y: 100, width: 110, height: 78, node: grouped },
        { id: 10, x: 520, y: 120, width: 76, height: 52, node: externalOut },
        { id: 11, x: 520, y: 360, width: 76, height: 52, node: unrelated },
        { id: 12, x: 20, y: 220, width: 76, height: 52, node: externalClock },
      ],
      edges: [
        {
          from: 9,
          to: 100,
          points: [
            { x: 96, y: 146 },
            { x: 180, y: 146 },
            { x: 180, y: 139 },
            { x: 260, y: 139 },
          ],
          edge: {
            from: 9,
            to: 100,
            from_port: 'Y',
            to_port: 'D',
            net_name: 'in',
            bits: [1],
          },
        },
        {
          from: 100,
          to: 10,
          points: [
            { x: 370, y: 139 },
            { x: 445, y: 139 },
            { x: 445, y: 146 },
            { x: 520, y: 146 },
          ],
          edge: {
            from: 100,
            to: 10,
            from_port: 'Q',
            to_port: 'A',
            net_name: 'out',
            bits: [2],
          },
        },
        {
          from: 12,
          to: 100,
          points: [
            { x: 96, y: 246 },
            { x: 180, y: 246 },
            { x: 180, y: 151 },
            { x: 260, y: 151 },
          ],
          edge: {
            from: 12,
            to: 100,
            from_port: 'Y',
            to_port: 'CLK',
            net_name: 'clk',
            bits: [4],
            control: true,
          },
        },
        {
          from: 9,
          to: 11,
          points: [{ x: 96, y: 146 }, { x: 520, y: 386 }],
          edge: {
            from: 9,
            to: 11,
            from_port: 'Y',
            to_port: 'A',
            net_name: 'unrelated',
            bits: [3],
          },
        },
      ],
      width: 620,
      height: 450,
    }
    const sub: Subgraph = {
      nodes: [...members, externalIn, externalOut, unrelated, externalClock],
      edges: [
        {
          from: 12,
          to: 3,
          from_port: 'Y',
          to_port: 'CLK',
          net_name: 'clk',
          bits: [4],
          control: true,
        },
        {
          from: 9,
          to: 1,
          from_port: 'Y',
          to_port: 'D',
          net_name: 'in',
          bits: [1],
        },
        {
          from: 2,
          to: 10,
          from_port: 'Q',
          to_port: 'A',
          net_name: 'out',
          bits: [2],
        },
        {
          from: 9,
          to: 11,
          from_port: 'Y',
          to_port: 'A',
          net_name: 'unrelated',
          bits: [3],
        },
      ],
      truncated: false,
    }

    const opened = layoutExpandedGroupInPlace(sub, base, {
      id: 100,
      members: [1, 2, 3, 4, 5],
    })

    expect(opened).not.toBeNull()
    expect(opened!.nodes).not.toContainEqual(expect.objectContaining({ id: 100 }))
    for (const id of [9, 10, 11, 12]) {
      expect(opened!.nodes.find((entry) => entry.id === id)).toMatchObject(
        base.nodes.find((entry) => entry.id === id)!,
      )
    }
    const memberGeometry = opened!.nodes.filter((entry) => entry.id <= 5)
    expect(new Set(memberGeometry.map((entry) => entry.x)).size).toBeGreaterThan(1)
    expect(new Set(memberGeometry.map((entry) => entry.y)).size).toBeGreaterThan(1)
    const memberCenterX =
      (Math.min(...memberGeometry.map((entry) => entry.x)) +
        Math.max(...memberGeometry.map((entry) => entry.x + entry.width))) / 2
    expect(memberCenterX).toBeCloseTo(315)
    expect(opened!.edges.find((edge) => edge.edge.net_name === 'unrelated')?.points)
      .toEqual(base.edges[3].points)
    const incoming = opened!.edges.find((edge) => edge.edge.net_name === 'in')!
    const outgoing = opened!.edges.find((edge) => edge.edge.net_name === 'out')!
    const clock = opened!.edges.find((edge) => edge.edge.net_name === 'clk')!
    expect(incoming.points).toContainEqual(base.edges[0].points.at(-1))
    expect(outgoing.points).toContainEqual(base.edges[1].points[0])
    const member1 = memberGeometry.find((entry) => entry.id === 1)!
    const member2 = memberGeometry.find((entry) => entry.id === 2)!
    const member3 = memberGeometry.find((entry) => entry.id === 3)!
    expect(incoming.points.at(-1)).toEqual({
      x: member1.x,
      y: member1.y + Math.min(member1.height, REG_BODY_HEIGHT) * REG_DATA_IN_Y_FRAC,
    })
    expect(outgoing.points[0]).toEqual({
      x: member2.x + member2.width,
      y: member2.y + Math.min(member2.height, REG_BODY_HEIGHT) * REG_DATA_OUT_Y_FRAC,
    })
    expect(clock.points.at(-1)).toEqual({
      x: member3.x,
      y: member3.y +
        Math.min(member3.height, REG_BODY_HEIGHT) * registerControlYFraction('clock'),
    })
    for (const edge of [incoming, outgoing, clock]) {
      expect(edge.points.slice(1).every((point, index) => {
        const previous = edge.points[index]
        return point.x === previous.x || point.y === previous.y
      })).toBe(true)
    }
  })

  it('uses the nearest collision-free local slot instead of enclosing another node', () => {
    const grouped = node(100, 'FDRE', {
      name: 'count[1:0]',
      members: [1, 2],
      member_count: 2,
    })
    const blocker = node(9, 'LUT6')
    const base = {
      nodes: [
        { id: 100, x: 260, y: 100, width: 110, height: 78, node: grouped },
        { id: 9, x: 390, y: 100, width: 90, height: 78, node: blocker },
      ],
      edges: [],
      width: 520,
      height: 240,
    }
    const sub: Subgraph = {
      nodes: [node(1, 'FDRE'), node(2, 'FDRE'), blocker],
      edges: [],
      truncated: false,
    }

    const opened = layoutExpandedGroupInPlace(sub, base, {
      id: 100,
      members: [1, 2],
    })!
    const members = opened.nodes.filter((entry) => entry.id === 1 || entry.id === 2)
    const membersRight = Math.max(...members.map((entry) => entry.x + entry.width))
    const membersLeft = Math.min(...members.map((entry) => entry.x))
    const membersBottom = Math.max(...members.map((entry) => entry.y + entry.height))
    const membersTop = Math.min(...members.map((entry) => entry.y))
    const overlapsBlocker =
      membersLeft < 390 + 90 &&
      membersRight > 390 &&
      membersTop < 100 + 78 &&
      membersBottom > 100

    expect(overlapsBlocker).toBe(false)
    expect(opened.nodes.find((entry) => entry.id === 9)).toMatchObject(base.nodes[1])
  })

  it('spreads expanded memory edges across their named input pins', () => {
    const grouped = node(100, 'RAM64M', {
      name: 'memory [64×1]',
      members: [1],
      member_count: 1,
    })
    const sourceA = node(9, '$_BUF_')
    const base = {
      nodes: [
        { id: 9, x: 20, y: 70, width: 76, height: 52, node: sourceA },
        { id: 100, x: 260, y: 100, width: 110, height: 78, node: grouped },
      ],
      edges: [
        {
          from: 9,
          to: 100,
          points: [{ x: 96, y: 96 }, { x: 180, y: 96 }, { x: 180, y: 126 }, { x: 260, y: 126 }],
          edge: {
            from: 9,
            to: 100,
            from_port: 'Y',
            to_port: 'A0',
            net_name: 'address_0',
            bits: [1],
          },
        },
        {
          from: 9,
          to: 100,
          points: [{ x: 96, y: 96 }, { x: 200, y: 96 }, { x: 200, y: 152 }, { x: 260, y: 152 }],
          edge: {
            from: 9,
            to: 100,
            from_port: 'Y',
            to_port: 'A1',
            net_name: 'address_1',
            bits: [2],
          },
        },
      ],
      width: 420,
      height: 260,
    }
    const sub: Subgraph = {
      nodes: [node(1, 'RAM64M'), sourceA],
      edges: [
        {
          from: 9,
          to: 1,
          from_port: 'Y',
          to_port: 'A0',
          net_name: 'address_0',
          bits: [1],
        },
        {
          from: 9,
          to: 1,
          from_port: 'Y',
          to_port: 'A1',
          net_name: 'address_1',
          bits: [2],
        },
      ],
      truncated: false,
    }

    const opened = layoutExpandedGroupInPlace(sub, base, {
      id: 100,
      members: [1],
    })!
    const member = opened.nodes.find((entry) => entry.id === 1)!
    const address0 = opened.edges.find((edge) => edge.edge.to_port === 'A0')!
    const address1 = opened.edges.find((edge) => edge.edge.to_port === 'A1')!
    const endpoints = [address0.points.at(-1)!, address1.points.at(-1)!]

    expect(endpoints.map((point) => point.x)).toEqual([member.x, member.x])
    expect(endpoints[0].y).toBeLessThan(endpoints[1].y)
    expect(endpoints.every((point) =>
      point.y > member.y && point.y < member.y + member.height
    )).toBe(true)
    expect(address0.points).toContainEqual(base.edges[0].points.at(-1))
    expect(address1.points).toContainEqual(base.edges[1].points.at(-1))
  })

  it('preserves distinct quotient trunks for named output pins', () => {
    const grouped = node(100, 'RAM64M', {
      name: 'memory [64×1]',
      members: [1],
      member_count: 1,
    })
    const target = node(9, '$_BUF_')
    const base = {
      nodes: [
        { id: 100, x: 100, y: 100, width: 110, height: 78, node: grouped },
        { id: 9, x: 420, y: 120, width: 76, height: 52, node: target },
      ],
      edges: [
        {
          from: 100,
          to: 9,
          points: [
            { x: 210, y: 126 },
            { x: 300, y: 126 },
            { x: 300, y: 146 },
            { x: 420, y: 146 },
          ],
          edge: {
            from: 100,
            to: 9,
            from_port: 'O0',
            to_port: 'A',
            net_name: 'output_0',
            bits: [1],
          },
        },
        {
          from: 100,
          to: 9,
          points: [
            { x: 210, y: 152 },
            { x: 340, y: 152 },
            { x: 340, y: 146 },
            { x: 420, y: 146 },
          ],
          edge: {
            from: 100,
            to: 9,
            from_port: 'O1',
            to_port: 'A',
            net_name: 'output_1',
            bits: [2],
          },
        },
      ],
      width: 540,
      height: 260,
    }
    const sub: Subgraph = {
      nodes: [node(1, 'RAM64M'), target],
      edges: [
        {
          from: 1,
          to: 9,
          from_port: 'O0',
          to_port: 'A',
          net_name: 'output_0',
          bits: [1],
        },
        {
          from: 1,
          to: 9,
          from_port: 'O1',
          to_port: 'A',
          net_name: 'output_1',
          bits: [2],
        },
      ],
      truncated: false,
    }

    const opened = layoutExpandedGroupInPlace(sub, base, {
      id: 100,
      members: [1],
    })!
    const output0 = opened.edges.find((edge) => edge.edge.from_port === 'O0')!
    const output1 = opened.edges.find((edge) => edge.edge.from_port === 'O1')!

    expect(output0.points).toContainEqual(base.edges[0].points[0])
    expect(output0.points).not.toContainEqual(base.edges[1].points[0])
    expect(output1.points).toContainEqual(base.edges[1].points[0])
    expect(output1.points).not.toContainEqual(base.edges[0].points[0])
  })

  it('falls back to a guaranteed clear slot when every nearby slot is occupied', () => {
    const grouped = node(100, 'FDRE', {
      name: 'count[1:0]',
      members: [1, 2],
      member_count: 2,
    })
    const blocker = node(9, 'LUT6')
    const base = {
      nodes: [
        { id: 100, x: 260, y: 100, width: 110, height: 78, node: grouped },
        { id: 9, x: 0, y: 0, width: 5_000, height: 5_000, node: blocker },
      ],
      edges: [],
      width: 5_100,
      height: 5_100,
    }
    const sub: Subgraph = {
      nodes: [node(1, 'FDRE'), node(2, 'FDRE'), blocker],
      edges: [],
      truncated: false,
    }

    const opened = layoutExpandedGroupInPlace(sub, base, {
      id: 100,
      members: [1, 2],
    })!
    const members = opened.nodes.filter((entry) => entry.id === 1 || entry.id === 2)
    const left = Math.min(...members.map((entry) => entry.x))
    const top = Math.min(...members.map((entry) => entry.y))

    expect(left >= 5_000 || top >= 5_000).toBe(true)
  })

  it('declines local composition when the projection introduces new context', () => {
    const grouped = node(100, 'FDRE', {
      members: [1],
      member_count: 1,
    })
    const base = {
      nodes: [{ id: 100, x: 20, y: 20, width: 100, height: 58, node: grouped }],
      edges: [],
      width: 160,
      height: 100,
    }
    const sub: Subgraph = {
      nodes: [node(1, 'FDRE'), node(9, 'LUT6')],
      edges: [],
      truncated: false,
    }

    expect(layoutExpandedGroupInPlace(sub, base, {
      id: 100,
      members: [1],
    })).toBeNull()
  })
})

describe('schematic layout sizing', () => {
  it('classifies vendor memory clock pin spellings as clocks', () => {
    for (const pin of ['WCLK', 'RCLK', 'CLKA', 'CLKB', 'CLKARDCLK']) {
      expect(controlRoleForPin(pin)).toBe('clock')
    }
  })

  it('gives gates compact schematic proportions', () => {
    expect(nodeDimensions(node(1, '$_AND_'))).toEqual({ width: 76, height: 52 })
  })

  it('gives carry and DSP primitives distinct hard-block proportions', () => {
    expect(nodeDimensions(node(1, 'CARRY8'))).toEqual({ width: 98, height: 58 })
    expect(nodeDimensions(node(2, 'DSP48E2'))).toEqual({ width: 112, height: 62 })
    expect(nodeDimensions(node(3, 'SB_MAC16'))).toEqual({ width: 112, height: 62 })
  })

  it('sizes Vivado implementation cells from the readable RTL-facing name', () => {
    expect(nodeDimensions(node(1, 'LUT1', {
      name: 'one_hot_OBUF[23]_inst_i_6_2',
    }))).toEqual({ width: 103, height: 54 })
  })

  it('reserves register space for compact control-net labels', () => {
    const plain = nodeDimensions(node(1, 'FDRE'))
    const controlledNode = node(2, 'FDRE')
    controlledNode.controls = [
      { role: 'clock', pin: 'C', net_name: 'sys_clk', driver_id: 8, fanout: 2 },
      { role: 'reset', pin: 'R', net_name: 'rst_n', driver_id: 9, fanout: 2 },
    ]
    const controlled = nodeDimensions(controlledNode)
    expect(controlled.height).toBeGreaterThan(plain.height)
    expect(controlled.width).toBeGreaterThanOrEqual(plain.width)
  })

  it('adds a badge row and width for grouped vector nodes', () => {
    const plain = nodeDimensions(node(1, 'FDRE'))
    const grouped = nodeDimensions(
      node(2, 'FDRE', { width: 8, members: [1, 2, 3, 4, 5, 6, 7, 8] }),
    )
    // A grouped node reserves an extra row for its "×N" badge.
    expect(grouped.height).toBe(plain.height + 14)
    expect(grouped.width).toBeGreaterThanOrEqual(plain.width)
    // A single-bit node (width 1) is not treated as grouped.
    expect(nodeDimensions(node(3, 'FDRE', { width: 1 }))).toEqual(plain)
  })

  it('reserves one row for every label-connected control', () => {
    const controlledNode = node(2, 'FDRE', {
      controls: [
        { role: 'clock', pin: 'C', net_name: 'clk', driver_id: 8, fanout: 2 },
        { role: 'reset', pin: 'R', net_name: 'rst', driver_id: 9, fanout: 2 },
        { role: 'enable', pin: 'CE', net_name: 'ce', driver_id: 10, fanout: 2 },
        { role: 'set', pin: 'S', net_name: 'set', driver_id: 11, fanout: 2 },
      ],
    })

    expect(nodeDimensions(controlledNode).height).toBe(58 + 4 * 13)

    const controlledSrl = node(3, 'SRL16E', {
      register: false,
      seq: true,
      controls: [
        { role: 'clock', pin: 'CLK', net_name: 'clk', driver_id: 8, fanout: 2 },
      ],
    })
    expect(nodeDimensions(controlledSrl).height).toBe(62 + 13)
  })

  it('reserves one row for a compact multi-net grouped control', () => {
    const groupedMemory = node(4, '$mem_v2', {
      member_count: 1_024,
      controls: [
        { role: 'clock', pin: 'CLK', net_name: 'clk', driver_id: 8, fanout: 1_024 },
        {
          role: 'enable',
          pin: 'EN',
          net_name: 'row_en[0]',
          driver_id: 9,
          driver_ids: Array.from({ length: 64 }, (_, index) => index + 9),
          net_count: 64,
          fanout: 1_024,
        },
      ],
    })

    expect(nodeDimensions(groupedMemory).height).toBe(62 + 2 * 13 + 14)
  })

  it('passes per-symbol dimensions to bounded ELK layout', () => {
    const sub: Subgraph = {
      nodes: [node(1, '$_XOR_'), node(2, '$mem_v2', { is_boundary: true })],
      edges: [
        {
          from: 1,
          to: 2,
          from_port: 'Y',
          to_port: 'D',
          net_name: 'result',
          bits: [1],
        },
      ],
      truncated: false,
    }
    const graph = toElkGraph(prepareLayoutInput(sub))
    expect(graph.children?.map(({ width, height }) => ({ width, height }))).toEqual([
      nodeDimensions(sub.nodes[0]),
      nodeDimensions(sub.nodes[1]),
    ])
    expect(graph.layoutOptions?.['elk.edgeRouting']).toBe('ORTHOGONAL')
  })

  it('pins unambiguous primary inputs and outputs to opposite layout boundaries', () => {
    const sub: Subgraph = {
      nodes: [
        node(30, 'port', {
          kind: 'port',
          name: 'result',
          port_direction: 'output',
        }),
        node(20, '$_DFFSR_PPP_', {
          seq: true,
          controls: [
            { role: 'clock', pin: 'C', net_name: 'clk', driver_id: 2, fanout: 1 },
          ],
        }),
        node(10, '$_MUX_'),
        node(2, 'port', {
          kind: 'port',
          name: 'clk',
          port_direction: 'input',
        }),
        node(1, 'port', {
          kind: 'port',
          name: 'data',
          port_direction: 'input',
        }),
        node(40, 'port', {
          kind: 'port',
          name: 'inout',
          port_direction: 'inout',
        }),
      ],
      edges: [
        { from: 1, to: 10, from_port: 'data', to_port: 'A', net_name: 'data', bits: [1] },
        { from: 10, to: 20, from_port: 'Y', to_port: 'D', net_name: 'd', bits: [2] },
        { from: 20, to: 40, from_port: 'Q', to_port: 'in', net_name: 'q', bits: [3] },
        { from: 40, to: 30, from_port: 'out', to_port: 'result', net_name: 'result', bits: [4] },
      ],
      truncated: false,
    }

    const input = prepareLayoutInput(sub)
    expect(input.nodes.map((candidate) => ({
      id: candidate.id,
      boundary: candidate.boundary,
    }))).toEqual([
      { id: 30, boundary: 'output' },
      { id: 20, boundary: 'internal' },
      { id: 10, boundary: 'internal' },
      { id: 2, boundary: 'input' },
      { id: 1, boundary: 'input' },
      { id: 40, boundary: 'internal' },
    ])

    const graph = toElkGraph(input)
    const layoutOptions = (id: string) =>
      graph.children?.find((candidate) => candidate.id === id)?.layoutOptions
    expect(layoutOptions('1')).toMatchObject({
      'elk.layered.layering.layerConstraint': 'FIRST_SEPARATE',
      'elk.alignment': 'LEFT',
    })
    expect(layoutOptions('2')).toMatchObject({
      'elk.layered.layering.layerConstraint': 'FIRST_SEPARATE',
      'elk.alignment': 'LEFT',
    })
    expect(layoutOptions('30')).toMatchObject({
      'elk.layered.layering.layerConstraint': 'LAST_SEPARATE',
      'elk.alignment': 'RIGHT',
    })
    expect(layoutOptions('40')).not.toHaveProperty(
      'elk.layered.layering.layerConstraint',
    )
    expect(graph.layoutOptions?.['elk.direction']).toBe('RIGHT')
    expect(graph.layoutOptions?.['elk.separateConnectedComponents']).toBe('false')
  })

  it('lets ELK pack highly disconnected views instead of building one tall layer', () => {
    const input = prepareLayoutInput({
      nodes: Array.from(
        { length: MAX_GLOBAL_LAYOUT_COMPONENTS + 8 },
        (_, id) => node(id, '$_BUF_'),
      ),
      edges: [],
      truncated: false,
    })

    expect(
      toElkGraph(input).layoutOptions?.['elk.separateConnectedComponents'],
    ).toBe('true')
  })

  it('preserves global alignment when disconnected components are boundary ports', () => {
    const input: LayoutInput = {
      nodes: Array.from(
        { length: MAX_GLOBAL_LAYOUT_COMPONENTS + 8 },
        (_, id) => ({
          id,
          baseWidth: 74,
          baseHeight: 34,
          controlHeight: 0,
          register: false,
          boundary: 'input',
        }),
      ),
      edges: [],
    }

    expect(
      toElkGraph(input).layoutOptions?.['elk.separateConnectedComponents'],
    ).toBe('false')
  })

  it('packs excess internal orphans even when several components have boundaries', () => {
    const input: LayoutInput = {
      nodes: [
        {
          id: 1,
          baseWidth: 74,
          baseHeight: 34,
          controlHeight: 0,
          register: false,
          boundary: 'input',
        },
        {
          id: 2,
          baseWidth: 74,
          baseHeight: 34,
          controlHeight: 0,
          register: false,
          boundary: 'output',
        },
        ...Array.from(
          { length: MAX_GLOBAL_LAYOUT_COMPONENTS + 1 },
          (_, index) => ({
            id: index + 10,
            baseWidth: 62,
            baseHeight: 46,
            controlHeight: 0,
            register: false,
            boundary: 'internal' as const,
          }),
        ),
      ],
      edges: [],
    }

    expect(
      toElkGraph(input).layoutOptions?.['elk.separateConnectedComponents'],
    ).toBe('true')
  })

  it('reduces ELK thoroughness only on the robust very-large-graph path', () => {
    const input = prepareLayoutInput({
      nodes: [node(1, '$_AND_'), node(2, '$_OR_')],
      edges: [
        {
          from: 1,
          to: 2,
          from_port: 'Y',
          to_port: 'A',
          net_name: 'n1',
          bits: [1],
        },
      ],
      truncated: false,
    })

    expect(
      toElkGraph(input, 'NETWORK_SIMPLEX').layoutOptions?.[
        'elk.layered.thoroughness'
      ],
    ).toBeUndefined()
    expect(
      toElkGraph(input, 'BRANDES_KOEPF').layoutOptions?.[
        'elk.layered.thoroughness'
      ],
    ).toBe('4')

    const belowBoundary = prepareLayoutInput({
      nodes: Array.from(
        { length: REDUCED_THOROUGHNESS_NODE_THRESHOLD - 1 },
        (_, index) => node(index, '$_BUF_'),
      ),
      edges: [],
      truncated: true,
    })
    expect(
      toElkGraph(belowBoundary, 'BRANDES_KOEPF').layoutOptions?.[
        'elk.layered.thoroughness'
      ],
    ).toBe('4')

    const veryLarge = prepareLayoutInput({
      nodes: Array.from(
        { length: REDUCED_THOROUGHNESS_NODE_THRESHOLD },
        (_, index) => node(index, '$_BUF_'),
      ),
      edges: [],
      truncated: true,
    })
    expect(
      toElkGraph(veryLarge, 'BRANDES_KOEPF').layoutOptions?.[
        'elk.layered.thoroughness'
      ],
    ).toBe('3')
  })

  it('uses the benchmarked fast path only for sufficiently dense BK layouts', () => {
    const denseInput = {
      nodes: Array.from({ length: DENSE_LAYOUT_NODE_THRESHOLD }, (_, id) => ({
        id,
        baseWidth: 62,
        baseHeight: 46,
        controlHeight: 0,
        register: false,
        boundary: 'internal' as const,
      })),
      edges: Array.from(
        {
          length: Math.ceil(
            DENSE_LAYOUT_NODE_THRESHOLD * DENSE_LONGEST_PATH_EDGE_DENSITY,
          ),
        },
        (_, index) => ({
          from: index % (DENSE_LAYOUT_NODE_THRESHOLD / 2),
          to: DENSE_LAYOUT_NODE_THRESHOLD / 2 +
            (index % (DENSE_LAYOUT_NODE_THRESHOLD / 2)),
          fromPort: `Y${index}`,
          toPort: `A${index}`,
          control: false,
        }),
      ),
    }
    const dense = toElkGraph(denseInput, 'BRANDES_KOEPF').layoutOptions
    expect(dense?.['elk.layered.thoroughness']).toBe('1')
    expect(dense?.['elk.layered.layering.strategy']).toBe('LONGEST_PATH')

    const mediumDenseInput = {
      ...denseInput,
      edges: denseInput.edges.slice(
        0,
        Math.ceil(
          DENSE_LAYOUT_NODE_THRESHOLD * REDUCED_THOROUGHNESS_EDGE_DENSITY,
        ),
      ),
    }
    const mediumDense = toElkGraph(
      mediumDenseInput,
      'BRANDES_KOEPF',
    ).layoutOptions
    expect(mediumDense?.['elk.layered.thoroughness']).toBe('1')
    expect(mediumDense?.['elk.layered.layering.strategy']).toBeUndefined()

    const belowDensity = toElkGraph(
      {
        ...denseInput,
        edges: denseInput.edges.slice(
          0,
          DENSE_LAYOUT_NODE_THRESHOLD * REDUCED_THOROUGHNESS_EDGE_DENSITY - 1,
        ),
      },
      'BRANDES_KOEPF',
    ).layoutOptions
    expect(belowDensity?.['elk.layered.thoroughness']).toBe('4')
    expect(belowDensity?.['elk.layered.layering.strategy']).toBeUndefined()

    const smallDense = toElkGraph(
      {
        nodes: denseInput.nodes.slice(0, 10),
        edges: Array.from({ length: 40 }, (_, index) => ({
          from: index % 5,
          to: 5 + (index % 5),
          fromPort: `Y${index}`,
          toPort: `A${index}`,
          control: false,
        })),
      },
      'BRANDES_KOEPF',
    ).layoutOptions
    expect(smallDense?.['elk.layered.thoroughness']).toBe('4')
    expect(smallDense?.['elk.layered.layering.strategy']).toBeUndefined()

    const tightPlacement = toElkGraph(denseInput, 'NETWORK_SIMPLEX').layoutOptions
    expect(tightPlacement?.['elk.layered.thoroughness']).toBeUndefined()
    expect(tightPlacement?.['elk.layered.layering.strategy']).toBeUndefined()
  })

  it('routes flip-flop data edges to D and Q ports, not the box centre', () => {
    const sub: Subgraph = {
      nodes: [
        node(1, '$_MUX_', { seq: false }),
        node(2, '$_DFF_P_', { seq: true }),
        node(3, 'port', { kind: 'port' }),
      ],
      edges: [
        { from: 1, to: 2, from_port: 'Y', to_port: 'D', net_name: 'd', bits: [0] },
        { from: 2, to: 3, from_port: 'Q', to_port: 'A', net_name: 'q', bits: [0] },
      ],
      truncated: false,
    }
    const graph = toElkGraph(prepareLayoutInput(sub))
    const reg = graph.children?.find((c) => c.id === '2')
    expect(reg?.ports?.map((p) => p.id)).toEqual(['2#in', '2#out'])
    expect(reg?.layoutOptions?.['elk.portConstraints']).toBe('FIXED_POS')
    // the D edge targets the register's in-port; the Q edge leaves its out-port
    expect(graph.edges?.[0].targets).toEqual(['2#in'])
    expect(graph.edges?.[1].sources).toEqual(['2#out'])
    // non-register nodes now expose a fixed port per distinct pin, so their
    // edges route to spread-out pins rather than the box centre
    const mux = graph.children?.find((c) => c.id === '1')
    expect(mux?.ports?.map((p) => p.id)).toEqual(['1#o:Y'])
    expect(mux?.layoutOptions?.['elk.portConstraints']).toBe('FIXED_POS')
    expect(graph.edges?.[0].sources).toEqual(['1#o:Y'])
    // the sink port node routes the Q edge to its A input pin
    expect(graph.edges?.[1].targets).toEqual(['3#i:A'])
  })

  it('routes every primitive edge to its sorted named pin, including fallback paths', () => {
    const sub: Subgraph = {
      nodes: [
        node(1, 'port', { kind: 'port' }),
        node(2, 'port', { kind: 'port' }),
        node(3, 'port', { kind: 'port' }),
        node(4, 'RAM32M', {
          seq: true,
          register: false,
          controls: [
            { role: 'clock', pin: 'WCLK', net_name: 'clk', driver_id: 8, fanout: 1 },
          ],
        }),
        node(5, 'port', { kind: 'port' }),
      ],
      // Deliberately not alphabetical: rendering and fallback routing must use
      // the same canonical order as the fixed ELK ports.
      edges: [
        { from: 1, to: 4, from_port: 'we', to_port: 'WE', net_name: 'we', bits: [1] },
        { from: 2, to: 4, from_port: 'addr', to_port: 'ADDR', net_name: 'addr', bits: [2] },
        { from: 3, to: 4, from_port: 'wdata', to_port: 'WDATA', net_name: 'wdata', bits: [3] },
        { from: 4, to: 5, from_port: 'RDATA', to_port: 'q', net_name: 'rdata', bits: [4] },
      ],
      truncated: false,
    }

    const elk = toElkGraph(prepareLayoutInput(sub))
    const ram = elk.children?.find((child) => child.id === '4')
    expect(ram?.ports?.map((port) => port.id)).toEqual([
      '4#i:ADDR',
      '4#i:WDATA',
      '4#i:WE',
      '4#o:RDATA',
    ])
    expect(ram?.height).toBe(75)
    expect(ram?.ports?.map((port) => port.y)).toEqual([15.5, 31, 46.5, 31])

    const laidOut = hydrateLayoutResult(sub, interpretResult(prepareLayoutInput(sub), {
      id: 'root',
      width: 500,
      height: 220,
      children: [
        { id: '1', x: 0, y: 0, width: 74, height: 34 },
        { id: '2', x: 0, y: 60, width: 74, height: 34 },
        { id: '3', x: 0, y: 120, width: 74, height: 34 },
        { id: '4', x: 200, y: 80, width: 112, height: 75 },
        { id: '5', x: 420, y: 90, width: 74, height: 34 },
      ],
      edges: [],
    }))
    expect(Object.fromEntries(
      laidOut.edges.slice(0, 3).map((edge) => [edge.edge.to_port, edge.points[1]]),
    )).toEqual({
      ADDR: { x: 200, y: 95.5 },
      WDATA: { x: 200, y: 111 },
      WE: { x: 200, y: 126.5 },
    })
    expect(laidOut.edges[3].points[1]).toEqual({ x: 420, y: 107 })
    expect(laidOut.edges[3].points[0]).toEqual({ x: 312, y: 111 })
  })

  it('routes visible clock and reset edges to their flip-flop pins', () => {
    const sub: Subgraph = {
      nodes: [
        node(1, 'port', { kind: 'port' }),
        node(2, 'port', { kind: 'port' }),
        node(3, '$_DFFSR_PPP_', {
          seq: true,
          controls: [
            // Routing follows the actual edge pin even if optional display
            // metadata is stale or malformed.
            { role: 'reset', pin: 'C', net_name: 'clk', driver_id: 1, fanout: 1 },
            { role: 'clock', pin: 'R', net_name: 'rst', driver_id: 2, fanout: 1 },
          ],
        }),
      ],
      edges: [
        {
          from: 1,
          to: 3,
          from_port: 'clk',
          to_port: 'C',
          net_name: 'clk',
          bits: [0],
          control: true,
        },
        {
          from: 2,
          to: 3,
          from_port: 'rst',
          to_port: 'R',
          net_name: 'rst',
          bits: [0],
          control: true,
        },
      ],
      truncated: false,
    }

    const graph = toElkGraph(prepareLayoutInput(sub))
    const reg = graph.children?.find((child) => child.id === '3')
    const ports = new Map(reg?.ports?.map((port) => [port.id, port]))

    expect(graph.edges?.map((edge) => edge.targets)).toEqual([
      ['3#control:C'],
      ['3#control:R'],
    ])
    expect(ports.get('3#control:C')?.y).toBeCloseTo(58 * 0.72)
    expect(ports.get('3#control:R')?.y).toBeCloseTo(58 * 0.5)

    const laidOut = hydrateLayoutResult(sub, interpretResult(prepareLayoutInput(sub), {
      id: 'root',
      width: 260,
      height: 140,
      children: [
        { id: '1', x: 10, y: 10, width: 74, height: 34 },
        { id: '2', x: 10, y: 90, width: 74, height: 34 },
        { id: '3', x: 160, y: 40, width: 92, height: 84 },
      ],
      edges: [],
    }))
    expect(laidOut.edges[0].points[1]).toEqual({ x: 160, y: 40 + 58 * 0.72 })
    expect(laidOut.edges[1].points[1]).toEqual({ x: 160, y: 40 + 58 * 0.5 })
  })

  it('routes a dataflow-styled enable edge to the physical register enable pin', () => {
    const sub: Subgraph = {
      nodes: [
        node(1, '$_NOT_'),
        node(2, '$_DFFE_PP_', { seq: true, register: true }),
      ],
      edges: [
        {
          from: 1,
          to: 2,
          from_port: 'Y',
          to_port: 'E',
          net_name: 'generated_en',
          bits: [20],
        },
      ],
      truncated: false,
    }

    const input = prepareLayoutInput(sub)
    const graph = toElkGraph(input)
    const reg = graph.children?.find((child) => child.id === '2')
    const ports = new Map(reg?.ports?.map((port) => [port.id, port]))

    expect(graph.edges?.[0].targets).toEqual(['2#control:E'])
    expect(ports.get('2#control:E')?.y).toBeCloseTo(58 * 0.88)

    const laidOut = hydrateLayoutResult(sub, interpretResult(input, {
      id: 'root',
      width: 260,
      height: 100,
      children: [
        { id: '1', x: 10, y: 20, width: 76, height: 52 },
        { id: '2', x: 160, y: 20, width: 92, height: 58 },
      ],
      edges: [],
    }))
    expect(laidOut.edges[0].points[1]).toEqual({ x: 160, y: 20 + 58 * 0.88 })
  })

  it('preserves register connectivity when ELK reorders or omits routed edges', () => {
    const sub: Subgraph = {
      nodes: [
        node(1, 'CARRY4'),
        node(2, 'CARRY4'),
        node(3, 'FDRE', { seq: true, register: true }),
        node(4, 'port', { kind: 'port' }),
      ],
      edges: [
        {
          from: 1,
          to: 3,
          from_port: 'O',
          to_port: 'D',
          net_name: 'd[3:0]',
          bits: [0, 1, 2, 3],
        },
        {
          from: 2,
          to: 3,
          from_port: 'O',
          to_port: 'D',
          net_name: 'd[7:4]',
          bits: [4, 5, 6, 7],
        },
        {
          from: 3,
          to: 4,
          from_port: 'Q',
          to_port: 'q',
          net_name: 'q',
          bits: [0, 1, 2, 3, 4, 5, 6, 7],
        },
      ],
      truncated: false,
    }
    const root = {
      id: 'root',
      width: 500,
      height: 200,
      children: [
        { id: '1', x: 10, y: 20, width: 96, height: 54 },
        { id: '2', x: 10, y: 100, width: 96, height: 54 },
        { id: '3', x: 240, y: 60, width: 100, height: 58 },
        { id: '4', x: 420, y: 72, width: 74, height: 34 },
      ],
      // ELK is allowed to reorder its result and may omit a routed section.
      // e1 is absent here; the adapter must still return the real 2 -> 3 edge.
      edges: [
        {
          id: 'e2',
          sources: ['3#out'],
          targets: ['4#i:q'],
          sections: [
            {
              id: 'e2s0',
              startPoint: { x: 340, y: 89 },
              endPoint: { x: 420, y: 89 },
            },
          ],
        },
        {
          id: 'e0',
          sources: ['1#o:O'],
          targets: ['3#in'],
          sections: [
            {
              id: 'e0s0',
              startPoint: { x: 106, y: 47 },
              endPoint: { x: 240, y: 79 },
            },
          ],
        },
      ],
    }

    const laidOut = hydrateLayoutResult(sub, interpretResult(prepareLayoutInput(sub), root))

    expect(laidOut.edges.map(({ from, to }) => [from, to])).toEqual([
      [1, 3],
      [2, 3],
      [3, 4],
    ])
    expect(laidOut.edges.map(({ edge }) => edge.net_name)).toEqual([
      'd[3:0]',
      'd[7:4]',
      'q',
    ])
    expect(laidOut.edges[1].points).toEqual([
      { x: 106, y: 127 },
      { x: 240, y: 78.56 },
    ])
  })

  it('picks robust placement for large or dense graphs, tight for small', () => {
    const small: Subgraph = {
      nodes: [node(1, '$_AND_'), node(2, '$_AND_')],
      edges: [],
      truncated: false,
    }
    expect(placementForLayout(small)).toBe('NETWORK_SIMPLEX')

    const manyNodes: Subgraph = {
      nodes: Array.from({ length: NETWORK_SIMPLEX_NODE_LIMIT + 1 }, (_, i) =>
        node(i, '$_AND_'),
      ),
      edges: [],
      truncated: false,
    }
    expect(placementForLayout(manyNodes)).toBe('BRANDES_KOEPF')

    const denseEdges: Subgraph = {
      nodes: [node(1, '$_AND_'), node(2, '$_AND_')],
      edges: Array.from({ length: NETWORK_SIMPLEX_EDGE_LIMIT + 1 }, () => ({
        from: 1,
        to: 2,
        from_port: 'Y',
        to_port: 'A',
        net_name: 'n',
        bits: [1],
      })),
      truncated: false,
    }
    expect(placementForLayout(denseEdges)).toBe('BRANDES_KOEPF')
  })

  it('defaults to NETWORK_SIMPLEX but can request the robust placement', () => {
    const sub: Subgraph = { nodes: [node(1, '$_AND_')], edges: [], truncated: false }
    expect(
      toElkGraph(prepareLayoutInput(sub)).layoutOptions?.[
        'elk.layered.nodePlacement.strategy'
      ],
    ).toBe('NETWORK_SIMPLEX')
    expect(
      toElkGraph(prepareLayoutInput(sub), 'BRANDES_KOEPF').layoutOptions?.[
        'elk.layered.nodePlacement.strategy'
      ],
    ).toBe('BRANDES_KOEPF')
    const graph = toElkGraph(prepareLayoutInput(sub))
    expect(graph.layoutOptions).not.toHaveProperty('elk.interactive')
    expect(graph.children?.[0]).not.toHaveProperty('x')
    expect(graph.children?.[0]).not.toHaveProperty('y')
  })

  it('enforces the bounded group-expansion renderer cap before starting ELK', async () => {
    expect(MAX_GROUP_EXPANSION_RENDER_NODES).toBe(4096)
    const oversized: Subgraph = {
      nodes: Array.from({ length: MAX_GROUP_EXPANSION_RENDER_NODES + 1 }, (_, index) =>
        node(index, '$_AND_'),
      ),
      edges: [],
      truncated: true,
    }

    await expect(layoutSubgraph(oversized)).rejects.toThrow('cone too large')
  })

  it('enforces the shared 10000 merged-edge cap before starting ELK', async () => {
    expect(MAX_GRAPH_EDGES).toBe(10_000)
    const edge = {
      from: 1,
      to: 2,
      from_port: 'Y',
      to_port: 'A',
      net_name: 'dense',
      bits: [1],
    }
    const oversized: Subgraph = {
      nodes: [node(1, '$_BUF_'), node(2, '$_BUF_')],
      edges: Array.from({ length: MAX_GRAPH_EDGES + 1 }, () => edge),
      truncated: true,
    }

    await expect(layoutSubgraph(oversized)).rejects.toThrow(
      '10001 merged edges; limit 10000',
    )
  })

  class FakeWorker {
      static instances: FakeWorker[] = []
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: ErrorEvent) => void) | null = null
      terminate = vi.fn()
      requests: Array<{
        id: number
        input: ReturnType<typeof prepareLayoutInput>
        placement: 'NETWORK_SIMPLEX' | 'BRANDES_KOEPF'
      }> = []

      constructor() {
        FakeWorker.instances.push(this)
      }

      postMessage(request: FakeWorker['requests'][number]) {
        this.requests.push(request)
      }
    }

  const workerSubgraph = (id = 1): Subgraph => ({
    nodes: [node(id, '$_AND_', { members: [1, 2], params: { secret: 'resident' } })],
    edges: [],
    truncated: false,
  })

  const geometry = {
    nodes: [{ id: 1, x: 0, y: 0, width: 76, height: 66 }],
    edges: [],
    width: 76,
    height: 66,
  }

  afterEach(() => {
    clearLayoutGeometryCache()
    FakeWorker.instances = []
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('prewarms one worker without posting layout work', () => {
    vi.stubGlobal('Worker', FakeWorker)

    prewarmLayoutWorker()
    prewarmLayoutWorker()

    expect(FakeWorker.instances).toHaveLength(1)
    expect(FakeWorker.instances[0].requests).toEqual([])
    FakeWorker.instances[0].onerror?.({ message: 'cleanup' } as ErrorEvent)
  })

  it('recreates a worker that crashes during otherwise-idle prewarm', async () => {
    vi.stubGlobal('Worker', FakeWorker)

    prewarmLayoutWorker()
    const crashed = FakeWorker.instances[0]
    crashed.onerror?.({ message: 'warmup crashed' } as ErrorEvent)
    expect(crashed.terminate).toHaveBeenCalledOnce()

    const pending = layoutSubgraph(workerSubgraph())
    const replacement = FakeWorker.instances[1]
    expect(replacement.requests).toHaveLength(1)
    replacement.onmessage?.({
      data: { id: replacement.requests[0].id, ok: true, result: geometry },
    } as MessageEvent)
    await expect(pending).resolves.toMatchObject({ width: 76 })
    replacement.onerror?.({ message: 'cleanup' } as ErrorEvent)
  })

  it('sends compact layout input and terminates a superseded worker', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const sub = workerSubgraph()
    const controller = new AbortController()

    const superseded = layoutSubgraph(sub, controller.signal)
    const first = FakeWorker.instances[0]
    expect(first.requests[0]).toEqual({
      id: expect.any(Number),
      input: prepareLayoutInput(sub),
      placement: 'NETWORK_SIMPLEX',
    })
    expect(first.requests[0].input.nodes[0]).not.toHaveProperty('members')
    expect(first.requests[0].input.nodes[0]).not.toHaveProperty('params')
    controller.abort()
    await expect(superseded).rejects.toMatchObject({ name: 'AbortError' })
    expect(first.terminate).toHaveBeenCalledOnce()

    const current = layoutSubgraph(sub)
    const second = FakeWorker.instances[1]
    const request = second.requests[0]
    second.onmessage?.({
      data: { id: request.id, ok: true, result: geometry },
    } as MessageEvent)
    const result = await current
    expect(result.nodes[0].node).toBe(sub.nodes[0])
    expect(FakeWorker.instances).toHaveLength(2)
    second.onerror?.({ message: 'cleanup' } as ErrorEvent)
  })

  it('reuses completed geometry for an equivalent fresh subgraph', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const firstSubgraph: Subgraph = {
      nodes: [node(1, '$_BUF_'), node(2, '$_BUF_')],
      edges: [{
        from: 1,
        to: 2,
        from_port: 'Y',
        to_port: 'A',
        net_name: 'first',
        bits: [1],
      }],
      truncated: false,
    }
    const edgeGeometry = {
      nodes: [
        { id: 1, x: 0, y: 0, width: 62, height: 46 },
        { id: 2, x: 128, y: 0, width: 62, height: 46 },
      ],
      edges: [{ inputIndex: 0, points: [{ x: 62, y: 23 }, { x: 128, y: 23 }] }],
      width: 190,
      height: 46,
    }
    const firstLayout = layoutSubgraph(firstSubgraph)
    const instance = FakeWorker.instances[0]
    instance.onmessage?.({
      data: { id: instance.requests[0].id, ok: true, result: edgeGeometry },
    } as MessageEvent)
    await firstLayout

    const equivalent: Subgraph = structuredClone(firstSubgraph)
    equivalent.nodes[0] = { ...equivalent.nodes[0], src: 'current.sv:9.1-9.2' }
    equivalent.edges[0] = { ...equivalent.edges[0], net_name: 'current' }
    const cached = await layoutSubgraph(equivalent)

    expect(instance.requests).toHaveLength(1)
    expect(cached.nodes[0].node).toBe(equivalent.nodes[0])
    expect(cached.edges[0].edge).toBe(equivalent.edges[0])

    const changedPort: Subgraph = structuredClone(equivalent)
    changedPort.edges[0].to_port = 'B'
    const changedLayout = layoutSubgraph(changedPort)
    expect(instance.requests).toHaveLength(2)
    instance.onmessage?.({
      data: { id: instance.requests[1].id, ok: true, result: edgeGeometry },
    } as MessageEvent)
    await changedLayout
    instance.onerror?.({ message: 'cleanup' } as ErrorEvent)
  })

  it('does not reuse geometry when compact layout input changes', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const firstLayout = layoutSubgraph(workerSubgraph())
    const instance = FakeWorker.instances[0]
    instance.onmessage?.({
      data: { id: instance.requests[0].id, ok: true, result: geometry },
    } as MessageEvent)
    await firstLayout

    const changed = workerSubgraph()
    changed.nodes[0] = node(1, '$_DFF_P_')
    const changedLayout = layoutSubgraph(changed)
    expect(instance.requests).toHaveLength(2)
    expect(instance.requests[1].input.nodes[0].register).toBe(true)
    instance.onmessage?.({
      data: {
        id: instance.requests[1].id,
        ok: true,
        result: geometry,
      },
    } as MessageEvent)
    await expect(changedLayout).resolves.toMatchObject({ width: 76 })
    instance.onerror?.({ message: 'cleanup' } as ErrorEvent)
  })

  it('does not retain one geometry estimate above the byte budget', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const subgraph: Subgraph = {
      nodes: [node(1, '$_BUF_'), node(2, '$_BUF_')],
      edges: [{
        from: 1,
        to: 2,
        from_port: 'Y',
        to_port: 'A',
        net_name: 'wide-route',
        bits: [1],
      }],
      truncated: false,
    }
    const oversizedGeometry = {
      nodes: [
        { id: 1, x: 0, y: 0, width: 62, height: 46 },
        { id: 2, x: 128, y: 0, width: 62, height: 46 },
      ],
      edges: [{
        inputIndex: 0,
        points: Array(Math.ceil(LAYOUT_GEOMETRY_CACHE_MAX_BYTES / 48) + 1)
          .fill({ x: 0, y: 0 }),
      }],
      width: 190,
      height: 46,
    }
    const first = layoutSubgraph(subgraph)
    const instance = FakeWorker.instances[0]
    instance.onmessage?.({
      data: { id: instance.requests[0].id, ok: true, result: oversizedGeometry },
    } as MessageEvent)
    await first

    const repeated = layoutSubgraph(structuredClone(subgraph))
    expect(instance.requests).toHaveLength(2)
    instance.onmessage?.({
      data: {
        id: instance.requests[1].id,
        ok: true,
        result: {
          ...oversizedGeometry,
          edges: [{
            inputIndex: 0,
            points: [{ x: 62, y: 23 }, { x: 128, y: 23 }],
          }],
        },
      },
    } as MessageEvent)
    await expect(repeated).resolves.toMatchObject({ width: 190, height: 46 })
    instance.onerror?.({ message: 'cleanup' } as ErrorEvent)
  })

  it('evicts at the cumulative byte budget before reaching the entry bound', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const pointsPerEntry = Math.ceil(
      (LAYOUT_GEOMETRY_CACHE_MAX_BYTES / LAYOUT_GEOMETRY_CACHE_MAX_ENTRIES + 1) / 48,
    )
    const subgraphFor = (index: number): Subgraph => ({
      nodes: [node(index * 2, '$_BUF_'), node(index * 2 + 1, '$_BUF_')],
      edges: [{
        from: index * 2,
        to: index * 2 + 1,
        from_port: 'Y',
        to_port: 'A',
        net_name: `route-${index}`,
        bits: [index],
      }],
      truncated: false,
    })
    const geometryFor = (index: number, large: boolean) => ({
      nodes: [
        { id: index * 2, x: 0, y: 0, width: 62, height: 46 },
        { id: index * 2 + 1, x: 128, y: 0, width: 62, height: 46 },
      ],
      edges: [{
        inputIndex: 0,
        points: large
          ? Array(pointsPerEntry).fill({ x: 0, y: 0 })
          : [{ x: 62, y: 23 }, { x: 128, y: 23 }],
      }],
      width: 190,
      height: 46,
    })

    for (let index = 1; index <= LAYOUT_GEOMETRY_CACHE_MAX_ENTRIES; index += 1) {
      const pendingLayout = layoutSubgraph(subgraphFor(index))
      const instance = FakeWorker.instances[0]
      const request = instance.requests.at(-1)!
      instance.onmessage?.({
        data: { id: request.id, ok: true, result: geometryFor(index, true) },
      } as MessageEvent)
      await pendingLayout
    }

    const instance = FakeWorker.instances[0]
    expect(instance.requests).toHaveLength(LAYOUT_GEOMETRY_CACHE_MAX_ENTRIES)
    const evicted = layoutSubgraph(subgraphFor(1))
    expect(instance.requests).toHaveLength(LAYOUT_GEOMETRY_CACHE_MAX_ENTRIES + 1)
    const request = instance.requests.at(-1)!
    instance.onmessage?.({
      data: { id: request.id, ok: true, result: geometryFor(1, false) },
    } as MessageEvent)
    await evicted
    instance.onerror?.({ message: 'cleanup' } as ErrorEvent)
  })

  it('keeps cached hits abortable without starting worker work', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const firstLayout = layoutSubgraph(workerSubgraph())
    const instance = FakeWorker.instances[0]
    instance.onmessage?.({
      data: { id: instance.requests[0].id, ok: true, result: geometry },
    } as MessageEvent)
    await firstLayout

    const controller = new AbortController()
    controller.abort()
    await expect(layoutSubgraph(workerSubgraph(), controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(instance.requests).toHaveLength(1)
    instance.onerror?.({ message: 'cleanup' } as ErrorEvent)
  })

  it('promotes hits and evicts least-recently-used geometry at the entry bound', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    for (let id = 1; id <= LAYOUT_GEOMETRY_CACHE_MAX_ENTRIES; id += 1) {
      const pendingLayout = layoutSubgraph(workerSubgraph(id))
      const instance = FakeWorker.instances[0]
      const request = instance.requests.at(-1)!
      instance.onmessage?.({
        data: {
          id: request.id,
          ok: true,
          result: {
            ...geometry,
            nodes: [{ ...geometry.nodes[0], id }],
          },
        },
      } as MessageEvent)
      await pendingLayout
    }

    const instance = FakeWorker.instances[0]
    await layoutSubgraph(workerSubgraph(1))
    expect(instance.requests).toHaveLength(LAYOUT_GEOMETRY_CACHE_MAX_ENTRIES)

    const fifth = layoutSubgraph(workerSubgraph(LAYOUT_GEOMETRY_CACHE_MAX_ENTRIES + 1))
    const request = instance.requests.at(-1)!
    instance.onmessage?.({
      data: {
        id: request.id,
        ok: true,
        result: {
          ...geometry,
          nodes: [{ ...geometry.nodes[0], id: LAYOUT_GEOMETRY_CACHE_MAX_ENTRIES + 1 }],
        },
      },
    } as MessageEvent)
    await fifth

    await layoutSubgraph(workerSubgraph(1))
    expect(instance.requests).toHaveLength(LAYOUT_GEOMETRY_CACHE_MAX_ENTRIES + 1)
    const secondAgain = layoutSubgraph(workerSubgraph(2))
    expect(instance.requests).toHaveLength(LAYOUT_GEOMETRY_CACHE_MAX_ENTRIES + 2)
    const secondRequest = instance.requests.at(-1)!
    instance.onmessage?.({
      data: {
        id: secondRequest.id,
        ok: true,
        result: {
          ...geometry,
          nodes: [{ ...geometry.nodes[0], id: 2 }],
        },
      },
    } as MessageEvent)
    await secondAgain
    instance.onerror?.({ message: 'cleanup' } as ErrorEvent)
  })

  it('retries a failed tight layout with the same compact input', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const sub = workerSubgraph()
    const pendingLayout = layoutSubgraph(sub)
    const instance = FakeWorker.instances[0]
    const first = instance.requests[0]
    instance.onmessage?.({
      data: { id: first.id, ok: false, error: 'stack overflow' },
    } as MessageEvent)
    await vi.waitFor(() => expect(instance.requests).toHaveLength(2))
    const retry = instance.requests[1]
    expect(retry.placement).toBe('BRANDES_KOEPF')
    expect(retry.input).toEqual(first.input)
    instance.onmessage?.({
      data: { id: retry.id, ok: true, result: geometry },
    } as MessageEvent)
    await expect(pendingLayout).resolves.toMatchObject({ width: 76, height: 66 })

    const repeated = layoutSubgraph(workerSubgraph())
    expect(instance.requests).toHaveLength(3)
    expect(instance.requests[2].placement).toBe('NETWORK_SIMPLEX')
    instance.onmessage?.({
      data: { id: instance.requests[2].id, ok: false, error: 'stack overflow' },
    } as MessageEvent)
    await expect(repeated).resolves.toMatchObject({ width: 76, height: 66 })
    expect(instance.requests).toHaveLength(3)
    instance.onerror?.({ message: 'cleanup' } as ErrorEvent)
  })

  it('recovers from a worker crash using a fresh worker', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const pendingLayout = layoutSubgraph(workerSubgraph())
    const first = FakeWorker.instances[0]
    first.onerror?.({ message: 'worker crashed' } as ErrorEvent)
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(2))
    const replacement = FakeWorker.instances[1]
    expect(replacement.requests[0].placement).toBe('BRANDES_KOEPF')
    replacement.onmessage?.({
      data: { id: replacement.requests[0].id, ok: true, result: geometry },
    } as MessageEvent)
    await expect(pendingLayout).resolves.toMatchObject({ width: 76 })
    replacement.onerror?.({ message: 'cleanup' } as ErrorEvent)
  })

  it('reuses the warm worker after an independent successful layout', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const firstLayout = layoutSubgraph(workerSubgraph())
    const instance = FakeWorker.instances[0]
    instance.onmessage?.({
      data: { id: instance.requests[0].id, ok: true, result: geometry },
    } as MessageEvent)
    await firstLayout

    const secondLayout = layoutSubgraph(workerSubgraph(2))
    expect(FakeWorker.instances).toHaveLength(1)
    expect(instance.requests).toHaveLength(2)
    instance.onmessage?.({
      data: {
        id: instance.requests[1].id,
        ok: true,
        result: {
          ...geometry,
          nodes: [{ ...geometry.nodes[0], id: 2 }],
        },
      },
    } as MessageEvent)
    await secondLayout
    instance.onerror?.({ message: 'cleanup' } as ErrorEvent)
  })

  it('times out without retrying and lets the next layout use a fresh worker', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('Worker', FakeWorker)
    const timedOut = layoutSubgraph(workerSubgraph())
    const first = FakeWorker.instances[0]
    const timeoutExpectation = expect(timedOut).rejects.toMatchObject({
      name: 'LayoutTimeoutError',
    })
    await vi.advanceTimersByTimeAsync(10_000)
    await timeoutExpectation
    expect(first.requests).toHaveLength(1)
    expect(first.terminate).toHaveBeenCalledOnce()

    const current = layoutSubgraph(workerSubgraph())
    const replacement = FakeWorker.instances[1]
    replacement.onmessage?.({
      data: { id: replacement.requests[0].id, ok: true, result: geometry },
    } as MessageEvent)
    await expect(current).resolves.toMatchObject({ width: 76 })
    replacement.onerror?.({ message: 'cleanup' } as ErrorEvent)
  })

  it('rejects every pending request when the shared worker times out', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('Worker', FakeWorker)
    const firstLayout = layoutSubgraph(workerSubgraph())
    const secondLayout = layoutSubgraph(workerSubgraph())
    const firstExpectation = expect(firstLayout).rejects.toMatchObject({
      name: 'LayoutTimeoutError',
    })
    const secondExpectation = expect(secondLayout).rejects.toMatchObject({
      name: 'LayoutTimeoutError',
    })
    const instance = FakeWorker.instances[0]
    expect(instance.requests).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(10_000)
    await Promise.all([firstExpectation, secondExpectation])
    expect(instance.terminate).toHaveBeenCalledOnce()

    const replacementLayout = layoutSubgraph(workerSubgraph())
    const replacement = FakeWorker.instances[1]
    replacement.onmessage?.({
      data: { id: replacement.requests[0].id, ok: true, result: geometry },
    } as MessageEvent)
    await replacementLayout
    replacement.onerror?.({ message: 'cleanup' } as ErrorEvent)
  })
})

describe('viewport transforms', () => {
  it('refits centered graph content when the containing pane changes size', () => {
    expect(fitViewportToContent(1000, 600, 800, 400)).toEqual({
      x: 20,
      y: 60,
      k: 1.2,
    })
    expect(fitViewportToContent(600, 400, 800, 400)).toEqual({
      x: 20,
      y: 60,
      k: 0.7,
    })
  })

  it('fits graph content inside overlay-safe viewport insets', () => {
    expect(
      fitViewportToContent(1000, 600, 800, 400, 40, 1.5, {
        top: 40,
        right: 280,
        bottom: 30,
        left: 0,
      }),
    ).toEqual({
      x: 20,
      y: 135,
      k: 0.85,
    })
  })

  it('ignores transient hidden-pane measurements instead of corrupting the transform', () => {
    expect(fitViewportToContent(0, 0, 800, 400)).toBeNull()
    expect(fitViewportToContent(1000, 0, 800, 400)).toBeNull()
    expect(fitViewportToContent(Number.NaN, 600, 800, 400)).toBeNull()
  })

  it('pans without changing scale and emits the SVG transform', () => {
    const moved = panViewport({ x: 10, y: 20, k: 2 }, 5, -7)
    expect(moved).toEqual({ x: 15, y: 13, k: 2 })
    expect(viewportTransformAttribute(moved)).toBe('translate(15,13) scale(2)')
  })

  it('preserves a retained anchor on screen without changing zoom', () => {
    const graphNode = node(1, '$_AND_')
    const previous = {
      nodes: [{ id: 1, x: 20, y: 30, width: 80, height: 50, node: graphNode }],
      edges: [],
      width: 100,
      height: 80,
    }
    const next = {
      ...previous,
      nodes: [{ ...previous.nodes[0], x: 120, y: 70 }],
    }

    expect(
      preserveViewportAnchor({ x: 10, y: 15, k: 2 }, previous, next, [1]),
    ).toEqual({ x: -190, y: -65, k: 2 })
  })

  it('refits only when a projection has no retained node to anchor', () => {
    const graphNode = node(1, '$_AND_')
    const previous = {
      nodes: [{ id: 1, x: 20, y: 30, width: 80, height: 50, node: graphNode }],
      edges: [],
      width: 100,
      height: 80,
    }
    const shared = {
      ...previous,
      nodes: [{ ...previous.nodes[0], x: 120 }],
    }
    const disjoint = {
      ...previous,
      nodes: [
        {
          ...previous.nodes[0],
          id: 2,
          node: node(2, '$_OR_'),
        },
      ],
    }

    expect(shouldRefitProjection(previous, shared, true, true)).toBe(false)
    expect(shouldRefitProjection(previous, shared, true, false)).toBe(false)
    expect(shouldRefitProjection(previous, disjoint, true, false)).toBe(true)
    expect(shouldRefitProjection(previous, shared, false, false)).toBe(true)
  })

  it('zooms around a fixed screen-space anchor and clamps scale', () => {
    const previous = { x: 10, y: 20, k: 1 }
    const zoomed = zoomViewportAt(previous, 110, 70, 2)
    expect(zoomed).toEqual({ x: -90, y: -30, k: 2 })
    expect((110 - zoomed.x) / zoomed.k).toBe((110 - previous.x) / previous.k)
    expect((70 - zoomed.y) / zoomed.k).toBe((70 - previous.y) / previous.k)
    expect(zoomViewportAt(previous, 0, 0, 100).k).toBe(4)
    expect(zoomViewportAt(previous, 0, 0, 0.001).k).toBe(0.08)
  })
})
