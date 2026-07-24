import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GraphNode, Subgraph } from '../types'
import type { SchemWeaveWorkerRequest } from '../workers/schemweaveProtocol'
import {
  MAX_GRAPH_EDGES,
  MAX_GROUP_EXPANSION_RENDER_NODES,
} from './graphLimits'
import {
  buildSchemWeaveCollapseRequest,
  buildSchemWeaveExpansionRequest,
  buildSchemWeaveLayoutRequest,
  clearLayoutGeometryCache,
  comparisonLayoutEngine,
  configureLayoutWorkerFactory,
  controlRoleForPin,
  DENSE_LAYOUT_NODE_THRESHOLD,
  DENSE_LONGEST_PATH_EDGE_DENSITY,
  fitViewportToContent,
  hydrateLayoutResult,
  interpretSchemWeaveResult,
  interpretResult,
  LAYOUT_GEOMETRY_CACHE_MAX_BYTES,
  LAYOUT_GEOMETRY_CACHE_MAX_ENTRIES,
  layoutCollapsedGroupWithSchemWeave,
  layoutExpandedGroupWithSchemWeave,
  MAX_GLOBAL_LAYOUT_COMPONENTS,
  layoutSubgraph,
  NETWORK_SIMPLEX_EDGE_LIMIT,
  NETWORK_SIMPLEX_NODE_LIMIT,
  nodeDimensions,
  panViewport,
  placementForLayout,
  prewarmLayoutWorker,
  preserveViewportAnchor,
  prepareLayoutInput,
  REDUCED_THOROUGHNESS_EDGE_DENSITY,
  REDUCED_THOROUGHNESS_NODE_THRESHOLD,
  shouldRefitProjection,
  toElkGraph,
  toSchemWeaveLayoutRequest,
  type LayoutInput,
  type SchemWeaveLayout,
  type SchemWeaveSnapshot,
  viewportTransformAttribute,
  zoomViewportAt,
} from './layout'

it('preserves compact trunk ids while expanding electrical boundary edges', () => {
  const layoutNode = (
    id: number,
    boundary: LayoutInput['nodes'][number]['boundary'] = 'internal',
  ): LayoutInput['nodes'][number] => ({
    id,
    baseWidth: 80,
    baseHeight: 50,
    controlHeight: 0,
    register: false,
    boundary,
  })
  const layoutEdge = (
    from: number,
    to: number,
    net: number,
  ): LayoutInput['edges'][number] => ({
    from,
    to,
    fromPort: 'Y',
    toPort: 'A',
    control: false,
    net,
  })
  const compactInput: LayoutInput = {
    nodes: [
      layoutNode(1, 'input'),
      layoutNode(100),
      layoutNode(2, 'output'),
    ],
    edges: [
      layoutEdge(1, 100, 7),
      layoutEdge(100, 2, 8),
    ],
  }
  const compact = buildSchemWeaveLayoutRequest(compactInput)
  const compactSnapshot: SchemWeaveSnapshot = {
    request: compact.request,
    catalog: compact.catalog,
    layout: {
      nodes: [
        { id: 1, x: 0, y: 0, width: 80, height: 50 },
        { id: 100, x: 146, y: 0, width: 80, height: 50 },
        { id: 2, x: 292, y: 0, width: 80, height: 50 },
      ],
      edges: [
        { id: 0, points: [{ x: 80, y: 25 }, { x: 146, y: 25 }] },
        { id: 1, points: [{ x: 226, y: 25 }, { x: 292, y: 25 }] },
      ],
      width: 372,
      height: 50,
    },
  }
  const expandedInput: LayoutInput = {
    nodes: [
      layoutNode(1, 'input'),
      layoutNode(10),
      layoutNode(11),
      layoutNode(2, 'output'),
    ],
    edges: [
      layoutEdge(1, 10, 7),
      layoutEdge(1, 11, 7),
      layoutEdge(10, 2, 8),
      layoutEdge(11, 2, 8),
    ],
  }

  const expanded = buildSchemWeaveExpansionRequest(
    compactSnapshot,
    expandedInput,
    { id: 100, members: [10, 11], referenceHeight: 50 },
  )

  expect(expanded.request.expanded_graph.edges.map((edge) => edge.id)).toEqual([
    0, 1, 2, 3,
  ])
  expect(expanded.request.expansion.boundary_trunks).toEqual([
    { expanded_edge: 0, compact_edge: 0 },
    { expanded_edge: 1, compact_edge: 1 },
    { expanded_edge: 2, compact_edge: 0 },
    { expanded_edge: 3, compact_edge: 1 },
  ])
  expect(expanded.request.reference_height).toBe(50)
  expect(expanded.catalog.fragments).toHaveLength(4)
  expect(expanded.expandedRequest.graph).toEqual(
    expanded.request.expanded_graph,
  )
  expect(expanded.expandedRequest.constraints).toEqual(
    expanded.request.constraints,
  )

  const legacyExpanded = buildSchemWeaveExpansionRequest(
    compactSnapshot,
    expandedInput,
    { id: 100, members: [10, 11] },
  )
  expect(legacyExpanded.request.reference_height).toBe(
    compactSnapshot.layout.height,
  )

  const expandedSnapshot: SchemWeaveSnapshot = {
    request: expanded.expandedRequest,
    catalog: expanded.catalog,
    layout: {
      nodes: expanded.request.expanded_graph.nodes.map((node, index) => ({
        id: node.id,
        x: index * 100,
        y: 0,
        width: node.width,
        height: node.height,
      })),
      edges: expanded.request.expanded_graph.edges.map((edge) => ({
        id: edge.id,
        points: [],
      })),
      width: 400,
      height: 50,
    },
  }
  const collapsed = buildSchemWeaveCollapseRequest(
    expandedSnapshot,
    expandedInput,
    compactInput,
    { id: 100, members: [10, 11], referenceHeight: 50 },
  )
  expect(collapsed.request.expanded_graph).toEqual(
    expanded.request.expanded_graph,
  )
  expect(collapsed.request.compact_graph).toEqual(compact.request.graph)
  expect(collapsed.request.expansion).toEqual(expanded.request.expansion)
  expect(collapsed.compactRequest).toEqual(compact.request)
})

