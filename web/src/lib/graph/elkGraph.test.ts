import ELK from 'elkjs/lib/elk.bundled.js'
import { describe, expect, it } from 'vitest'
import type { GraphNode, Subgraph } from '../../types'
import {
  DENSE_LAYOUT_NODE_THRESHOLD,
  hydrateLayoutResult,
  interpretResult,
  MAX_GLOBAL_LAYOUT_COMPONENTS,
  prepareLayoutInput,
  REDUCED_THOROUGHNESS_EDGE_DENSITY,
  REDUCED_THOROUGHNESS_NODE_THRESHOLD,
  SOURCE_FLOW_EDGE_DENSITY,
  SOURCE_FLOW_NODE_THRESHOLD,
  toElkGraph,
  type LayoutInput,
  type NodePlacement,
} from './elkGraph'
import { nodeDimensions } from './nodeGeometry'

{
const node = (id: number, cellType: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  id,
  kind: 'cell',
  name: `u${id}`,
  cell_type: cellType,
  ...extra,
})

describe('schematic layout sizing', () => {
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
    // Nothing crosses this group's boundary, so it needs no proxy port at all.
    expect(compound?.ports).toEqual([])
    expect(graph.edges).toEqual([])
    expect(compound?.layoutOptions?.['elk.direction']).toBe('RIGHT')
  })

  it('gives each crossing net of a stacked group its own boundary port', () => {
    const sub: Subgraph = {
      nodes: [
        node(10, 'port', { kind: 'port', name: 'd', port_direction: 'input' }),
        node(12, 'port', { kind: 'port', name: 'clk', port_direction: 'input' }),
        node(1, 'FDRE'),
        node(2, 'FDRE'),
        node(11, 'port', { kind: 'port', name: 'q', port_direction: 'output' }),
      ],
      edges: [
        { from: 10, to: 1, from_port: 'Y', to_port: 'D', net_name: 'd', bits: [1] },
        {
          from: 12,
          to: 1,
          from_port: 'Y',
          to_port: 'C',
          net_name: 'clk',
          bits: [2],
          control: true,
        },
        { from: 10, to: 2, from_port: 'Y', to_port: 'D', net_name: 'd', bits: [3] },
        { from: 1, to: 2, from_port: 'Q', to_port: 'R', net_name: 'link', bits: [4] },
        { from: 2, to: 11, from_port: 'Q', to_port: 'A', net_name: 'q', bits: [5] },
      ],
      truncated: false,
    }
    const input = prepareLayoutInput(sub, [{
      id: 100,
      members: [1, 2],
      referenceHeight: 1_000,
    }])
    const graph = toElkGraph(input)
    const compound = graph.children?.find((child) => child.id === 'group:100')

    // One port per crossing net endpoint, none for the member-to-member link.
    expect(compound?.ports?.map((port) => port.id)).toEqual([
      'group:100#in:1#in',
      'group:100#in:1#control:C',
      'group:100#in:2#in',
      'group:100#out:2#out',
    ])
    expect(
      graph.edges?.map((edge) => [edge.sources[0], edge.targets[0]]),
    ).toEqual([
      ['10#o:Y', 'group:100#in:1#in'],
      ['12#o:Y', 'group:100#in:1#control:C'],
      ['10#o:Y', 'group:100#in:2#in'],
      ['group:100#out:2#out', '11#i:A'],
    ])
    // West ports run top-to-bottom in member order; D sits above C on member 1,
    // and member 2's D sits below both.
    const westY = compound?.ports
      ?.filter((port) => port.layoutOptions?.['elk.port.side'] === 'WEST')
      .map((port) => port.y ?? 0) ?? []
    expect(westY).toEqual([...westY].sort((left, right) => left - right))
    expect(new Set(westY).size).toBe(3)
  })

  it('lands every stacked-group boundary port on its member pin', () => {
    const sub: Subgraph = {
      nodes: [
        node(10, 'port', { kind: 'port', name: 'd', port_direction: 'input' }),
        node(12, 'port', { kind: 'port', name: 'clk', port_direction: 'input' }),
        node(1, 'FDRE'),
        node(2, 'FDRE'),
      ],
      edges: [
        { from: 10, to: 1, from_port: 'Y', to_port: 'D', net_name: 'd', bits: [1] },
        {
          from: 12,
          to: 1,
          from_port: 'Y',
          to_port: 'C',
          net_name: 'clk',
          bits: [2],
          control: true,
        },
        { from: 10, to: 2, from_port: 'Y', to_port: 'D', net_name: 'd', bits: [3] },
      ],
      truncated: false,
    }
    const input = prepareLayoutInput(sub, [{
      id: 100,
      members: [1, 2],
      referenceHeight: 1_000,
    }])
    const graph = toElkGraph(input)
    const compound = (graph.children ?? []).find(
      (child) => child.id === 'group:100',
    )!
    const frame = { x: 400, y: 60 }
    const portById = new Map(
      (compound.ports ?? []).map((port) => [port.id, port]),
    )
    // Replay what ELK produces for these declared ports: each net stops on the
    // frame edge at its own port height.
    const geometry = interpretResult(input, {
      id: 'root',
      width: 900,
      height: 600,
      children: [
        { id: '10', x: 10, y: 200, width: 62, height: 46 },
        { id: '12', x: 10, y: 320, width: 62, height: 46 },
        {
          ...compound,
          x: frame.x,
          y: frame.y,
          children: (compound.children ?? []).map((child, index) => ({
            ...child,
            x: 16,
            y: 30 + index * 100,
          })),
        },
      ],
      edges: (graph.edges ?? []).map((edge) => {
        const port = portById.get(edge.targets[0])!
        return {
          ...edge,
          sections: [{
            id: `${edge.id}s0`,
            startPoint: { x: 72, y: 223 },
            endPoint: { x: frame.x, y: frame.y + (port.y ?? 0) },
          }],
        }
      }),
    })
    const memberById = new Map(
      geometry.nodes.map((laidOut) => [laidOut.id, laidOut]),
    )

    input.edges.forEach((edge, index) => {
      const member = memberById.get(edge.to)!
      const route = geometry.edges[index].points
      const entry = route.at(-2)!
      const pin = route.at(-1)!
      // The net crosses the frame at the pin's own height and goes straight in:
      // no perimeter rail, no vertical correction inside the group.
      expect(pin.x).toBe(member.x)
      expect(entry.x).toBe(frame.x)
      expect(entry.y).toBe(pin.y)
      expect(pin.y).toBeGreaterThan(member.y)
      expect(pin.y).toBeLessThan(member.y + member.height)
    })
    // Distinct pins on one member stay distinct.
    expect(geometry.edges[0].points.at(-1)?.y).not.toBe(
      geometry.edges[1].points.at(-1)?.y,
    )
  })

  it('switches an expanded group to a clean grid beyond twice the reference height', () => {
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
    // Members are placed on a fixed lattice, so the compound needs no interior
    // edges to shape the grid.
    expect(compound?.edges).toEqual([])
    expect(compound?.layoutOptions?.['elk.algorithm']).toBe('fixed')
    const cells = compound?.children?.map((child) =>
      ({ x: child.x ?? 0, y: child.y ?? 0 })) ?? []
    const columnXs = [...new Set(cells.map((cell) => cell.x))]
      .sort((left, right) => left - right)
    expect(new Set(columnXs.slice(1).map((x, i) => x - columnXs[i])).size)
      .toBe(1)
    expect(new Set(cells.map((cell) => cell.y)).size).toBe(2)
  })

  it('uses a vertical column at the exact 2x limit and a grid just beyond it', () => {
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
    const exactReferenceHeight = (probe?.height ?? 0) / 2
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
          targets: ['group:100#in:1#in'],
          sections: [{
            id: 'e0s0',
            startPoint: { x: 72, y: 163 },
            endPoint: { x: 100, y: 190 },
          }],
        },
        {
          id: 'e2',
          sources: ['group:100#out:2#out'],
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
          targets: ['group:100#in:1#control:C'],
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
    // The compound's size, member cells and ports all come from the lattice, so
    // stand the fixture up from the graph the layout actually asks ELK for.
    const compound = (toElkGraph(input).children ?? [])
      .find((child) => child.id === 'group:100')!
    const port = (compound.ports ?? [])
      .find((candidate) => candidate.id.startsWith('group:100#in:'))!
    const geometry = interpretResult(input, {
      id: 'root',
      width: 900,
      height: 600,
      children: [
        { id: '10', x: 10, y: 130, width: 62, height: 46 },
        { ...compound, x: 100, y: 40 },
      ],
      edges: [{
        id: 'e0',
        sources: ['10'],
        targets: [port.id],
        sections: [{
          id: 'e0s0',
          startPoint: { x: 72, y: 153 },
          endPoint: { x: 100, y: 40 + (port.y ?? 0) },
        }],
      }],
    })
    const route = geometry.edges[0].points
    const target = geometry.nodes.find((laidOut) => laidOut.id === 2)!
    const crossesAnyMember = route.slice(1).some((point, index) => {
      const previous = route[index]
      return geometry.nodes.some((other) =>
        other.id !== 2 && other.id !== 10 &&
        Math.max(previous.x, point.x) > other.x &&
        Math.min(previous.x, point.x) < other.x + other.width &&
        Math.max(previous.y, point.y) > other.y &&
        Math.min(previous.y, point.y) < other.y + other.height,
      )
    })
    // Inside the frame the leg rides a channel then a gutter -- never a
    // diagonal, and never across a sibling cell.
    const insideDiagonal = route.slice(1).some((point, index) => {
      const previous = route[index]
      return previous.x >= 100 && point.x >= 100 &&
        previous.x !== point.x && previous.y !== point.y
    })

    expect(crossesAnyMember).toBe(false)
    expect(insideDiagonal).toBe(false)
    expect(route.at(-1)?.x).toBe(target.x)
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
    // Each member gets its own boundary port instead of one shared funnel.
    expect(new Set(graph.edges?.flatMap((edge) => edge.targets)).size)
      .toBe(members.length)
    expect(new Set(compound?.ports?.map((port) => port.id)).size)
      .toBe(members.length)
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

  it('retains the reduced-thoroughness fast path for dense BK layouts', () => {
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
        { length: DENSE_LAYOUT_NODE_THRESHOLD * 4 },
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
    expect(dense?.['elk.layered.layering.strategy']).toBe('LONGEST_PATH_SOURCE')

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
    expect(mediumDense?.['elk.layered.layering.strategy']).toBe(
      'LONGEST_PATH_SOURCE',
    )

    const belowFastPath = {
      ...denseInput,
      edges: denseInput.edges.slice(
        0,
        DENSE_LAYOUT_NODE_THRESHOLD * REDUCED_THOROUGHNESS_EDGE_DENSITY - 1,
      ),
    }
    const belowFastPathOptions = toElkGraph(
      belowFastPath,
      'BRANDES_KOEPF',
    ).layoutOptions
    expect(belowFastPathOptions?.['elk.layered.thoroughness']).toBe('4')
    expect(belowFastPathOptions?.['elk.layered.layering.strategy']).toBe(
      'LONGEST_PATH_SOURCE',
    )

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

  it('uses source-oriented layering only for large dense dataflow BK layouts', () => {
    const sourceFlowInput = (
      nodeCount: number,
      edgeCount: number,
      control = false,
    ): LayoutInput => {
      const sourceCount = Math.floor(nodeCount / 2)
      return {
        nodes: Array.from({ length: nodeCount }, (_, id) => ({
          id,
          baseWidth: 62,
          baseHeight: 46,
          controlHeight: 0,
          register: false,
          boundary: 'internal',
        })),
        edges: Array.from({ length: edgeCount }, (_, index) => ({
          from: index % sourceCount,
          to: sourceCount + (index % (nodeCount - sourceCount)),
          fromPort: `Y${index}`,
          toPort: `A${index}`,
          control,
        })),
      }
    }
    const eligible = sourceFlowInput(
      SOURCE_FLOW_NODE_THRESHOLD,
      SOURCE_FLOW_NODE_THRESHOLD * SOURCE_FLOW_EDGE_DENSITY,
    )
    const cases: Array<[
      LayoutInput,
      NodePlacement,
      'LONGEST_PATH_SOURCE' | undefined,
    ]> = [
      [eligible, 'BRANDES_KOEPF', 'LONGEST_PATH_SOURCE'],
      [
        sourceFlowInput(
          SOURCE_FLOW_NODE_THRESHOLD - 1,
          (SOURCE_FLOW_NODE_THRESHOLD - 1) * SOURCE_FLOW_EDGE_DENSITY,
        ),
        'BRANDES_KOEPF',
        undefined,
      ],
      [
        sourceFlowInput(
          SOURCE_FLOW_NODE_THRESHOLD,
          SOURCE_FLOW_NODE_THRESHOLD * SOURCE_FLOW_EDGE_DENSITY - 1,
        ),
        'BRANDES_KOEPF',
        undefined,
      ],
      [
        sourceFlowInput(
          SOURCE_FLOW_NODE_THRESHOLD,
          SOURCE_FLOW_NODE_THRESHOLD * SOURCE_FLOW_EDGE_DENSITY,
          true,
        ),
        'BRANDES_KOEPF',
        undefined,
      ],
      [
        { ...eligible, groups: [{ id: 1, members: [0, 1] }] },
        'BRANDES_KOEPF',
        undefined,
      ],
      [eligible, 'NETWORK_SIMPLEX', undefined],
    ]
    for (const [input, placement, expected] of cases) {
      expect(
        toElkGraph(input, placement).layoutOptions?.[
          'elk.layered.layering.strategy'
        ],
      ).toBe(expected)
    }
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

})
}

{
const node = (
  id: number,
  name: string,
  extra: Partial<GraphNode> = {},
): GraphNode => ({
  id,
  kind: 'port',
  name,
  ...extra,
})

describe('logic-oriented ELK layout policy', () => {
  it('aligns primary boundaries and routes an acyclic datapath from left to right', async () => {
    const subgraph: Subgraph = {
      nodes: [
        node(1, 'a'),
        node(2, 'substantially_wider_input_name'),
        node(10, 'and_gate', { kind: 'cell', cell_type: '$_AND_' }),
        node(20, 'y'),
        node(21, 'substantially_wider_output_name'),
      ],
      edges: [
        { from: 1, to: 10, from_port: 'a', to_port: 'A', net_name: 'a', bits: [1] },
        { from: 2, to: 10, from_port: 'b', to_port: 'B', net_name: 'b', bits: [2] },
        { from: 10, to: 20, from_port: 'Y', to_port: 'y', net_name: 'y', bits: [3] },
        { from: 10, to: 21, from_port: 'Y', to_port: 'wide', net_name: 'wide', bits: [4] },
      ],
      truncated: false,
    }
    const input = prepareLayoutInput(subgraph)
    const result = interpretResult(input, await new ELK().layout(toElkGraph(input)))
    const nodes = new Map(result.nodes.map((candidate) => [candidate.id, candidate]))
    const inputA = nodes.get(1)!
    const inputB = nodes.get(2)!
    const gate = nodes.get(10)!
    const outputA = nodes.get(20)!
    const outputB = nodes.get(21)!

    expect(inputA.x).toBeCloseTo(inputB.x)
    expect(outputA.x + outputA.width).toBeCloseTo(outputB.x + outputB.width)
    expect(gate.x).toBeGreaterThan(
      Math.max(inputA.x + inputA.width, inputB.x + inputB.width),
    )
    expect(Math.min(outputA.x, outputB.x)).toBeGreaterThan(gate.x + gate.width)
    for (const edge of result.edges) {
      const inputEdge = input.edges[edge.inputIndex]
      const source = nodes.get(inputEdge.from)!
      const target = nodes.get(inputEdge.to)!
      expect(edge.points[0].x).toBeCloseTo(source.x + source.width)
      expect(edge.points.at(-1)!.x).toBeCloseTo(target.x)
      expect(target.x).toBeGreaterThan(source.x + source.width)
    }
  })

  it('keeps hidden control-only primary inputs on the shared left boundary', async () => {
    const subgraph: Subgraph = {
      nodes: [
        node(1, 'clk'),
        node(2, 'rst'),
        node(3, 'data'),
        node(10, 'state', {
          kind: 'cell',
          cell_type: 'FDRE',
          seq: true,
          register: true,
          controls: [
            { role: 'clock', pin: 'C', net_name: 'clk', driver_id: 1, fanout: 1 },
            { role: 'reset', pin: 'R', net_name: 'rst', driver_id: 2, fanout: 1 },
          ],
        }),
        node(20, 'result'),
      ],
      edges: [
        { from: 3, to: 10, from_port: 'data', to_port: 'D', net_name: 'data', bits: [1] },
        { from: 10, to: 20, from_port: 'Q', to_port: 'result', net_name: 'result', bits: [2] },
      ],
      truncated: false,
    }
    const input = prepareLayoutInput(subgraph)
    const result = interpretResult(input, await new ELK().layout(toElkGraph(input)))
    const nodes = new Map(result.nodes.map((candidate) => [candidate.id, candidate]))

    expect(nodes.get(1)!.x).toBeCloseTo(nodes.get(3)!.x)
    expect(nodes.get(2)!.x).toBeCloseTo(nodes.get(3)!.x)
    for (const edge of result.edges) {
      const inputEdge = input.edges[edge.inputIndex]
      const source = nodes.get(inputEdge.from)!
      const target = nodes.get(inputEdge.to)!
      expect(edge.points[0].x).toBeCloseTo(source.x + source.width)
      expect(edge.points.at(-1)!.x).toBeCloseTo(target.x)
    }
  })

  it('packs orphan-heavy views without producing an extreme vertical ribbon', async () => {
    const isolatedNodes = 128
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
          baseWidth: 76,
          baseHeight: 52,
          controlHeight: 0,
          register: false,
          boundary: 'internal',
        },
        {
          id: 3,
          baseWidth: 74,
          baseHeight: 34,
          controlHeight: 0,
          register: false,
          boundary: 'output',
        },
        {
          id: 4,
          baseWidth: 74,
          baseHeight: 34,
          controlHeight: 0,
          register: false,
          boundary: 'input',
        },
        ...Array.from({ length: isolatedNodes }, (_, index) => ({
          id: index + 10,
          baseWidth: 62,
          baseHeight: 46,
          controlHeight: 0,
          register: false,
          boundary: 'internal' as const,
        })),
      ],
      edges: [
        {
          from: 1,
          to: 2,
          fromPort: 'Y',
          toPort: 'A',
          control: false,
        },
        {
          from: 2,
          to: 3,
          fromPort: 'Y',
          toPort: 'A',
          control: false,
        },
      ],
    }

    const result = await new ELK().layout(toElkGraph(input, 'BRANDES_KOEPF'))

    expect(result.children).toHaveLength(isolatedNodes + 4)
    expect(result.height).toBeLessThan(5_000)
  })
})

describe('dense ELK layout policy', () => {
  it('returns bounded orthogonal geometry without crossing nodes', async () => {
    const nodeCount = DENSE_LAYOUT_NODE_THRESHOLD
    const edgeCount = 2_000
    const input: LayoutInput = {
      nodes: Array.from({ length: nodeCount }, (_, id) => ({
        id,
        baseWidth: 62,
        baseHeight: 46,
        controlHeight: 0,
        register: false,
        boundary: 'internal',
      })),
      edges: Array.from({ length: edgeCount }, (_, index) => ({
        from: index % (nodeCount / 2),
        to: nodeCount / 2 +
          ((index * 7 + Math.floor(index / (nodeCount / 2))) % (nodeCount / 2)),
        fromPort: `Y${index % 8}`,
        toPort: `A${Math.floor(index / (nodeCount / 2))}`,
        control: false,
      })),
    }
    const result = interpretResult(
      input,
      await new ELK().layout(toElkGraph(input, 'BRANDES_KOEPF')),
    )

    expect(result.nodes).toHaveLength(nodeCount)
    expect(result.edges).toHaveLength(edgeCount)
    const nodes = new Map(result.nodes.map((node) => [node.id, node]))
    let edgeNodeIntersections = 0
    for (const node of result.nodes) {
      expect(Number.isFinite(node.x) && node.x >= 0).toBe(true)
      expect(Number.isFinite(node.y) && node.y >= 0).toBe(true)
      expect(node.x + node.width).toBeLessThanOrEqual(result.width)
      expect(node.y + node.height).toBeLessThanOrEqual(result.height)
    }
    for (const edge of result.edges) {
      const inputEdge = input.edges[edge.inputIndex]
      const source = nodes.get(inputEdge.from)!
      const target = nodes.get(inputEdge.to)!
      expect(edge.points.length).toBeGreaterThanOrEqual(2)
      expect(edge.points[0].x).toBeCloseTo(source.x + source.width)
      expect(edge.points.at(-1)!.x).toBeCloseTo(target.x)
      for (let index = 1; index < edge.points.length; index += 1) {
        const previous = edge.points[index - 1]
        const point = edge.points[index]
        expect(point.x === previous.x || point.y === previous.y).toBe(true)
        for (const node of result.nodes) {
          if (node.id === inputEdge.from || node.id === inputEdge.to) continue
          const crossesInterior = previous.y === point.y
            ? node.x < Math.max(previous.x, point.x) &&
              Math.min(previous.x, point.x) < node.x + node.width &&
              node.y < point.y && point.y < node.y + node.height
            : node.y < Math.max(previous.y, point.y) &&
              Math.min(previous.y, point.y) < node.y + node.height &&
              node.x < point.x && point.x < node.x + node.width
          if (crossesInterior) edgeNodeIntersections += 1
        }
      }
    }
    expect(edgeNodeIntersections).toBe(0)
  }, 20_000)
})

describe('expanded group boundary routing', () => {
  // A tall reference keeps the group in one column; a short one forces the
  // lattice grid, where nets ride channels between the rows.
  for (const [shape, referenceHeight] of
    [['stacked', 1_000], ['grid', 170]] as const) {
  it(`routes every crossing net to its member pin (${shape})`, async () => {
    const BITS = 16
    const members = Array.from({ length: BITS }, (_, index) =>
      node(100 + index, 'count', {
        kind: 'cell',
        cell_type: 'FDRE',
        seq: true,
      }),
    )
    const drivers = Array.from({ length: BITS }, (_, index) =>
      node(200 + index, `d${index}`, { kind: 'cell', cell_type: '$_XOR_' }),
    )
    const sinks = Array.from({ length: BITS }, (_, index) =>
      node(300 + index, `s${index}`, { kind: 'cell', cell_type: '$_AND_' }),
    )
    const subgraph: Subgraph = {
      nodes: [
        node(1, 'clk', { port_direction: 'input' }),
        node(2, 'rst', { port_direction: 'input' }),
        node(3, 'en', { kind: 'cell', cell_type: '$_AND_' }),
        ...drivers,
        ...members,
        ...sinks,
      ],
      edges: members.flatMap((member, index) => [
        {
          from: drivers[index].id, to: member.id,
          from_port: 'Y', to_port: 'D', net_name: `d${index}`, bits: [index],
        },
        {
          from: 1, to: member.id, from_port: 'clk', to_port: 'C',
          net_name: 'clk', bits: [90], control: true,
        },
        {
          from: 2, to: member.id, from_port: 'rst', to_port: 'R',
          net_name: 'rst', bits: [91], control: true,
        },
        {
          from: 3, to: member.id, from_port: 'Y', to_port: 'E',
          net_name: 'en', bits: [92], control: true,
        },
        {
          from: member.id, to: sinks[index].id,
          from_port: 'Q', to_port: 'A', net_name: `q${index}`, bits: [index],
        },
      ]),
      truncated: false,
    }
    const input = prepareLayoutInput(subgraph, [{
      id: 500,
      members: members.map((member) => member.id),
      referenceHeight,
    }])
    const result = interpretResult(
      input,
      await new ELK().layout(toElkGraph(input)),
    )

    const frame = result.groups?.find((group) => group.id === 500)
    const laidOut = new Map(result.nodes.map((laid) => [laid.id, laid]))
    const memberIds = new Set(members.map((member) => member.id))
    expect(frame).toBeDefined()
    const insideFrame = (point: { x: number }) =>
      point.x >= frame!.x && point.x <= frame!.x + frame!.width

    let crossings = 0
    const entryHeights = new Set<number>()
    input.edges.forEach((edge, index) => {
      const entering = memberIds.has(edge.to) && !memberIds.has(edge.from)
      const leaving = memberIds.has(edge.from) && !memberIds.has(edge.to)
      if (!entering && !leaving) return
      crossings += 1
      const member = laidOut.get(entering ? edge.to : edge.from)!
      const points = result.edges[index].points
      const pin = entering ? points.at(-1)! : points[0]

      // Where the net meets the west edge of the frame.
      if (entering) {
        const crossing = points.find((point) => point.x >= frame!.x)
        if (crossing) entryHeights.add(Math.round(crossing.y))
      }

      // Every net terminates on its own member's pin.
      expect(pin.x).toBe(entering ? member.x : member.x + member.width)
      expect(pin.y).toBeGreaterThan(member.y)
      expect(pin.y).toBeLessThan(member.y + member.height)

      if (shape === 'stacked') {
        // One column: the net enters at its pin's height and goes straight in.
        // A perimeter-rail detour would leave the member's vertical band.
        for (const point of points) {
          if (!insideFrame(point)) continue
          expect(point.y).toBeGreaterThanOrEqual(member.y)
          expect(point.y).toBeLessThanOrEqual(member.y + member.height)
        }
      }

      for (let i = 1; i < points.length; i += 1) {
        const a = points[i - 1]
        const b = points[i]
        // Inside the frame every leg lies in reserved wire space: orthogonal,
        // and never across another member's cell.
        if (insideFrame(a) && insideFrame(b)) {
          expect(a.x === b.x || a.y === b.y).toBe(true)
        }
        for (const other of result.nodes) {
          if (other.id === edge.from || other.id === edge.to) continue
          if (!memberIds.has(other.id)) continue
          const overlaps =
            Math.max(a.x, b.x) > other.x &&
            Math.min(a.x, b.x) < other.x + other.width &&
            Math.max(a.y, b.y) > other.y &&
            Math.min(a.y, b.y) < other.y + other.height
          expect(overlaps).toBe(false)
        }
      }
    })
    expect(crossings).toBe(BITS * 5)

    const cells = members.flatMap((member) => {
      const laid = laidOut.get(member.id)
      return laid ? [laid] : []
    })
    const xs = [...new Set(cells.map((cell) => Math.round(cell.x)))]
      .sort((left, right) => left - right)
    const ys = [...new Set(cells.map((cell) => Math.round(cell.y)))]
      .sort((left, right) => left - right)

    // The defect this replaces funnelled every crossing net through one point
    // on the frame edge. Each net now meets the frame at its own height --
    // its channel track, or its pin.
    expect(entryHeights.size).toBeGreaterThan(ys.length)

    // The header band carries the group's label, so no wire may run through it.
    const labelBandBottom = frame!.y + 30
    input.edges.forEach((edge, index) => {
      if (memberIds.has(edge.to) === memberIds.has(edge.from)) return
      for (const point of result.edges[index].points) {
        if (!insideFrame(point)) continue
        expect(point.y).toBeGreaterThanOrEqual(labelBandBottom)
      }
    })

    if (shape === 'grid') {
      // A real lattice: a single column pitch and a single row pitch.
      expect(xs.length).toBeGreaterThan(1)
      expect(new Set(xs.slice(1).map((x, i) => x - xs[i])).size).toBe(1)
      expect(new Set(ys.slice(1).map((y, i) => y - ys[i])).size).toBe(1)
      // Uniform cells, so the block reads as an array.
      expect(new Set(cells.map((cell) => cell.width)).size).toBe(1)
      expect(new Set(cells.map((cell) => cell.height)).size).toBe(1)
    } else {
      expect(xs).toHaveLength(1)
    }
  }, 30_000)
  }
})

describe('expanded grid lattice', () => {
  // Partial last rows and odd member counts must not break the lattice: the
  // block only reads as an array if one column pitch and one row pitch cover
  // every cell.
  it.each([
    [7, 120], [13, 140], [16, 140], [17, 140], [32, 200],
  ])('keeps a uniform lattice for %i members', async (count, referenceHeight) => {
    const cellsIn = Array.from({ length: count }, (_, index) =>
      node(100 + index, `lut_${index}`, {
        kind: 'cell',
        cell_type: 'SB_LUT4',
      }),
    )
    const subgraph: Subgraph = {
      nodes: [
        node(1, 'a', { port_direction: 'input' }),
        node(2, 'b', { port_direction: 'input' }),
        ...cellsIn,
        node(3, 'y', { port_direction: 'output' }),
      ],
      edges: cellsIn.flatMap((member, index) => [
        { from: 1, to: member.id, from_port: 'a', to_port: 'I1',
          net_name: `a${index}`, bits: [index] },
        { from: 2, to: member.id, from_port: 'b', to_port: 'I2',
          net_name: `b${index}`, bits: [100 + index] },
        { from: member.id, to: 3, from_port: 'O', to_port: 'y',
          net_name: `y${index}`, bits: [200 + index] },
      ]),
      truncated: false,
    }
    const input = prepareLayoutInput(subgraph, [{
      id: 500,
      members: cellsIn.map((member) => member.id),
      referenceHeight,
    }])
    const memberIds = new Set(cellsIn.map((member) => member.id))
    const result = interpretResult(
      input,
      await new ELK().layout(toElkGraph(input)),
    )
    const cells = result.nodes.filter((laid) => memberIds.has(laid.id))
    const xs = [...new Set(cells.map((cell) => cell.x))]
      .sort((left, right) => left - right)
    const ys = [...new Set(cells.map((cell) => cell.y))]
      .sort((left, right) => left - right)

    expect(new Set(xs.slice(1).map((x, i) => x - xs[i])).size).toBe(1)
    expect(new Set(ys.slice(1).map((y, i) => y - ys[i])).size).toBe(1)
    expect(new Set(cells.map((cell) => cell.width)).size).toBe(1)
    expect(new Set(cells.map((cell) => cell.height)).size).toBe(1)
    expect(xs.length * ys.length).toBeGreaterThanOrEqual(count)
  }, 30_000)
})

describe('expanded grid fanout bundling', () => {
  // Build a grid group of `count` members. `shared` decides whether one driver
  // pin feeds every member (one net fanning out) or each member gets its own
  // driver pin (`count` independent nets).
  const build = async (count: number, shared: boolean, referenceHeight = 140) => {
    const cells = Array.from({ length: count }, (_, index) =>
      node(100 + index, `lut_${index}`, {
        kind: 'cell',
        cell_type: 'SB_LUT4',
      }),
    )
    const subgraph: Subgraph = {
      nodes: [
        node(1, 'drv', { port_direction: 'input' }),
        ...cells,
        node(90, 'y', { port_direction: 'output' }),
      ],
      edges: cells.flatMap((member, index) => [
        {
          from: 1,
          to: member.id,
          from_port: shared ? 'Y' : `Y${index}`,
          to_port: 'I1',
          net_name: shared ? 'bus' : `n${index}`,
          bits: [shared ? 1 : index],
        },
        {
          from: member.id, to: 90, from_port: 'O', to_port: 'y',
          net_name: `y${index}`, bits: [900 + index],
        },
      ]),
      truncated: false,
    }
    const input = prepareLayoutInput(subgraph, [{
      id: 500,
      members: cells.map((member) => member.id),
      referenceHeight,
    }])
    const result = interpretResult(
      input,
      await new ELK().layout(toElkGraph(input)),
    )
    const frame = (result.groups ?? []).find((group) => group.id === 500)
    expect(frame).toBeDefined()
    const laidOut = new Map(result.nodes.map((laid) => [laid.id, laid]))
    const memberIds = new Set(cells.map((member) => member.id))
    return { input, result, frame: frame!, laidOut, memberIds }
  }

  it('gives a fanout net one track per row instead of one per sink', async () => {
    const { input, result, frame, laidOut, memberIds } = await build(16, true)

    const members = [...memberIds].map((id) => laidOut.get(id)!)
    const rowCount = new Set(members.map((member) => member.y)).size
    const firstColumnX = Math.min(...members.map((member) => member.x))

    // Members in the first column are reached straight from the frame edge and
    // need no track. Every other member's net must ride one.
    const trackYs: number[] = []
    let needingTrack = 0
    input.edges.forEach((edge, index) => {
      if (!memberIds.has(edge.to) || memberIds.has(edge.from)) return
      const member = laidOut.get(edge.to)!
      if (member.x <= firstColumnX) return
      needingTrack += 1
      // The track is the long horizontal run that carries the net across the
      // frame; the short one at the end is just the hop onto the pin. Pick the
      // horizontal segment with the most travel inside the frame.
      const points = result.edges[index].points
      let best = { span: 0, y: Number.NaN }
      for (let i = 0; i + 1 < points.length; i += 1) {
        const [a, b] = [points[i], points[i + 1]]
        if (Math.abs(a.y - b.y) > 0.5) continue
        const span =
          Math.min(Math.max(a.x, b.x), frame.x + frame.width) -
          Math.max(Math.min(a.x, b.x), frame.x)
        if (span > best.span) best = { span, y: a.y }
      }
      if (Number.isFinite(best.y)) trackYs.push(Math.round(best.y))
    })

    expect(needingTrack).toBeGreaterThan(rowCount)
    // The whole point: sinks of one net share a track. Before bundling this was
    // one distinct track per sink, so this count equalled `needingTrack`.
    expect(new Set(trackYs).size).toBeLessThanOrEqual(rowCount)
    expect(new Set(trackYs).size).toBeLessThan(needingTrack)
  }, 30_000)

  it('keeps distinct bus slices from one driver pin on separate tracks', async () => {
    // A grouped bus driver emits one edge per sink from the same pin, each
    // carrying a different slice. Those are different nets: sharing a track
    // would draw them as one wire and claim they are connected.
    const cells = Array.from({ length: 16 }, (_, index) =>
      node(100 + index, `lut_${index}`, {
        kind: 'cell',
        cell_type: 'SB_LUT4',
      }),
    )
    const subgraph: Subgraph = {
      nodes: [
        node(1, 'bus', { port_direction: 'input' }),
        ...cells,
        node(90, 'y', { port_direction: 'output' }),
      ],
      edges: cells.flatMap((member, index) => [
        {
          // Same driver pin for every sink, but a distinct bit each.
          from: 1, to: member.id, from_port: 'Q', to_port: 'I1',
          net_name: `bus[${index}]`, bits: [index],
        },
        {
          from: member.id, to: 90, from_port: 'O', to_port: 'y',
          net_name: `q${index}`, bits: [500 + index],
        },
      ]),
      truncated: false,
    }
    const input = prepareLayoutInput(subgraph, [{
      id: 500,
      members: cells.map((member) => member.id),
      referenceHeight: 140,
    }])
    const result = interpretResult(
      input,
      await new ELK().layout(toElkGraph(input)),
    )
    const frame = (result.groups ?? []).find((group) => group.id === 500)!
    const laidOut = new Map(result.nodes.map((laid) => [laid.id, laid]))
    const memberIds = new Set(cells.map((member) => member.id))
    const members = [...memberIds].map((id) => laidOut.get(id)!)
    const firstColumnX = Math.min(...members.map((member) => member.x))

    const trackYs: number[] = []
    input.edges.forEach((edge, index) => {
      if (!memberIds.has(edge.to) || memberIds.has(edge.from)) return
      const member = laidOut.get(edge.to)!
      if (member.x <= firstColumnX) return
      const points = result.edges[index].points
      let best = { span: 0, y: Number.NaN }
      for (let i = 0; i + 1 < points.length; i += 1) {
        const [a, b] = [points[i], points[i + 1]]
        if (Math.abs(a.y - b.y) > 0.5) continue
        const span =
          Math.min(Math.max(a.x, b.x), frame.x + frame.width) -
          Math.max(Math.min(a.x, b.x), frame.x)
        if (span > best.span) best = { span, y: a.y }
      }
      if (Number.isFinite(best.y)) trackYs.push(Math.round(best.y))
    })

    expect(trackYs.length).toBeGreaterThan(0)
    // Every slice is its own net, so no two may share a track.
    expect(new Set(trackYs).size).toBe(trackYs.length)
  }, 30_000)

  it('keeps a fanout group shorter than the same group with private nets', async () => {
    const [shared, private_] = await Promise.all([
      build(16, true),
      build(16, false),
    ])
    expect(shared.frame.height).toBeLessThan(private_.frame.height)
  }, 30_000)

  it('lands every net on its pin when member widths differ', async () => {
    // Column count is derived from member width and is computed twice: once in
    // toElkGraph to place the ports, once in interpretResult to place the cells.
    // Uniform members hide any disagreement, so vary the label widths.
    const cells = Array.from({ length: 20 }, (_, index) =>
      node(100 + index, 'x'.repeat(1 + (index % 7) * 9), {
        kind: 'cell',
        cell_type: 'SB_LUT4',
      }),
    )
    const subgraph: Subgraph = {
      nodes: [
        node(1, 'd', { port_direction: 'input' }),
        ...cells,
        node(90, 'y', { port_direction: 'output' }),
      ],
      edges: cells.flatMap((member, index) => [
        {
          from: 1, to: member.id, from_port: `Y${index}`, to_port: 'I1',
          net_name: `n${index}`, bits: [index],
        },
        {
          from: member.id, to: 90, from_port: 'O', to_port: 'y',
          net_name: `q${index}`, bits: [500 + index],
        },
      ]),
      truncated: false,
    }
    const input = prepareLayoutInput(subgraph, [{
      id: 500,
      members: cells.map((member) => member.id),
      referenceHeight: 140,
    }])
    const result = interpretResult(
      input,
      await new ELK().layout(toElkGraph(input)),
    )
    const laidOut = new Map(result.nodes.map((laid) => [laid.id, laid]))
    const memberIds = new Set(cells.map((member) => member.id))

    const misplaced: unknown[] = []
    let checked = 0
    input.edges.forEach((edge, index) => {
      const entering = memberIds.has(edge.to) && !memberIds.has(edge.from)
      const leaving = memberIds.has(edge.from) && !memberIds.has(edge.to)
      if (!entering && !leaving) return
      checked += 1
      const member = laidOut.get(entering ? edge.to : edge.from)!
      const points = result.edges[index].points
      const pin = entering ? points.at(-1)! : points[0]
      const wantX = entering ? member.x : member.x + member.width
      if (Math.abs(pin.x - wantX) > 1.5) {
        misplaced.push({ id: member.id, pinX: pin.x, wantX })
      }
      if (pin.y < member.y - 1 || pin.y > member.y + member.height + 1) {
        misplaced.push({ id: member.id, pinY: pin.y, top: member.y })
      }
    })
    expect(checked).toBe(40)
    expect(misplaced).toEqual([])
  }, 30_000)

  it('sizes a grid group independently of the reference height', async () => {
    // Once a group is a grid, `EXPANDED_GROUP_VERTICAL_LIMIT_MULTIPLIER` has no
    // further say: channel height is set by how many nets cross, not by the
    // reference, so pretending to solve for a height target only distorted the
    // shape. Both references below are small enough to force a grid.
    const [tight, loose] = await Promise.all([
      build(16, true, 140),
      build(16, true, 200),
    ])
    expect(tight.frame.height).toBe(loose.frame.height)
    expect(tight.frame.width).toBe(loose.frame.width)
  }, 30_000)
})
}
