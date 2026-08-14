import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GraphView } from './GraphView'
describe('GraphView LUT labels', () => {
  it('tags nodes and edges by relevance independently of overlay highlighting', () => {
    const markup = renderToStaticMarkup(
      <GraphView
        graph={{
          nodes: [
            {
              id: 1,
              x: 0,
              y: 0,
              width: 76,
              height: 52,
              node: { id: 1, kind: 'cell', name: 'relevant', cell_type: '$_AND_' },
            },
            {
              id: 2,
              x: 140,
              y: 0,
              width: 76,
              height: 52,
              node: { id: 2, kind: 'cell', name: 'context', cell_type: '$_OR_' },
            },
          ],
          edges: [
            {
              from: 1,
              to: 2,
              points: [
                { x: 76, y: 26 },
                { x: 140, y: 26 },
              ],
              edge: {
                from: 1,
                to: 2,
                from_port: 'Y',
                to_port: 'A',
                net_name: 'context_edge',
                bits: [1, 2],
              },
            },
          ],
          width: 216,
          height: 52,
        }}
        rootId={1}
        overlayIds={new Set([1])}
        relevantIds={new Set([1])}
        selectedId={null}
        interactive={false}
        onSelect={() => undefined}
        active={false}
        fitNonce={0}
      />,
    )

    expect(markup).toMatch(/g-node-body[^>]*data-relevant="1"/)
    expect(markup).toMatch(/g-node-body[^>]*data-relevant="0"/)
    expect(markup).toMatch(/<path class="g-edge bus"[^>]*data-relevant="0"/)
    expect(markup).toMatch(
      /<text class="g-bus-label"[^>]*data-relevant="0"[^>]*>2<\/text>/,
    )
    expect(markup).not.toContain('<title>context_edge (2 bits): Y→A</title>')
    expect(markup).not.toContain('g-edge-wrap')
    expect(markup).toMatch(/g-node-body[^>]*\bhl\b/)
  })

  it('highlights the exact Yosys net bits selected from source', () => {
    const graph = {
      nodes: [
        {
          id: 1,
          x: 0,
          y: 0,
          width: 76,
          height: 52,
          node: { id: 1, kind: 'cell' as const, name: 'driver', cell_type: '$_BUF_' },
        },
        {
          id: 2,
          x: 140,
          y: 0,
          width: 76,
          height: 52,
          node: { id: 2, kind: 'cell' as const, name: 'first', cell_type: '$_BUF_' },
        },
        {
          id: 3,
          x: 140,
          y: 80,
          width: 76,
          height: 52,
          node: { id: 3, kind: 'cell' as const, name: 'second', cell_type: '$_BUF_' },
        },
      ],
      edges: [
        {
          from: 1,
          to: 2,
          points: [{ x: 76, y: 26 }, { x: 140, y: 26 }],
          edge: {
            from: 1,
            to: 2,
            from_port: 'Y',
            to_port: 'A',
            net_name: 'first_net',
            bits: [41],
          },
        },
        {
          from: 1,
          to: 3,
          points: [{ x: 76, y: 26 }, { x: 140, y: 106 }],
          edge: {
            from: 1,
            to: 3,
            from_port: 'Y',
            to_port: 'A',
            net_name: 'second_net',
            bits: [42],
          },
        },
      ],
      width: 216,
      height: 132,
    }
    const markup = renderToStaticMarkup(
      <GraphView
        graph={graph}
        rootId={-1}
        overlayIds={new Set(graph.nodes.map((node) => node.id))}
        highlightedBits={new Set([41])}
        relevantIds={new Set(graph.nodes.map((node) => node.id))}
        selectedId={null}
        interactive={false}
        onSelect={() => undefined}
        active={false}
        fitNonce={0}
      />,
    )

    const highlighted = markup.match(
      /<path class="g-edge(?: [^"]*)?\bhl\b[^"]*"[^>]*data-edge-count="\d+"[^>]*>/g,
    ) ?? []
    expect(highlighted).toHaveLength(1)
    expect(highlighted[0]).toContain('data-edge-count="1"')
  })

  it('highlights only the visible input and output wires connected to the selected node', () => {
    const graph = {
      nodes: [
        {
          id: 1,
          x: 0,
          y: 0,
          width: 76,
          height: 52,
          node: { id: 1, kind: 'port' as const, name: 'input' },
        },
        {
          id: 2,
          x: 140,
          y: 0,
          width: 76,
          height: 52,
          node: { id: 2, kind: 'cell' as const, name: 'selected', cell_type: '$_AND_' },
        },
        {
          id: 3,
          x: 280,
          y: 0,
          width: 76,
          height: 52,
          node: { id: 3, kind: 'port' as const, name: 'output' },
        },
      ],
      edges: [
        laidOutEdge(1, 2, 'selected_input'),
        laidOutEdge(2, 3, 'selected_output'),
        laidOutEdge(1, 3, 'unrelated'),
      ],
      width: 356,
      height: 52,
    }
    const markup = renderToStaticMarkup(
      <GraphView
        graph={graph}
        rootId={-1}
        overlayIds={new Set()}
        relevantIds={new Set()}
        selectedId={2}
        interactive={false}
        onSelect={() => undefined}
        active={false}
        fitNonce={0}
      />,
    )

    expect(selectedEdgeIndexes(markup)).toEqual([0, 1])
    expect(markup).toContain('data-selected-edge-count="2"')
  })

  it('highlights every visible segment of the selected net name', () => {
    const graph = {
      nodes: [1, 2, 3, 4].map((id) => ({
        id,
        x: id * 100,
        y: 0,
        width: 76,
        height: 52,
        node: { id, kind: 'cell' as const, name: `node${id}`, cell_type: '$_AND_' },
      })),
      edges: [
        laidOutEdge(1, 2, 'shared'),
        laidOutEdge(2, 3, 'shared'),
        laidOutEdge(3, 4, 'other'),
      ],
      width: 500,
      height: 52,
    }
    const markup = renderToStaticMarkup(
      <GraphView
        graph={graph}
        rootId={-1}
        overlayIds={new Set()}
        relevantIds={new Set()}
        selectedId={null}
        selectedNetNames={['shared']}
        interactive={false}
        onSelect={() => undefined}
        active={false}
        fitNonce={0}
      />,
    )

    expect(selectedEdgeIndexes(markup)).toEqual([0, 1])
  })

  it('dims unrelated nodes and edges while selected and clears dimming on deselect', () => {
    const graph = {
      nodes: [1, 2, 3, 4].map((id) => ({
        id,
        x: id * 100,
        y: id > 2 ? 80 : 0,
        width: 76,
        height: 52,
        node: {
          id,
          kind: 'cell' as const,
          name: `node${id}`,
          cell_type: '$_BUF_',
        },
      })),
      edges: [
        laidOutEdge(1, 2, 'selected_component'),
        laidOutEdge(3, 4, 'disconnected_component'),
      ],
      width: 500,
      height: 132,
    }
    const renderGraph = (selectedId: number | null) => renderToStaticMarkup(
      <GraphView
        graph={graph}
        rootId={-1}
        overlayIds={new Set()}
        relevantIds={new Set()}
        selectedId={selectedId}
        interactive={false}
        onSelect={() => undefined}
        active={false}
        fitNonce={0}
      />,
    )

    const selectedMarkup = renderGraph(2)
    const nodeTags =
      selectedMarkup.match(/<g[^>]*class="g-node-body[^>]*>/g) ?? []
    const nodeTag = (nodeId: number) =>
      nodeTags.find((tag) => tag.includes(`data-node-id="${nodeId}"`))
    expect(nodeTag(1)).not.toContain('g-dimmed')
    expect(nodeTag(2)).not.toContain('g-dimmed')
    expect(nodeTag(3)).toContain('g-dimmed')
    expect(nodeTag(4)).toContain('g-dimmed')
    expect(selectedMarkup).toMatch(
      /<path class="g-edge g-dimmed"[^>]*data-edge-count="1"/,
    )

    const deselectedMarkup = renderGraph(null)
    expect(deselectedMarkup).not.toContain('g-dimmed')
  })

  it('highlights visible wires represented by a selected grouped node', () => {
    const markup = renderToStaticMarkup(
      <GraphView
        graph={{
          nodes: [
            {
              id: 1,
              x: 0,
              y: 0,
              width: 76,
              height: 52,
              node: { id: 1, kind: 'port', name: 'input' },
            },
            {
              id: 100,
              x: 140,
              y: 0,
              width: 76,
              height: 52,
              node: {
                id: 100,
                kind: 'cell',
                name: 'mux',
                cell_type: '$_MUX_',
                member_count: 2,
                members: [2, 3],
              },
            },
            {
              id: 4,
              x: 280,
              y: 0,
              width: 76,
              height: 52,
              node: { id: 4, kind: 'port', name: 'output' },
            },
          ],
          edges: [
            laidOutEdge(1, 2, 'group_input'),
            laidOutEdge(3, 4, 'group_output'),
            laidOutEdge(1, 4, 'unrelated'),
          ],
          width: 356,
          height: 52,
        }}
        rootId={-1}
        overlayIds={new Set()}
        relevantIds={new Set()}
        selectedId={100}
        interactive={false}
        onSelect={() => undefined}
        active={false}
        fitNonce={0}
      />,
    )

    expect(selectedEdgeIndexes(markup)).toEqual([0, 1])
  })

  it('includes visible control wires without highlighting unrelated controls', () => {
    const graph = {
      nodes: [
        {
          id: 1,
          x: 0,
          y: 0,
          width: 76,
          height: 52,
          node: { id: 1, kind: 'port' as const, name: 'data' },
        },
        {
          id: 2,
          x: 140,
          y: 0,
          width: 92,
          height: 58,
          node: {
            id: 2,
            kind: 'cell' as const,
            name: 'selected_reg',
            cell_type: '$_DFF_P_',
            seq: true,
            register: true,
          },
        },
        {
          id: 3,
          x: 0,
          y: 90,
          width: 76,
          height: 52,
          node: { id: 3, kind: 'port' as const, name: 'clk' },
        },
        {
          id: 4,
          x: 280,
          y: 0,
          width: 76,
          height: 52,
          node: { id: 4, kind: 'port' as const, name: 'output' },
        },
        {
          id: 5,
          x: 140,
          y: 90,
          width: 92,
          height: 58,
          node: {
            id: 5,
            kind: 'cell' as const,
            name: 'other_reg',
            cell_type: '$_DFF_P_',
            seq: true,
            register: true,
          },
        },
      ],
      edges: [
        laidOutEdge(1, 2, 'data_input'),
        {
          ...laidOutEdge(3, 2, 'selected_clock'),
          edge: { ...laidOutEdge(3, 2, 'selected_clock').edge, control: true },
        },
        laidOutEdge(2, 4, 'data_output'),
        {
          ...laidOutEdge(3, 5, 'unrelated_clock'),
          edge: { ...laidOutEdge(3, 5, 'unrelated_clock').edge, control: true },
        },
      ],
      width: 356,
      height: 148,
    }
    const markup = renderToStaticMarkup(
      <GraphView
        graph={graph}
        rootId={-1}
        overlayIds={new Set()}
        relevantIds={new Set()}
        selectedId={2}
        interactive={false}
        onSelect={() => undefined}
        active={false}
        fitNonce={0}
      />,
    )

    expect(selectedEdgeIndexes(markup)).toEqual([0, 1, 2])
    expect(markup).toMatch(
      /class="g-edge control hl"[^>]*data-selected-edge-indices="1"/,
    )
  })

  it('highlights boundary and interior nets without context-logic branch bleed', () => {
    const props = {
      graph: boundaryHighlightGraph(),
      rootId: -1,
      overlayIds: new Set([2, 5]),
      relevantIds: new Set([1, 2, 3, 4, 5]),
      selectedId: null,
      interactive: false,
      onSelect: () => undefined,
      active: false,
      fitNonce: 0,
    }
    const markup = renderToStaticMarkup(
      <GraphView {...props} extendOverlayToBoundaryNets />,
    )

    const edgeTags = markup.match(
      /<path class="g-edge(?: [^"]*)?"[^>]*data-edge-count="\d+"[^>]*>/g,
    ) ?? []
    expect(edgeTags).toHaveLength(2)
    expect(edgeTags.find((tag) => tag.includes('class="g-edge hl"'))).toContain(
      'data-edge-count="3"',
    )
    expect(edgeTags.find((tag) => tag.includes('class="g-edge"'))).toContain(
      'data-edge-count="1"',
    )

    const pathMarkup = renderToStaticMarkup(<GraphView {...props} />)
    const pathEdgeTags = pathMarkup.match(
      /<path class="g-edge(?: [^"]*)?"[^>]*data-edge-count="\d+"[^>]*>/g,
    ) ?? []
    expect(pathEdgeTags).toHaveLength(2)
    expect(pathEdgeTags.find((tag) => tag.includes('class="g-edge hl"'))).toContain(
      'data-edge-count="1"',
    )
    expect(pathEdgeTags.find((tag) => tag.includes('class="g-edge"'))).toContain(
      'data-edge-count="3"',
    )
  })

  it('batches edge geometry and exposes one accessible connection-layer summary', () => {
    const graph = boundaryHighlightGraph()
    const markup = renderToStaticMarkup(
      <GraphView
        graph={graph}
        rootId={-1}
        overlayIds={new Set([2, 5])}
        relevantIds={new Set([1, 2, 3, 4, 5])}
        selectedId={null}
        interactive={false}
        onSelect={() => undefined}
        active={false}
        fitNonce={0}
        extendOverlayToBoundaryNets
      />,
    )

    const edgeBatches = markup.match(
      /<path class="g-edge(?: [^"]*)?"[^>]*data-edge-count="\d+"[^>]*>/g,
    ) ?? []
    expect(edgeBatches.length).toBeLessThan(graph.edges.length)
    expect(
      edgeBatches.reduce((count, tag) => {
        const batchCount = /data-edge-count="(\d+)"/.exec(tag)?.[1]
        return count + Number(batchCount ?? 0)
      }, 0),
    ).toBe(graph.edges.length)
    const arrowBatches = markup.match(
      /<path class="g-edge-arrows[^"]*"[^>]*data-arrow-count="\d+"[^>]*>/g,
    ) ?? []
    expect(
      arrowBatches.reduce((count, tag) => {
        const batchCount = /data-arrow-count="(\d+)"/.exec(tag)?.[1]
        return count + Number(batchCount ?? 0)
      }, 0),
    ).toBe(graph.edges.length)
    expect(markup).toContain(
      'aria-label="4 schematic connections. Inspect nodes for accessible fanin and fanout details."',
    )
  })

  it('recreates terminal markers from the last non-zero segment and fallback route', () => {
    const edge = (points: Array<{ x: number; y: number }>, netName: string) => ({
      from: 1,
      to: 2,
      points,
      edge: {
        from: 1,
        to: 2,
        from_port: 'Y',
        to_port: 'A',
        net_name: netName,
        bits: [1],
      },
    })
    const markup = renderToStaticMarkup(
      <GraphView
        graph={{
          nodes: [
            {
              id: 1,
              x: 0,
              y: 0,
              width: 10,
              height: 10,
              node: { id: 1, kind: 'cell', name: 'from', cell_type: 'BUF' },
            },
            {
              id: 2,
              x: 100,
              y: 0,
              width: 10,
              height: 10,
              node: { id: 2, kind: 'cell', name: 'to', cell_type: 'BUF' },
            },
          ],
          edges: [
            edge([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 0 }], 'repeated'),
            edge([{ x: 20, y: 20 }, { x: 20, y: 20 }], 'degenerate'),
            edge([], 'fallback'),
          ],
          width: 110,
          height: 20,
        }}
        rootId={-1}
        overlayIds={new Set()}
        relevantIds={new Set()}
        selectedId={null}
        interactive={false}
        onSelect={() => undefined}
        active={false}
        fitNonce={0}
      />,
    )

    expect(markup).toContain('data-edge-count="3"')
    expect(markup).toContain('data-arrow-count="2"')
    expect(markup).toContain('M 10 5 L 100 5')
    expect(markup).toContain('M 41.81 4.55 L 50.91 0 L 41.81 -4.55 Z')
    expect(markup).toContain('M 91.81 9.55 L 100.91 5 L 91.81 0.4500000000000002 Z')
  })

})
function selectedEdgeIndexes(markup: string): number[] {
  return [...markup.matchAll(/data-selected-edge-indices="([^"]+)"/g)]
    .flatMap((match) => match[1].split(',').map(Number))
    .sort((left, right) => left - right)
}