it('reconstructs inverse collapse after another group remains expanded', () => {
  const makeNode = (
    id: number,
    boundary: LayoutInput['nodes'][number]['boundary'] = 'internal',
  ): LayoutInput['nodes'][number] => ({
    id,
    baseWidth: 80,
    baseHeight: 50,
    controlHeight: 0,
    register: false,
    boundary,
  })
  const makeEdge = (
    from: number,
    to: number,
    net: number,
  ): LayoutInput['edges'][number] => ({
    from,
    to,
    fromPort: 'Y',
    toPort: 'A',
    control: false,
    net,
  })
  const layoutFor = (
    request: ReturnType<typeof buildSchemWeaveLayoutRequest>,
  ): SchemWeaveSnapshot => ({
    request: request.request,
    catalog: request.catalog,
    layout: {
      nodes: request.request.graph.nodes.map((node, index) => ({
        id: node.id,
        x: index * 100,
        y: 0,
        width: node.width,
        height: node.height,
      })),
      edges: request.request.graph.edges.map((edge) => ({
        id: edge.id,
        points: [],
      })),
      width: request.request.graph.nodes.length * 100,
      height: 50,
    },
  })
  const baseInput: LayoutInput = {
    nodes: [makeNode(1, 'input'), makeNode(100), makeNode(200), makeNode(2, 'output')],
    edges: [makeEdge(1, 100, 1), makeEdge(100, 200, 2), makeEdge(200, 2, 3)],
  }
  const firstInput: LayoutInput = {
    nodes: [
      makeNode(1, 'input'),
      makeNode(10),
      makeNode(11),
      makeNode(200),
      makeNode(2, 'output'),
    ],
    edges: [
      makeEdge(1, 10, 1),
      makeEdge(1, 11, 1),
      makeEdge(10, 200, 2),
      makeEdge(11, 200, 2),
      makeEdge(200, 2, 3),
    ],
  }
  const secondInput: LayoutInput = {
    nodes: [
      makeNode(1, 'input'),
      makeNode(10),
      makeNode(11),
      makeNode(20),
      makeNode(21),
      makeNode(2, 'output'),
    ],
    edges: [
      makeEdge(1, 10, 1),
      makeEdge(1, 11, 1),
      makeEdge(10, 20, 2),
      makeEdge(10, 21, 2),
      makeEdge(11, 20, 2),
      makeEdge(11, 21, 2),
      makeEdge(20, 2, 3),
      makeEdge(21, 2, 3),
    ],
  }
  const targetInput: LayoutInput = {
    nodes: [
      makeNode(1, 'input'),
      makeNode(100),
      makeNode(20),
      makeNode(21),
      makeNode(2, 'output'),
    ],
    edges: [
      makeEdge(1, 100, 1),
      makeEdge(100, 20, 2),
      makeEdge(100, 21, 2),
      makeEdge(20, 2, 3),
      makeEdge(21, 2, 3),
    ],
  }
  const base = layoutFor(buildSchemWeaveLayoutRequest(baseInput))
  const first = buildSchemWeaveExpansionRequest(
    base,
    firstInput,
    { id: 100, members: [10, 11] },
  )
  const firstSnapshot = layoutFor({
    request: first.expandedRequest,
    catalog: first.catalog,
  })
  const second = buildSchemWeaveExpansionRequest(
    firstSnapshot,
    secondInput,
    { id: 200, members: [20, 21] },
  )
  const secondSnapshot = layoutFor({
    request: second.expandedRequest,
    catalog: second.catalog,
  })
  secondSnapshot.layout.edges = secondSnapshot.layout.edges.map((edge) => ({
    ...edge,
    points: [
      { x: edge.id, y: edge.id + 0.25 },
      { x: edge.id + 0.5, y: edge.id + 0.75 },
    ],
  }))
  const bundledEdge = second.expandedRequest.graph.edges[0]
  secondSnapshot.layout.boundary_bundles = [{
    id: 0,
    endpoint: bundledEdge.source,
    role: 'input',
    width: 1,
    collector: {
      start: { x: 10, y: 11 },
      end: { x: 10, y: 12 },
    },
    spine: {
      start: { x: 8, y: 11 },
      end: { x: 10, y: 11 },
    },
    members: [{
      edge: bundledEdge.id,
      slots: [0],
      tap: { x: 10, y: 11 },
    }],
  }]

  const collapsed = buildSchemWeaveCollapseRequest(
    secondSnapshot,
    secondInput,
    targetInput,
    { id: 100, members: [10, 11] },
  )
  expect(collapsed.request.expanded_graph.nodes.map((node) => node.id)).toEqual(
    second.expandedRequest.graph.nodes.map((node) => node.id),
  )
  expect(
    collapsed.request.expanded_layout.edges.map((edge) => edge.id),
  ).toEqual(
    collapsed.request.expanded_graph.edges.map((edge) => edge.id),
  )
  expect(
    collapsed.request.compact_graph.nodes.map((node) => node.id).sort(
      (left, right) => left - right,
    ),
  ).toEqual(
    targetInput.nodes.map((node) => node.id).sort(
      (left, right) => left - right,
    ),
  )
  for (const edge of collapsed.request.expanded_layout.edges) {
    const oldId = edge.points[0].x
    const oldEdge = second.expandedRequest.graph.edges[oldId]
    const remapped = collapsed.request.expanded_graph.edges[edge.id]
    expect([remapped.source.node, remapped.target.node]).toEqual([
      oldEdge.source.node,
      oldEdge.target.node,
    ])
  }
  const remappedBundle =
    collapsed.request.expanded_layout.boundary_bundles?.[0]
  expect(remappedBundle).toBeDefined()
  const remappedBundleEdge = collapsed.request.expanded_layout.edges.find(
    (edge) => edge.id === remappedBundle!.members[0].edge,
  )
  expect(remappedBundleEdge?.points[0].x).toBe(bundledEdge.id)
  expect(remappedBundle?.endpoint).toEqual(
    collapsed.request.expanded_graph.edges[
      remappedBundle!.members[0].edge
    ].source,
  )
  expect(remappedBundle?.members[0].tap).toEqual({ x: 10, y: 11 })
})

