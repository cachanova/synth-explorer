import ELK from 'elkjs/lib/elk.bundled.js'
import { describe, expect, it } from 'vitest'
import type { GraphNode, Subgraph } from '../../types'
import {
  DENSE_LAYOUT_NODE_THRESHOLD,
  interpretResult,
  prepareLayoutInput,
  toElkGraph,
  type LayoutInput,
} from './layout'

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