function laidOutEdge(from: number, to: number, netName: string) {
  return {
    from,
    to,
    points: [
      { x: 76, y: 26 },
      { x: 140, y: 26 },
    ],
    edge: {
      from,
      to,
      from_port: 'Y',
      to_port: 'A',
      net_name: netName,
      bits: [1],
    },
  }
}

function boundaryHighlightGraph() {
  return {
    nodes: [
      {
        id: 1,
        x: 0,
        y: 0,
        width: 76,
        height: 52,
        node: { id: 1, kind: 'port' as const, name: 'response_valid' },
      },
      {
        id: 2,
        x: 140,
        y: 0,
        width: 76,
        height: 52,
        node: { id: 2, kind: 'cell' as const, name: 'selected', cell_type: '$_AND_' },
      },
      {
        id: 3,
        x: 280,
        y: 0,
        width: 76,
        height: 52,
        node: { id: 3, kind: 'port' as const, name: 'done' },
      },
      {
        id: 4,
        x: 280,
        y: 80,
        width: 76,
        height: 52,
        node: { id: 4, kind: 'cell' as const, name: 'context', cell_type: '$_OR_' },
      },
      {
        id: 5,
        x: 280,
        y: 160,
        width: 76,
        height: 52,
        node: { id: 5, kind: 'cell' as const, name: 'interior', cell_type: '$_XOR_' },
      },
    ],
    edges: [
      laidOutEdge(1, 2, 'input_net'),
      laidOutEdge(2, 3, 'output_net'),
      laidOutEdge(2, 4, 'context_branch'),
      laidOutEdge(2, 5, 'interior_net'),
    ],
    width: 356,
    height: 212,
  }
}