const node = (id: number, cellType: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  id,
  kind: 'cell',
  name: `u${id}`,
  cell_type: cellType,
  ...extra,
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

  it('models an expanded quotient group as one compound ELK child', () => {
    const sub: Subgraph = {
      nodes: [
        node(1, 'RAM32M'),
        node(2, 'RAM32M'),
        node(3, '$_AND_'),
      ],
      edges: [{
        from: 1,
        to: 2,
        from_port: 'Y',
        to_port: 'D',
        net_name: 'member-link',
        bits: [1],
      }],
      truncated: false,
    }
    const input = prepareLayoutInput(sub, [{
      id: 100,
      members: [1, 2],
      referenceHeight: 1_000,
    }])
    const graph = toElkGraph(input)
    const compound = graph.children?.find((child) => child.id === 'group:100')

    expect(graph.layoutOptions?.['elk.hierarchyHandling']).toBe('INCLUDE_CHILDREN')
    expect(graph.children?.map((child) => child.id).sort()).toEqual([
      '3',
      'group:100',
    ])
    expect(compound?.children?.map((child) => child.id)).toEqual(['1', '2'])
    expect(compound?.edges).toEqual([])
    expect(compound?.children?.map((child) =>
      child.layoutOptions?.['elk.layered.layering.layerConstraint']
    )).toEqual(['FIRST', 'FIRST'])
    expect(compound?.ports?.map((port) => port.id)).toEqual([
      'group:100#in',
      'group:100#out',
    ])
    expect(graph.edges).toEqual([])
    expect(compound?.layoutOptions?.['elk.direction']).toBe('RIGHT')
  })

  it('switches an expanded group to a clean grid beyond 1.5x the reference height', () => {
    const sub: Subgraph = {
      nodes: [
        node(1, 'RAM32M'),
        node(2, 'RAM32M'),
        node(3, 'RAM32M'),
        node(4, 'RAM32M'),
      ],
      edges: [],
      truncated: false,
    }
    const input = prepareLayoutInput(sub, [{
      id: 100,
      members: [1, 2, 3, 4],
      referenceHeight: 100,
    }])
    const compound = toElkGraph(input).children?.find(
      (child) => child.id === 'group:100',
    )

    expect(compound?.children?.every((child) =>
      child.layoutOptions?.['elk.layered.layering.layerConstraint'] == null
    )).toBe(true)
    expect(compound?.edges?.map((edge) => ({
      sources: edge.sources,
      targets: edge.targets,
    }))).toEqual([
      { sources: ['1'], targets: ['2'] },
      { sources: ['3'], targets: ['4'] },
    ])
  })

  it('uses a vertical column at the exact 1.5x limit and a grid just beyond it', () => {
    const sub: Subgraph = {
      nodes: [node(1, 'RAM32M'), node(2, 'RAM32M'), node(3, 'RAM32M')],
      edges: [],
      truncated: false,
    }
    const probe = toElkGraph(prepareLayoutInput(sub, [{
      id: 100,
      members: [1, 2, 3],
      referenceHeight: 1_000,
    }])).children?.find((child) => child.id === 'group:100')
    const exactReferenceHeight = (probe?.height ?? 0) / 1.5
    const atLimit = toElkGraph(prepareLayoutInput(sub, [{
      id: 100,
      members: [1, 2, 3],
      referenceHeight: exactReferenceHeight,
    }])).children?.find((child) => child.id === 'group:100')
    const overLimit = toElkGraph(prepareLayoutInput(sub, [{
      id: 100,
      members: [1, 2, 3],
      referenceHeight: exactReferenceHeight - 0.001,
    }])).children?.find((child) => child.id === 'group:100')

    expect(atLimit?.children?.every((child) =>
      child.layoutOptions?.['elk.layered.layering.layerConstraint'] === 'FIRST'
    )).toBe(true)
    expect(overLimit?.children?.every((child) =>
      child.layoutOptions?.['elk.layered.layering.layerConstraint'] == null
    )).toBe(true)
  })

  it('flattens compound member coordinates and retains its frame geometry', () => {
    const sub: Subgraph = {
      nodes: [node(1, 'RAM32M'), node(2, 'RAM32M')],
      edges: [],
      truncated: false,
    }
    const input = prepareLayoutInput(sub, [{ id: 100, members: [1, 2] }])
    const geometry = interpretResult(input, {
      id: 'root',
      width: 260,
      height: 160,
      children: [{
        id: 'group:100',
        x: 70,
        y: 40,
        width: 170,
        height: 100,
        children: [
          { id: '1', x: 16, y: 30, width: 60, height: 40 },
          { id: '2', x: 94, y: 30, width: 60, height: 40 },
        ],
      }],
    })

    expect(geometry.nodes.map(({ id, x, y }) => ({ id, x, y }))).toEqual([
      { id: 1, x: 86, y: 70 },
      { id: 2, x: 164, y: 128 },
    ])
    expect(geometry.groups).toEqual([
      { id: 100, x: 70, y: 40, width: 170, height: 100 },
    ])
  })

  it('orders vertical members canonically and reconnects proxy routes to member pins', () => {
    const sub: Subgraph = {
      nodes: [
        node(10, 'port', {
          kind: 'port',
          name: 'source',
          port_direction: 'input',
        }),
        node(1, 'FDRE'),
        node(2, 'FDRE'),
        node(11, 'port', {
          kind: 'port',
          name: 'sink',
          port_direction: 'output',
        }),
        node(12, 'port', {
          kind: 'port',
          name: 'clk',
          port_direction: 'input',
        }),
      ],
      edges: [
        {
          from: 10,
          to: 1,
          from_port: 'Y',
          to_port: 'D',
          net_name: 'incoming',
          bits: [1],
        },
        {
          from: 1,
          to: 2,
          from_port: 'Q',
          to_port: 'D',
          net_name: 'internal',
          bits: [2],
        },
        {
          from: 2,
          to: 11,
          from_port: 'Q',
          to_port: 'A',
          net_name: 'outgoing',
          bits: [3],
        },
        {
          from: 12,
          to: 1,
          from_port: 'Y',
          to_port: 'C',
          net_name: 'clk',
          bits: [4],
          control: true,
        },
      ],
      truncated: false,
    }
    const input = prepareLayoutInput(sub, [{
      id: 100,
      members: [1, 2],
      referenceHeight: 1_000,
    }])
    const geometry = interpretResult(input, {
      id: 'root',
      width: 440,
      height: 380,
      children: [
        { id: '10', x: 10, y: 140, width: 62, height: 46 },
        {
          id: 'group:100',
          x: 100,
          y: 40,
          width: 150,
          height: 300,
          children: [
            { id: '1', x: 16, y: 180, width: 110, height: 84 },
            { id: '2', x: 16, y: 30, width: 110, height: 84 },
          ],
        },
        { id: '11', x: 350, y: 140, width: 62, height: 46 },
        { id: '12', x: 10, y: 240, width: 62, height: 46 },
      ],
      edges: [
        {
          id: 'e0',
          sources: ['10'],
          targets: ['group:100#in'],
          sections: [{
            id: 'e0s0',
            startPoint: { x: 72, y: 163 },
            endPoint: { x: 100, y: 190 },
          }],
        },
        {
          id: 'e2',
          sources: ['group:100#out'],
          targets: ['11'],
          sections: [{
            id: 'e2s0',
            startPoint: { x: 250, y: 190 },
            endPoint: { x: 350, y: 163 },
          }],
        },
        {
          id: 'e3',
          sources: ['12'],
          targets: ['group:100#in'],
          sections: [{
            id: 'e3s0',
            startPoint: { x: 72, y: 263 },
            endPoint: { x: 100, y: 190 },
          }],
        },
      ],
    })
    const byId = new Map(geometry.nodes.map((laidOut) => [laidOut.id, laidOut]))
    const first = byId.get(1)!
    const second = byId.get(2)!

    expect(first.y).toBeLessThan(second.y)
    expect(geometry.edges[0].points.at(-1)?.x).toBe(first.x)
    expect(geometry.edges[2].points[0].x).toBe(second.x + second.width)
    expect(geometry.edges[3].points.at(-1)?.x).toBe(first.x)
    expect(geometry.edges[3].points.at(-1)?.y)
      .not.toBe(geometry.edges[0].points.at(-1)?.y)
    expect(Math.max(...geometry.edges[1].points.map((point) => point.x)))
      .toBeLessThanOrEqual(242)
  })

  it('repacks heterogeneous vertical members without overlap after ordering', () => {
    const sub: Subgraph = {
      nodes: [node(1, 'RAM32M'), node(2, 'FDRE')],
      edges: [],
      truncated: false,
    }
    const input = prepareLayoutInput(sub, [{
      id: 100,
      members: [1, 2],
      referenceHeight: 1_000,
    }])
    const geometry = interpretResult(input, {
      id: 'root',
      width: 220,
      height: 260,
      children: [{
        id: 'group:100',
        x: 40,
        y: 20,
        width: 150,
        height: 220,
        children: [
          { id: '1', x: 16, y: 90, width: 110, height: 100 },
          { id: '2', x: 16, y: 30, width: 110, height: 20 },
        ],
      }],
    })
    const byId = new Map(geometry.nodes.map((laidOut) => [laidOut.id, laidOut]))
    const first = byId.get(1)!
    const second = byId.get(2)!

    expect(second.y).toBeGreaterThanOrEqual(
      first.y + first.height + 18,
    )
  })

  it('routes grid proxy legs through column corridors instead of sibling nodes', () => {
    const sub: Subgraph = {
      nodes: [
        node(10, 'port', {
          kind: 'port',
          name: 'source',
          port_direction: 'input',
        }),
        node(1, 'RAM32M'),
        node(2, 'RAM32M'),
        node(3, 'RAM32M'),
        node(4, 'RAM32M'),
      ],
      edges: [{
        from: 10,
        to: 2,
        from_port: 'Y',
        to_port: 'D',
        net_name: 'incoming',
        bits: [1],
      }],
      truncated: false,
    }
    const input = prepareLayoutInput(sub, [{
      id: 100,
      members: [1, 2, 3, 4],
      referenceHeight: 100,
    }])
    const geometry = interpretResult(input, {
      id: 'root',
      width: 480,
      height: 300,
      children: [
        { id: '10', x: 10, y: 130, width: 62, height: 46 },
        {
          id: 'group:100',
          x: 100,
          y: 40,
          width: 320,
          height: 220,
          children: [
            { id: '1', x: 20, y: 30, width: 110, height: 70 },
            { id: '2', x: 178, y: 30, width: 110, height: 70 },
            { id: '3', x: 20, y: 118, width: 110, height: 70 },
            { id: '4', x: 178, y: 118, width: 110, height: 70 },
          ],
        },
      ],
      edges: [{
        id: 'e0',
        sources: ['10'],
        targets: ['group:100#in'],
        sections: [{
          id: 'e0s0',
          startPoint: { x: 72, y: 153 },
          endPoint: { x: 100, y: 150 },
        }],
      }],
    })
    const sibling = geometry.nodes.find((laidOut) => laidOut.id === 1)!
    const route = geometry.edges[0].points
    const crossesSibling = route.slice(1).some((point, index) => {
      const previous = route[index]
      return (
        Math.max(previous.x, point.x) > sibling.x &&
        Math.min(previous.x, point.x) < sibling.x + sibling.width &&
        Math.max(previous.y, point.y) > sibling.y &&
        Math.min(previous.y, point.y) < sibling.y + sibling.height
      )
    })

    expect(crossesSibling).toBe(false)
    expect(route.at(-1)?.x).toBe(
      geometry.nodes.find((laidOut) => laidOut.id === 2)?.x,
    )
  })

  it('routes dense compound fanout through proxy ports without dropping edges', () => {
    const members = Array.from(
      { length: DENSE_LAYOUT_NODE_THRESHOLD + 20 },
      (_, index) => node(index + 1, 'FDRE'),
    )
    const source = node(1000, 'port', { kind: 'port' })
    const sub: Subgraph = {
      nodes: [source, ...members],
      edges: members.map((member, index) => ({
        from: source.id,
        to: member.id,
        from_port: 'data',
        to_port: 'D',
        net_name: 'data',
        bits: [index],
      })),
      truncated: false,
    }
    const input = prepareLayoutInput(sub, [{
      id: 2000,
      members: members.map((member) => member.id),
    }])
    const graph = toElkGraph(input, 'BRANDES_KOEPF')
    const compound = graph.children?.find((child) => child.id === 'group:2000')

    expect(graph.edges).toHaveLength(members.length)
    expect(new Set(graph.edges?.flatMap((edge) => edge.targets))).toEqual(
      new Set(['group:2000#in']),
    )
    expect(input.edges).toHaveLength(members.length)
    expect(compound?.layoutOptions?.['elk.direction']).toBe('RIGHT')
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

  it('preserves and canonically normalizes grouped boundary bundle metadata', () => {
    const sub: Subgraph = {
      nodes: [
        node(1, 'port', {
          kind: 'port',
          name: 'a[7:0]',
          port_direction: 'input',
          boundary_members: [
            { member: 12, bit: 7 },
            { member: 10, bit: 0 },
            { member: 12, bit: 7 },
          ],
        }),
        node(2, 'port', {
          kind: 'port',
          name: 'y[7:0]',
          port_direction: 'output',
          boundary_members: [
            { member: 22, bit: 7 },
            { member: 20, bit: 0 },
          ],
        }),
      ],
      edges: [{
        from: 1,
        to: 2,
        from_port: 'a',
        to_port: 'A',
        net_name: 'a',
        bits: [100, 107],
        source_boundary_members: [
          { member: 12, net_bits: [107, 106] },
          { member: 10, net_bits: [101, 100] },
          { member: 12, net_bits: [106] },
        ],
        target_boundary_members: [
          { member: 22, net_bits: [107, 106] },
          { member: 20, net_bits: [101, 100] },
        ],
      }],
      truncated: true,
    }

    const input = prepareLayoutInput(sub)
    expect(input.nodes[0].boundaryMembers).toEqual([
      { member: 10, bit: 0 },
      { member: 12, bit: 7 },
    ])
    expect(input.edges[0].sourceBoundaryMembers).toEqual([
      { member: 10, net_bits: [100, 101] },
      { member: 12, net_bits: [106, 107] },
    ])
    expect(input.edges[0].targetBoundaryMembers).toEqual([
      { member: 20, net_bits: [100, 101] },
      { member: 22, net_bits: [106, 107] },
    ])
  })

  it('maps a 32-bit priority output slab to deterministic bundle slots', () => {
    const outputMembers = Array.from({ length: 32 }, (_, bit) => ({
      member: 1_000 + bit,
      bit,
    }))
    const sub: Subgraph = {
      nodes: [
        ...Array.from({ length: 32 }, (_, bit) =>
          node(bit, '$_BUF_')),
        node(100, 'port', {
          kind: 'port',
          name: 'one_hot[31:0]',
          port_direction: 'output',
          width: 32,
          member_count: 32,
          members: outputMembers.map((member) => member.member),
          boundary_members: outputMembers,
        }),
      ],
      edges: Array.from({ length: 32 }, (_, bit) => ({
        from: bit,
        to: 100,
        from_port: 'Y',
        to_port: 'one_hot',
        net_name: `one_hot[${bit}]`,
        bits: [2_000 + bit],
        target_boundary_members: [{
          member: 1_000 + bit,
          net_bits: [2_000 + bit],
        }],
      })),
      truncated: false,
    }

    const request = toSchemWeaveLayoutRequest(prepareLayoutInput(sub))
    expect(request.constraints.boundary_bundles).toEqual([{
      id: 0,
      endpoint: { node: 100, port: 0 },
      width: 32,
      members: Array.from({ length: 32 }, (_, bit) => ({
        edge: bit,
        slots: [bit],
      })),
    }])
  })

  it('assigns one electrical net to same-net input fanout cohorts', () => {
    const sub: Subgraph = {
      nodes: [
        node(1, 'port', {
          kind: 'port',
          name: 'request',
          port_direction: 'input',
          width: 1,
          member_count: 1,
          members: [10],
          boundary_members: [{ member: 10, bit: 0 }],
        }),
        node(2, '$_BUF_'),
        node(3, '$_BUF_'),
      ],
      edges: [2, 3].map((to) => ({
        from: 1,
        to,
        from_port: 'request',
        to_port: 'A',
        net_name: 'request',
        // Quotient edge payloads can differ even when exact boundary metadata
        // identifies one electrical net fanout cohort.
        bits: [100 + to],
        source_boundary_members: [{ member: 10, net_bits: [55] }],
      })),
      truncated: false,
    }

    const request = toSchemWeaveLayoutRequest(prepareLayoutInput(sub))
    expect(request.graph.edges.map((edge) => edge.net)).toEqual([0, 0])
    expect(request.constraints.boundary_bundles).toEqual([{
      id: 0,
      endpoint: { node: 1, port: 0 },
      width: 1,
      members: [
        { edge: 0, slots: [0] },
        { edge: 1, slots: [0] },
      ],
    }])
  })

  it('supports sparse multi-slot direct aliases on both boundaries', () => {
    const sub: Subgraph = {
      nodes: [
        node(1, 'port', {
          kind: 'port',
          name: 'a[7:0]',
          port_direction: 'input',
          width: 2,
          member_count: 8,
          members: [10, 17],
          boundary_members: [
            { member: 10, bit: 0 },
            { member: 17, bit: 7 },
          ],
        }),
        node(2, 'port', {
          kind: 'port',
          name: 'y[7:0]',
          port_direction: 'output',
          width: 2,
          member_count: 8,
          members: [20, 27],
          boundary_members: [
            { member: 20, bit: 0 },
            { member: 27, bit: 7 },
          ],
        }),
      ],
      edges: [{
        from: 1,
        to: 2,
        from_port: 'a',
        to_port: 'y',
        net_name: 'a',
        bits: [70, 77],
        source_boundary_members: [
          { member: 10, net_bits: [70] },
          { member: 17, net_bits: [77] },
        ],
        target_boundary_members: [
          { member: 20, net_bits: [70] },
          { member: 27, net_bits: [77] },
        ],
      }],
      truncated: false,
    }

    const request = toSchemWeaveLayoutRequest(prepareLayoutInput(sub))
    expect(request.graph.edges).toHaveLength(2)
    expect(request.constraints.boundary_bundles).toEqual([
      {
        id: 0,
        endpoint: { node: 1, port: 0 },
        width: 8,
        members: [
          { edge: 0, slots: [0] },
          { edge: 1, slots: [7] },
        ],
      },
      {
        id: 1,
        endpoint: { node: 2, port: 0 },
        width: 8,
        members: [
          { edge: 0, slots: [0] },
          { edge: 1, slots: [7] },
        ],
      },
    ])
  })

  it('keeps one SchemWeave route for an identical two-role direct-alias cohort', () => {
    const sub: Subgraph = {
      nodes: [
        node(1, 'port', {
          kind: 'port',
          name: 'a',
          port_direction: 'input',
          member_count: 1,
          boundary_members: [{ member: 10, bit: 0 }],
        }),
        node(2, 'port', {
          kind: 'port',
          name: 'y',
          port_direction: 'output',
          member_count: 1,
          boundary_members: [{ member: 20, bit: 0 }],
        }),
      ],
      edges: [{
        from: 1,
        to: 2,
        from_port: 'a',
        to_port: 'y',
        net_name: 'alias',
        bits: [55],
        source_boundary_members: [{ member: 10, net_bits: [55] }],
        target_boundary_members: [{ member: 20, net_bits: [55] }],
      }],
      truncated: false,
    }

    const request = toSchemWeaveLayoutRequest(prepareLayoutInput(sub))
    expect(request.graph.edges).toHaveLength(1)
    expect(request.constraints.boundary_bundles).toEqual([
      {
        id: 0,
        endpoint: { node: 1, port: 0 },
        width: 1,
        members: [{ edge: 0, slots: [0] }],
      },
      {
        id: 1,
        endpoint: { node: 2, port: 0 },
        width: 1,
        members: [{ edge: 0, slots: [0] }],
      },
    ])
  })

  it('jointly partitions differently ordered direct-alias slot cohorts', () => {
    const sub: Subgraph = {
      nodes: [
        node(1, 'port', {
          kind: 'port',
          name: 'a[1:0]',
          port_direction: 'input',
          member_count: 2,
          boundary_members: [
            { member: 10, bit: 0 },
            { member: 11, bit: 1 },
          ],
        }),
        node(2, 'port', {
          kind: 'port',
          name: 'y[1:0]',
          port_direction: 'output',
          member_count: 2,
          boundary_members: [
            { member: 20, bit: 0 },
            { member: 21, bit: 1 },
          ],
        }),
      ],
      edges: [{
        from: 1,
        to: 2,
        from_port: 'a',
        to_port: 'y',
        net_name: 'permuted_alias',
        bits: [70, 77],
        source_boundary_members: [
          { member: 10, net_bits: [70] },
          { member: 11, net_bits: [77] },
        ],
        target_boundary_members: [
          { member: 20, net_bits: [77] },
          { member: 21, net_bits: [70] },
        ],
      }],
      truncated: false,
    }

    const request = toSchemWeaveLayoutRequest(prepareLayoutInput(sub))
    expect(request.graph.edges).toHaveLength(2)
    expect(request.constraints.boundary_bundles).toEqual([
      {
        id: 0,
        endpoint: { node: 1, port: 0 },
        width: 2,
        members: [
          { edge: 0, slots: [0] },
          { edge: 1, slots: [1] },
        ],
      },
      {
        id: 1,
        endpoint: { node: 2, port: 0 },
        width: 2,
        members: [
          { edge: 0, slots: [1] },
          { edge: 1, slots: [0] },
        ],
      },
    ])
  })

  it('splits staircase slot overlap into deterministic strict electrical cohorts', () => {
    const sub: Subgraph = {
      nodes: [
        node(1, 'port', {
          kind: 'port',
          name: 'request[2:0]',
          port_direction: 'input',
          member_count: 3,
          boundary_members: [
            { member: 10, bit: 0 },
            { member: 11, bit: 1 },
            { member: 12, bit: 2 },
          ],
        }),
        node(2, '$_BUF_'),
        node(3, '$_BUF_'),
      ],
      edges: [
        {
          from: 1,
          to: 2,
          from_port: 'request',
          to_port: 'A',
          net_name: 'request_lo',
          bits: [55],
          source_boundary_members: [
            { member: 10, net_bits: [55] },
            { member: 11, net_bits: [55] },
          ],
        },
        {
          from: 1,
          to: 3,
          from_port: 'request',
          to_port: 'A',
          net_name: 'request_hi',
          bits: [55],
          source_boundary_members: [
            { member: 11, net_bits: [55] },
            { member: 12, net_bits: [55] },
          ],
        },
      ],
      truncated: false,
    }

    const request = toSchemWeaveLayoutRequest(prepareLayoutInput(sub))
    expect(request.graph.edges.map(({ id, net, source, target }) => ({
      id,
      net,
      source,
      target,
    }))).toEqual([
      {
        id: 0,
        net: 0,
        source: { node: 1, port: 0 },
        target: { node: 2, port: 0 },
      },
      {
        id: 1,
        net: 0,
        source: { node: 1, port: 0 },
        target: { node: 2, port: 0 },
      },
      {
        id: 2,
        net: 0,
        source: { node: 1, port: 0 },
        target: { node: 3, port: 0 },
      },
      {
        id: 3,
        net: 0,
        source: { node: 1, port: 0 },
        target: { node: 3, port: 0 },
      },
    ])
    expect(request.constraints.boundary_bundles).toEqual([{
      id: 0,
      endpoint: { node: 1, port: 0 },
      width: 3,
      members: [
        { edge: 0, slots: [0] },
        { edge: 1, slots: [1] },
        { edge: 2, slots: [1] },
        { edge: 3, slots: [2] },
      ],
    }])
  })

  it('is deterministic under duplicate and permuted boundary cohort metadata', () => {
    const makeSubgraph = (permuted: boolean): Subgraph => ({
      nodes: [
        node(1, 'port', {
          kind: 'port',
          name: 'request[2:0]',
          port_direction: 'input',
          member_count: 3,
          boundary_members: permuted
            ? [
                { member: 12, bit: 2 },
                { member: 10, bit: 0 },
                { member: 11, bit: 1 },
                { member: 10, bit: 0 },
              ]
            : [
                { member: 10, bit: 0 },
                { member: 11, bit: 1 },
                { member: 12, bit: 2 },
              ],
        }),
        node(2, '$_BUF_'),
        node(3, '$_BUF_'),
      ],
      edges: [
        {
          from: 1,
          to: 2,
          from_port: 'request',
          to_port: 'A',
          net_name: 'request_lo',
          bits: [55],
          source_boundary_members: permuted
            ? [
                { member: 11, net_bits: [55, 55] },
                { member: 10, net_bits: [55] },
                { member: 10, net_bits: [55] },
              ]
            : [
                { member: 10, net_bits: [55] },
                { member: 11, net_bits: [55] },
              ],
        },
        {
          from: 1,
          to: 3,
          from_port: 'request',
          to_port: 'A',
          net_name: 'request_hi',
          bits: [55],
          source_boundary_members: permuted
            ? [
                { member: 12, net_bits: [55] },
                { member: 11, net_bits: [55] },
              ]
            : [
                { member: 11, net_bits: [55] },
                { member: 12, net_bits: [55] },
              ],
        },
      ],
      truncated: false,
    })

    expect(
      toSchemWeaveLayoutRequest(prepareLayoutInput(makeSubgraph(true))),
    ).toEqual(
      toSchemWeaveLayoutRequest(prepareLayoutInput(makeSubgraph(false))),
    )
  })

  it('rejects conflicting electrical metadata for one endpoint slot before WASM', () => {
    const sub: Subgraph = {
      nodes: [
        node(1, 'port', {
          kind: 'port',
          name: 'request',
          port_direction: 'input',
          member_count: 1,
          boundary_members: [{ member: 10, bit: 0 }],
        }),
        node(2, '$_BUF_'),
        node(3, '$_BUF_'),
      ],
      edges: [
        {
          from: 1,
          to: 2,
          from_port: 'request',
          to_port: 'A',
          net_name: 'first',
          bits: [55],
          source_boundary_members: [{ member: 10, net_bits: [55] }],
        },
        {
          from: 1,
          to: 3,
          from_port: 'request',
          to_port: 'A',
          net_name: 'second',
          bits: [56],
          source_boundary_members: [{ member: 10, net_bits: [56] }],
        },
      ],
      truncated: false,
    }

    expect(() => toSchemWeaveLayoutRequest(prepareLayoutInput(sub))).toThrow(
      'input endpoint 1:0 slot 0 has conflicting electrical net bits [55] and [56]',
    )
  })

  it('rejects a joint partition that would assign two electrical cohorts to one slot', () => {
    const input: LayoutInput = {
      nodes: [
        {
          id: 1,
          baseWidth: 74,
          baseHeight: 34,
          controlHeight: 0,
          register: false,
          boundary: 'input',
          boundaryWidth: 1,
          boundaryMembers: [{ member: 10, bit: 0 }],
        },
        {
          id: 2,
          baseWidth: 74,
          baseHeight: 34,
          controlHeight: 0,
          register: false,
          boundary: 'output',
          boundaryWidth: 2,
          boundaryMembers: [
            { member: 20, bit: 0 },
            { member: 21, bit: 1 },
          ],
        },
      ],
      edges: [{
        from: 1,
        to: 2,
        fromPort: 'a',
        toPort: 'y',
        control: false,
        sourceBoundaryMembers: [{
          member: 10,
          net_bits: [55, 56],
        }],
        targetBoundaryMembers: [
          { member: 20, net_bits: [55] },
          { member: 21, net_bits: [56] },
        ],
      }],
    }

    expect(() => toSchemWeaveLayoutRequest(input)).toThrow(
      'input endpoint 1:0 slot 0 has conflicting electrical net bits [55] and [56]',
    )
  })

  it('enforces the edge cap after electrical cohort expansion', () => {
    const fragmentCount = MAX_GRAPH_EDGES + 1
    const input: LayoutInput = {
      nodes: [
        {
          id: 1,
          baseWidth: 74,
          baseHeight: 34,
          controlHeight: 0,
          register: false,
          boundary: 'input',
          boundaryWidth: fragmentCount,
          boundaryMembers: Array.from({ length: fragmentCount }, (_, bit) => ({
            member: bit + 10,
            bit,
          })),
        },
        {
          id: 2,
          baseWidth: 62,
          baseHeight: 46,
          controlHeight: 0,
          register: false,
          boundary: 'internal',
        },
      ],
      edges: [{
        from: 1,
        to: 2,
        fromPort: 'a',
        toPort: 'A',
        control: false,
        sourceBoundaryMembers: Array.from(
          { length: fragmentCount },
          (_, bit) => ({
            member: bit + 10,
            net_bits: [bit + 100],
          }),
        ),
      }],
    }

    expect(() => toSchemWeaveLayoutRequest(input)).toThrow(
      '10001 electrical layout edges after boundary expansion; limit 10000',
    )
  })

  it('does not constrain grouped inout or topology-internal boundary metadata', () => {
    const sub: Subgraph = {
      nodes: [
        node(1, '$_BUF_'),
        node(2, 'port', {
          kind: 'port',
          name: 'bidir[1:0]',
          port_direction: 'inout',
          member_count: 2,
          boundary_members: [
            { member: 20, bit: 0 },
            { member: 21, bit: 1 },
          ],
        }),
        node(3, 'port', {
          kind: 'port',
          name: 'declared_input',
          port_direction: 'input',
          member_count: 1,
          boundary_members: [{ member: 30, bit: 0 }],
        }),
        node(4, '$_BUF_'),
      ],
      edges: [
        {
          from: 1,
          to: 2,
          from_port: 'Y',
          to_port: 'bidir',
          net_name: 'bidir_in',
          bits: [100],
          target_boundary_members: [{ member: 20, net_bits: [100] }],
        },
        {
          from: 2,
          to: 3,
          from_port: 'bidir',
          to_port: 'declared_input',
          net_name: 'internal_link',
          bits: [101],
          source_boundary_members: [{ member: 21, net_bits: [101] }],
          target_boundary_members: [{ member: 30, net_bits: [101] }],
        },
        {
          from: 3,
          to: 4,
          from_port: 'declared_input',
          to_port: 'A',
          net_name: 'unexpected_drive',
          bits: [102],
          source_boundary_members: [{ member: 30, net_bits: [102] }],
        },
      ],
      truncated: false,
    }

    const input = prepareLayoutInput(sub)
    expect(input.nodes.map(({ id, boundary }) => ({ id, boundary }))).toEqual([
      { id: 1, boundary: 'internal' },
      { id: 2, boundary: 'internal' },
      { id: 3, boundary: 'internal' },
      { id: 4, boundary: 'internal' },
    ])
    expect(toSchemWeaveLayoutRequest(input).constraints).toEqual({
      inputs: [],
      outputs: [],
    })
  })

  it('fails closed when boundary bundle metadata contradicts a true boundary role', () => {
    const input: LayoutInput = {
      nodes: [
        {
          id: 1,
          baseWidth: 62,
          baseHeight: 46,
          controlHeight: 0,
          register: false,
          boundary: 'output',
          boundaryWidth: 1,
          boundaryMembers: [{ member: 10, bit: 0 }],
        },
        {
          id: 2,
          baseWidth: 62,
          baseHeight: 46,
          controlHeight: 0,
          register: false,
          boundary: 'internal',
        },
      ],
      edges: [{
        from: 1,
        to: 2,
        fromPort: 'Y',
        toPort: 'A',
        control: false,
        sourceBoundaryMembers: [{ member: 10, net_bits: [100] }],
      }],
    }

    expect(() => toSchemWeaveLayoutRequest(input)).toThrow(
      'boundary bundle input metadata references output node 1',
    )
  })

  it('keeps empty metadata compatible and SchemWeave local-only', () => {
    const request = toSchemWeaveLayoutRequest({
      nodes: [],
      edges: [],
    })
    expect(request).toEqual({
      graph: { nodes: [], edges: [] },
      constraints: { inputs: [], outputs: [] },
    })
    expect(comparisonLayoutEngine('?layout=schemweave', true)).toBe('schemweave')
    expect(comparisonLayoutEngine('?layout=schemweave', false)).toBe('elk')
    expect(comparisonLayoutEngine('', true)).toBe('elk')
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
      url: string
      requests: Array<{
        id: number
        input: ReturnType<typeof prepareLayoutInput>
        placement?: 'NETWORK_SIMPLEX' | 'BRANDES_KOEPF'
        request?: ReturnType<typeof toSchemWeaveLayoutRequest>
        kind?: SchemWeaveWorkerRequest['kind']
      }> = []

      constructor(url: URL) {
        this.url = String(url)
        FakeWorker.instances.push(this)
      }

      postMessage(request: FakeWorker['requests'][number]) {
        this.requests.push(request)
      }
    }

  const schemWeaveWorkerResponse = (
    request: FakeWorker['requests'][number],
    layout: SchemWeaveLayout,
    degraded = false,
  ): MessageEvent => {
    const prepared = buildSchemWeaveLayoutRequest(request.input)
    return {
      data: {
        id: request.id,
        ok: true,
        result: {
          status: 'layout',
          geometry: interpretSchemWeaveResult(
            layout,
            prepared.catalog,
            prepared.request,
          ),
          degraded,
        },
      },
    } as MessageEvent
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

  configureLayoutWorkerFactory((engine) =>
    new Worker(new URL(
      engine === 'schemweave'
        ? '../workers/schemweave.worker.ts'
        : '../workers/elk.worker.ts',
      import.meta.url,
    )))

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

  it('keeps the local SchemWeave worker and geometry cache isolated from ELK', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const sub = workerSubgraph()

    const elkLayout = layoutSubgraph(sub)
    const elk = FakeWorker.instances[0]
    expect(elk.url).toContain('elk.worker.ts')
    elk.onmessage?.({
      data: { id: elk.requests[0].id, ok: true, result: geometry },
    } as MessageEvent)
    await elkLayout

    const schemWeaveLayout = layoutSubgraph(sub, undefined, 'schemweave')
    const schemweave = FakeWorker.instances[1]
    expect(schemweave.url).toContain('schemweave.worker.ts')
    expect(schemweave.requests[0]).toEqual({
      id: expect.any(Number),
      kind: 'layout',
      input: prepareLayoutInput(sub),
    })
    schemweave.onmessage?.(
      schemWeaveWorkerResponse(schemweave.requests[0], geometry),
    )
    await schemWeaveLayout

    expect(FakeWorker.instances).toHaveLength(2)
    elk.onerror?.({ message: 'cleanup' } as ErrorEvent)
    schemweave.onerror?.({ message: 'cleanup' } as ErrorEvent)
  })

  it('hydrates electrical fragments to exact UI bit subsets and rendered bundle owners', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const sub: Subgraph = {
      nodes: [
        node(1, '$_BUF_'),
        node(2, 'port', {
          kind: 'port',
          name: 'y[1:0]',
          port_direction: 'output',
          member_count: 2,
          boundary_members: [
            { member: 20, bit: 0 },
            { member: 21, bit: 1 },
          ],
        }),
      ],
      edges: [{
        from: 1,
        to: 2,
        from_port: 'Y',
        to_port: 'y',
        net_name: 'y',
        bits: [55, 56],
        target_boundary_members: [
          { member: 20, net_bits: [55] },
          { member: 21, net_bits: [56] },
        ],
      }],
      truncated: false,
    }

    const pendingLayout = layoutSubgraph(sub, undefined, 'schemweave')
    const worker = FakeWorker.instances[0]
    expect(
      buildSchemWeaveLayoutRequest(worker.requests[0].input)
        .request.graph.edges,
    ).toHaveLength(2)
    worker.onmessage?.(
      schemWeaveWorkerResponse(worker.requests[0], {
          nodes: [
            { id: 1, x: 0, y: 0, width: 62, height: 46 },
            { id: 2, x: 140, y: 0, width: 74, height: 34 },
          ],
          // Deliberately return a non-id order. Bundle ownership is expressed
          // in Schem edge ids but the renderer consumes hydrated array indexes.
          edges: [
            {
              id: 1,
              points: [{ x: 62, y: 24 }, { x: 130, y: 24 }],
            },
            {
              id: 0,
              points: [{ x: 62, y: 18 }, { x: 130, y: 18 }],
            },
          ],
          boundary_bundles: [{
            id: 0,
            endpoint: { node: 2, port: 0 },
            role: 'output',
            width: 2,
            collector: {
              start: { x: 130, y: 18 },
              end: { x: 130, y: 24 },
            },
            spine: {
              start: { x: 140, y: 21 },
              end: { x: 130, y: 21 },
            },
            members: [
              { edge: 0, slots: [0], tap: { x: 130, y: 18 } },
              { edge: 1, slots: [1], tap: { x: 130, y: 24 } },
            ],
          }],
          width: 214,
          height: 46,
      }),
    )

    const laidOut = await pendingLayout
    expect(laidOut.edges.map((edge) => edge.edge.bits)).toEqual([[56], [55]])
    expect(laidOut.edges.every((edge) => edge.edge !== sub.edges[0])).toBe(true)
    expect(laidOut.boundaryBundles).toEqual([expect.objectContaining({
      id: 0,
      role: 'output',
      ownerIndexes: [0, 1],
    })])
    worker.onerror?.({ message: 'cleanup' } as ErrorEvent)
  })

  it('does not cache degraded bundle-free geometry but caches the next strict success', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const bundled = (): Subgraph => ({
      nodes: [
        node(1, 'port', {
          kind: 'port',
          port_direction: 'input',
          member_count: 1,
          boundary_members: [{ member: 10, bit: 0 }],
        }),
        node(2, 'port', {
          kind: 'port',
          port_direction: 'output',
          member_count: 1,
          boundary_members: [{ member: 20, bit: 0 }],
        }),
      ],
      edges: [{
        from: 1,
        to: 2,
        from_port: 'a',
        to_port: 'y',
        net_name: 'a',
        bits: [100],
        source_boundary_members: [{ member: 10, net_bits: [100] }],
        target_boundary_members: [{ member: 20, net_bits: [100] }],
      }],
      truncated: false,
    })
    const rawGeometry = {
      nodes: [
        { id: 1, x: 0, y: 0, width: 74, height: 34 },
        { id: 2, x: 140, y: 0, width: 74, height: 34 },
      ],
      edges: [{
        id: 0,
        points: [{ x: 74, y: 17 }, { x: 140, y: 17 }],
      }],
      width: 214,
      height: 34,
    }
    const strictGeometry = {
      ...rawGeometry,
      boundary_bundles: [{
        id: 0,
        endpoint: { node: 1, port: 0 },
        role: 'input' as const,
        width: 1,
        collector: {
          start: { x: 84, y: 17 },
          end: { x: 84, y: 17 },
        },
        spine: {
          start: { x: 74, y: 17 },
          end: { x: 84, y: 17 },
        },
        members: [{
          edge: 0,
          slots: [0],
          tap: { x: 84, y: 17 },
        }],
      }],
    }

    const degraded = layoutSubgraph(bundled(), undefined, 'schemweave')
    const worker = FakeWorker.instances[0]
    expect(
      buildSchemWeaveLayoutRequest(worker.requests[0].input)
        .request.constraints.boundary_bundles,
    ).toHaveLength(2)
    worker.onmessage?.(
      schemWeaveWorkerResponse(worker.requests[0], rawGeometry, true),
    )
    await expect(degraded).resolves.toMatchObject({ boundaryBundles: [] })

    const strict = layoutSubgraph(
      structuredClone(bundled()),
      undefined,
      'schemweave',
    )
    expect(worker.requests).toHaveLength(2)
    expect(
      buildSchemWeaveLayoutRequest(worker.requests[1].input)
        .request.constraints.boundary_bundles,
    ).toHaveLength(2)
    worker.onmessage?.(
      schemWeaveWorkerResponse(worker.requests[1], strictGeometry),
    )
    await expect(strict).resolves.toMatchObject({
      boundaryBundles: [{ id: 0 }],
    })

    await expect(layoutSubgraph(
      structuredClone(bundled()),
      undefined,
      'schemweave',
    )).resolves.toMatchObject({
      boundaryBundles: [{ id: 0 }],
    })
    expect(worker.requests).toHaveLength(2)
    worker.onerror?.({ message: 'cleanup' } as ErrorEvent)
  })

  it('rejects a full-layout response that requests another full relayout', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const pending = layoutSubgraph(workerSubgraph(), undefined, 'schemweave')
    const worker = FakeWorker.instances[0]

    worker.onmessage?.({
      data: {
        id: worker.requests[0].id,
        ok: true,
        result: {
          status: 'needs_full_relayout',
          reason: 'geometry',
        },
      },
    } as MessageEvent)

    await expect(pending).rejects.toThrow(
      'full SchemWeave layout requested another full relayout',
    )
    worker.onerror?.({ message: 'cleanup' } as ErrorEvent)
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

  it('does not let a stale SchemWeave response take over the latest request', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const controller = new AbortController()
    const stale = layoutSubgraph(
      workerSubgraph(),
      controller.signal,
      'schemweave',
    )
    const first = FakeWorker.instances[0]
    const staleHandler = first.onmessage

    controller.abort()
    await expect(stale).rejects.toMatchObject({ name: 'AbortError' })

    const latest = layoutSubgraph(workerSubgraph(2), undefined, 'schemweave')
    const replacement = FakeWorker.instances[1]
    staleHandler?.(
      schemWeaveWorkerResponse(first.requests[0], geometry),
    )
    replacement.onmessage?.(
      schemWeaveWorkerResponse(replacement.requests[0], {
          ...geometry,
          nodes: [{ ...geometry.nodes[0], id: 2 }],
      }),
    )

    await expect(latest).resolves.toMatchObject({
      nodes: [{ id: 2 }],
      width: 76,
    })
    replacement.onerror?.({ message: 'cleanup' } as ErrorEvent)
  })

  it('aborts an expansion without letting its stale response replace a later expansion', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const sub = workerSubgraph()
    const prepared = buildSchemWeaveLayoutRequest(prepareLayoutInput(sub))
    const baseGeometry = interpretSchemWeaveResult(
      geometry,
      prepared.catalog,
      prepared.request,
    )
    baseGeometry.schemWeaveSession = { sessionId: 1 }
    const base = hydrateLayoutResult(sub, baseGeometry)
    const group = { id: 90, members: [1], referenceHeight: 66 }
    const controller = new AbortController()

    const stale = layoutExpandedGroupWithSchemWeave(
      sub,
      base,
      group,
      controller.signal,
      [group],
    )
    const first = FakeWorker.instances[0]
    const staleHandler = first.onmessage
    const firstRequest = first.requests[0]

    controller.abort()
    await expect(stale).rejects.toMatchObject({ name: 'AbortError' })
    expect(first.terminate).toHaveBeenCalledOnce()

    const latest = layoutExpandedGroupWithSchemWeave(
      sub,
      base,
      group,
      undefined,
      [group],
    )
    const replacement = FakeWorker.instances[1]
    const replacementRequest = replacement.requests[0]
    let latestSettled = false
    void latest.finally(() => {
      latestSettled = true
    })
    staleHandler?.({
      data: {
        id: firstRequest.id,
        ok: true,
        result: {
          status: 'layout',
          geometry: { ...baseGeometry, width: 999 },
          degraded: false,
        },
      },
    } as MessageEvent)
    await Promise.resolve()
    expect(latestSettled).toBe(false)
    replacement.onmessage?.({
      data: {
        id: replacementRequest.id,
        ok: true,
        result: {
          status: 'layout',
          geometry: baseGeometry,
          degraded: false,
        },
      },
    } as MessageEvent)

    await expect(latest).resolves.toMatchObject({ width: 76, height: 66 })
    expect(FakeWorker.instances).toHaveLength(2)
    replacement.onerror?.({ message: 'cleanup' } as ErrorEvent)
  })

  it('reports an evicted expansion session for grouped recovery', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const sub = workerSubgraph()
    const prepared = buildSchemWeaveLayoutRequest(prepareLayoutInput(sub))
    const baseGeometry = interpretSchemWeaveResult(
      geometry,
      prepared.catalog,
      prepared.request,
    )
    baseGeometry.schemWeaveSession = { sessionId: 41 }
    const base = hydrateLayoutResult(sub, baseGeometry)
    const group = { id: 90, members: [1], referenceHeight: 66 }

    const pending = layoutExpandedGroupWithSchemWeave(
      sub,
      base,
      group,
      undefined,
      [group],
    )
    const worker = FakeWorker.instances[0]
    expect(worker.requests[0]).toMatchObject({
      kind: 'expand',
      sessionId: 41,
    })
    worker.onmessage?.({
      data: {
        id: worker.requests[0].id,
        ok: true,
        result: {
          status: 'needs_full_relayout',
          reason: 'geometry',
        },
      },
    } as MessageEvent)

    await expect(pending).resolves.toBeNull()
    expect(worker.requests).toHaveLength(1)
    worker.onerror?.({ message: 'cleanup' } as ErrorEvent)
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

  it('normalizes boundary metadata for cache identity and invalidates changed mappings', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const bundled = (): Subgraph => ({
      nodes: [
        node(1, 'port', {
          kind: 'port',
          port_direction: 'input',
          boundary_members: [
            { member: 11, bit: 1 },
            { member: 10, bit: 0 },
          ],
        }),
        node(2, 'port', {
          kind: 'port',
          port_direction: 'output',
          boundary_members: [
            { member: 21, bit: 1 },
            { member: 20, bit: 0 },
          ],
        }),
      ],
      edges: [{
        from: 1,
        to: 2,
        from_port: 'a',
        to_port: 'A',
        net_name: 'a',
        bits: [100, 101],
        source_boundary_members: [
          { member: 11, net_bits: [101] },
          { member: 10, net_bits: [100] },
        ],
        target_boundary_members: [
          { member: 21, net_bits: [101] },
          { member: 20, net_bits: [100] },
        ],
      }],
      truncated: false,
    })
    const bundledGeometry = {
      nodes: [
        { id: 1, x: 0, y: 0, width: 62, height: 46 },
        { id: 2, x: 128, y: 0, width: 62, height: 46 },
      ],
      edges: [{ inputIndex: 0, points: [{ x: 62, y: 23 }, { x: 128, y: 23 }] }],
      width: 190,
      height: 46,
    }

    const first = layoutSubgraph(bundled())
    const instance = FakeWorker.instances[0]
    instance.onmessage?.({
      data: { id: instance.requests[0].id, ok: true, result: bundledGeometry },
    } as MessageEvent)
    await first
    expect(instance.requests[0].input.nodes[0].boundaryMembers).toEqual([
      { member: 10, bit: 0 },
      { member: 11, bit: 1 },
    ])

    const equivalent = bundled()
    equivalent.nodes[0].boundary_members = [
      { member: 10, bit: 0 },
      { member: 11, bit: 1 },
      { member: 10, bit: 0 },
    ]
    equivalent.edges[0].source_boundary_members = [
      { member: 10, net_bits: [100, 100] },
      { member: 11, net_bits: [101] },
    ]
    equivalent.edges[0].target_boundary_members = [
      { member: 20, net_bits: [100, 100] },
      { member: 21, net_bits: [101] },
    ]
    await layoutSubgraph(equivalent)
    expect(instance.requests).toHaveLength(1)

    const changedNode = bundled()
    changedNode.nodes[0].boundary_members![1].bit = 2
    const changedNodeLayout = layoutSubgraph(changedNode)
    expect(instance.requests).toHaveLength(2)
    instance.onmessage?.({
      data: { id: instance.requests[1].id, ok: true, result: bundledGeometry },
    } as MessageEvent)
    await changedNodeLayout

    const changedEdge = bundled()
    changedEdge.edges[0].target_boundary_members![1].net_bits = [102]
    const changedEdgeLayout = layoutSubgraph(changedEdge)
    expect(instance.requests).toHaveLength(3)
    instance.onmessage?.({
      data: { id: instance.requests[2].id, ok: true, result: bundledGeometry },
    } as MessageEvent)
    await changedEdgeLayout
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

  it('times out a collapse and lets the next collapse use a fresh worker', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('Worker', FakeWorker)
    const sub = workerSubgraph()
    const prepared = buildSchemWeaveLayoutRequest(prepareLayoutInput(sub))
    const baseGeometry = interpretSchemWeaveResult(
      geometry,
      prepared.catalog,
      prepared.request,
    )
    baseGeometry.schemWeaveSession = { sessionId: 1 }
    const expanded = hydrateLayoutResult(sub, baseGeometry)
    const group = { id: 90, members: [1], referenceHeight: 66 }

    const timedOut = layoutCollapsedGroupWithSchemWeave(
      sub,
      expanded,
      group,
      [],
    )
    const first = FakeWorker.instances[0]
    const timeoutExpectation = expect(timedOut).rejects.toMatchObject({
      name: 'LayoutTimeoutError',
    })
    await vi.advanceTimersByTimeAsync(10_000)
    await timeoutExpectation
    expect(first.requests).toHaveLength(1)
    expect(first.terminate).toHaveBeenCalledOnce()

    const current = layoutCollapsedGroupWithSchemWeave(
      sub,
      expanded,
      group,
      [],
    )
    const replacement = FakeWorker.instances[1]
    const request = replacement.requests[0]
    replacement.onmessage?.({
      data: {
        id: request.id,
        ok: true,
        result: {
          status: 'layout',
          geometry: baseGeometry,
          degraded: false,
        },
      },
    } as MessageEvent)

    await expect(current).resolves.toMatchObject({ width: 76, height: 66 })
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

  it('anchors expansion and collapse to the grouped node replacement', () => {
    const grouped = node(100, 'FDRE', { members: [1, 2], member_count: 2 })
    const output = node(9, '$_BUF_')
    const compact = {
      nodes: [
        { id: 100, x: 100, y: 100, width: 100, height: 60, node: grouped },
        { id: 9, x: 500, y: 100, width: 80, height: 50, node: output },
      ],
      edges: [],
      width: 580,
      height: 160,
    }
    const expanded = {
      nodes: [
        { id: 1, x: 100, y: 100, width: 80, height: 50, node: node(1, 'FDRE') },
        { id: 2, x: 240, y: 100, width: 80, height: 50, node: node(2, 'FDRE') },
        { id: 9, x: 700, y: 100, width: 80, height: 50, node: output },
      ],
      edges: [],
      width: 780,
      height: 160,
    }

    const opened = preserveViewportAnchor(
      { x: 20, y: 30, k: 2 },
      compact,
      expanded,
      [9],
    )
    expect(opened).toEqual({ x: 40, y: 40, k: 2 })
    expect(
      preserveViewportAnchor(opened, expanded, compact, [9]),
    ).toEqual({ x: 20, y: 30, k: 2 })
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
