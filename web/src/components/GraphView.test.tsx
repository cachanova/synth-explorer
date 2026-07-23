import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GraphView } from './GraphView'

describe('GraphView LUT labels', () => {
  it('preserves the raw Vivado instance identity in the node tooltip', () => {
    const markup = renderToStaticMarkup(
      <GraphView
        graph={{
          nodes: [{
            id: 1,
            x: 0,
            y: 0,
            width: 98,
            height: 58,
            node: {
              id: 1,
              kind: 'cell',
              name: 'one_hot_OBUF[3]_inst_i_1',
              cell_type: 'CARRY4',
            },
          }],
          edges: [],
          width: 98,
          height: 58,
        }}
        rootId={-1}
        relevantIds={new Set()}
        overlayIds={new Set()}
        selectedId={null}
        interactive={false}
        onSelect={() => undefined}
        active={false}
        fitNonce={0}
      />,
    )

    expect(markup).toContain(
      'data-node-tooltip="CARRY4 — one_hot[3] (one_hot_OBUF[3]_inst_i_1)"',
    )
  })

  it('uses the carry-chain shape, badge, and color for carry primitives', () => {
    const markup = renderToStaticMarkup(
      <GraphView
        graph={{
          nodes: [{
            id: 1,
            x: 0,
            y: 0,
            width: 96,
            height: 58,
            node: { id: 1, kind: 'cell', name: 'carry', cell_type: 'CARRY4' },
          }],
          edges: [],
          width: 96,
          height: 58,
        }}
        rootId={-1}
        relevantIds={new Set()}
        overlayIds={new Set()}
        selectedId={null}
        interactive={false}
        onSelect={() => undefined}
        active={false}
        fitNonce={0}
      />,
    )

    expect(markup).toContain('g-symbol-carry')
    expect(markup).toContain('stroke="var(--green)"')
    expect(markup).toContain('color-mix(in srgb, var(--green) 10%, var(--bg-2))')
    expect(markup).toContain('>CARRY<')
  })

  it('draws primitive pin labels at the same canonical positions used by layout', () => {
    const markup = renderToStaticMarkup(
      <GraphView
        graph={{
          nodes: [{
            id: 4,
            x: 200,
            y: 80,
            width: 112,
            height: 75,
            node: {
              id: 4,
              kind: 'cell',
              name: 'memory',
              cell_type: 'RAM32M',
              seq: true,
              register: false,
              controls: [
                { role: 'clock', pin: 'WCLK', net_name: 'clk', driver_id: 8, fanout: 1 },
              ],
            },
          }],
          edges: [
            laidOutPrimitiveEdge(1, 4, 'WE'),
            laidOutPrimitiveEdge(2, 4, 'ADDR'),
            laidOutPrimitiveEdge(3, 4, 'WDATA'),
          ],
          width: 312,
          height: 155,
        }}
        rootId={-1}
        relevantIds={new Set()}
        overlayIds={new Set()}
        selectedId={4}
        interactive={false}
        onSelect={() => undefined}
        active={false}
        fitNonce={0}
      />,
    )

    expect(markup).toContain('<text x="8" y="18.5">ADDR</text>')
    expect(markup).toContain('<text x="8" y="34">WDATA</text>')
    expect(markup).toContain('<text x="8" y="49.5">WE</text>')
    expect(markup).toMatch(
      /<g class="g-pin-overlay"[^>]*data-graph-node-id="4"/,
    )
  })

  it('renders grouped physical memory primitives as one stacked memory symbol', () => {
    const markup = renderToStaticMarkup(
      <GraphView
        graph={{
          nodes: [{
            id: 20,
            x: 0,
            y: 0,
            width: 140,
            height: 62,
            node: {
              id: 20,
              kind: 'cell',
              name: 'memory [128×16]',
              cell_type: 'RAM64M',
              seq: true,
              register: false,
              width: 12,
              member_count: 12,
              members: Array.from({ length: 12 }, (_, index) => index + 1),
            },
          }],
          edges: [],
          width: 140,
          height: 62,
        }}
        rootId={-1}
        relevantIds={new Set()}
        overlayIds={new Set()}
        selectedId={20}
        interactive={false}
        onSelect={() => undefined}
        active
        fitNonce={0}
      />,
    )

    expect(markup).toContain('g-symbol-memory')
    expect(markup.match(/class="g-symbol-stack"/g)).toHaveLength(2)
    expect(markup).toContain('data-member-count="12"')
    expect(markup).toContain('>RAM64M<')
    expect(markup).toContain('>memory [128×16]<')
    expect(markup).toContain('>×12<')
  })

  it('keeps grouped memory shape and primitive count in compact detail and the overview shell', () => {
    const markup = renderToStaticMarkup(
      <GraphView
        graph={{
          nodes: [{
            id: 20,
            x: 120,
            y: 120,
            width: 180,
            height: 62,
            node: {
              id: 20,
              kind: 'cell',
              name: 'fifo.bank [64×16]',
              cell_type: '$mem',
              seq: true,
              register: false,
              width: 3,
              member_count: 3,
            },
          }],
          edges: [],
          width: 1600,
          height: 1000,
        }}
        rootId={-1}
        relevantIds={new Set()}
        overlayIds={new Set()}
        selectedId={null}
        interactive={false}
        onSelect={() => undefined}
        active={false}
        fitNonce={0}
      />,
    )

    expect(markup).toContain('>MEM<')
    expect(markup).toContain('>fifo.bank [64×16]<')
    expect(markup).toContain('>×3<')
    expect(markup).toContain('g-memory-group-detail')
    expect(markup).toContain('g-memory-overview-details')
  })

  it('renders only the grouped count and no decorative LUT separators', () => {
    const markup = renderToStaticMarkup(
      <GraphView
        graph={{
          nodes: [{
            id: 1,
            x: 0,
            y: 0,
            width: 84,
            height: 54,
            node: {
              id: 1,
              kind: 'cell',
              name: 'LUT2 ×3',
              cell_type: 'LUT2',
              width: 3,
              members: [1, 2, 3],
            },
          }],
          edges: [],
          width: 84,
          height: 54,
        }}
        rootId={1}
        relevantIds={new Set()}
        overlayIds={new Set()}
        selectedId={null}
        interactive={false}
        onSelect={() => undefined}
        active={false}
        fitNonce={0}
      />,
    )

    expect(markup).toContain('>LUT2<')
    expect(markup).toContain('>×3<')
    expect(markup).not.toContain('>LUT2 ×3<')
    expect(markup).not.toContain('g-lut-detail')
  })

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

  it('does not render a generated driving-net suffix as a node subtitle', () => {
    const markup = renderToStaticMarkup(
      <GraphView
        graph={{
          nodes: [{
            id: 1,
            x: 0,
            y: 0,
            width: 84,
            height: 54,
            node: {
              id: 1,
              kind: 'cell',
              name: '$abc$240$auto$blifparse.cc:397:parse_blif$242',
              cell_type: 'LUT2',
            },
          }],
          edges: [{
            from: 1,
            to: 2,
            points: [],
            edge: {
              from: 1,
              to: 2,
              from_port: 'O',
              to_port: 'I',
              net_name: '$abc$240$X',
              bits: [1],
            },
          }],
          width: 84,
          height: 54,
        }}
        rootId={1}
        relevantIds={new Set()}
        overlayIds={new Set()}
        selectedId={null}
        interactive={false}
        onSelect={() => undefined}
        active={false}
        fitNonce={0}
      />,
    )

    expect(markup).toContain('>LUT2<')
    expect(markup).not.toMatch(/class="g-node-name"[^>]*>X<\/text>/)
  })

  it('draws a visible reset-edge pin even when control metadata is absent', () => {
    const markup = renderToStaticMarkup(
      <GraphView
        graph={{
          nodes: [
            {
              id: 1,
              x: 0,
              y: 12,
              width: 74,
              height: 34,
              node: { id: 1, kind: 'port', name: 'rst' },
            },
            {
              id: 2,
              x: 140,
              y: 0,
              width: 92,
              height: 58,
              node: {
                id: 2,
                kind: 'cell',
                name: 'q',
                cell_type: '$_DFFSR_PPP_',
                seq: true,
              },
            },
          ],
          edges: [
            {
              from: 1,
              to: 2,
              points: [
                { x: 74, y: 29 },
                { x: 140, y: 29 },
              ],
              edge: {
                from: 1,
                to: 2,
                from_port: 'rst',
                to_port: 'R',
                net_name: 'rst',
                bits: [0],
                control: true,
              },
            },
          ],
          width: 232,
          height: 58,
        }}
        rootId={2}
        relevantIds={new Set()}
        overlayIds={new Set()}
        selectedId={null}
        interactive={false}
        onSelect={() => undefined}
        active={false}
        fitNonce={0}
      />,
    )

    expect(markup).toContain(
      'class="g-reg-pin g-reg-ctrl-pin" x="9" y="32">R</text>',
    )
    expect(markup).toContain('class="g-edge control"')
    expect(markup).toContain('class="g-edge-arrows control"')
  })

  it('draws a generated enable on its EN pin without control-edge styling', () => {
    const markup = renderToStaticMarkup(
      <GraphView
        graph={{
          nodes: [
            {
              id: 1,
              x: 0,
              y: 12,
              width: 76,
              height: 52,
              node: {
                id: 1,
                kind: 'cell',
                name: 'enable_logic',
                cell_type: '$_NOT_',
              },
            },
            {
              id: 2,
              x: 140,
              y: 0,
              width: 92,
              height: 58,
              node: {
                id: 2,
                kind: 'cell',
                name: 'q',
                cell_type: '$_DFFE_PP_',
                seq: true,
                register: true,
              },
            },
          ],
          edges: [
            {
              from: 1,
              to: 2,
              points: [
                { x: 76, y: 38 },
                { x: 140, y: 51 },
              ],
              edge: {
                from: 1,
                to: 2,
                from_port: 'Y',
                to_port: 'E',
                net_name: 'generated_en',
                bits: [20],
              },
            },
          ],
          width: 232,
          height: 58,
        }}
        rootId={2}
        relevantIds={new Set()}
        overlayIds={new Set()}
        selectedId={null}
        interactive={false}
        onSelect={() => undefined}
        active={false}
        fitNonce={0}
      />,
    )

    expect(markup).toContain(
      'class="g-reg-pin g-reg-ctrl-pin" x="9" y="54.04">EN</text>',
    )
    expect(markup).toContain('class="g-edge"')
    expect(markup).not.toContain('class="g-edge control"')
    expect(markup).not.toContain('class="g-edge-arrows control"')
  })

  it('truncates long register names to the allocated node width', () => {
    const longName = 'with_stages.shift_data_reg_next[3]'
    const markup = renderToStaticMarkup(
      <GraphView
        graph={{
          nodes: [{
            id: 1,
            x: 0,
            y: 0,
            width: 182,
            height: 71,
            node: {
              id: 1,
              kind: 'cell',
              name: longName,
              cell_type: 'FDRE',
              seq: true,
              register: true,
            },
          }],
          edges: [],
          width: 182,
          height: 71,
        }}
        rootId={1}
        relevantIds={new Set()}
        overlayIds={new Set()}
        selectedId={null}
        interactive={false}
        onSelect={() => undefined}
        active={false}
        fitNonce={0}
      />,
    )

    expect(markup).not.toContain(`>${longName}</text>`)
    expect(markup).toContain('with_stages.shift…')
  })

  it('exposes one roving node tab stop regardless of graph size', () => {
    const markup = renderToStaticMarkup(
      <GraphView
        graph={{
          nodes: [1, 2, 3].map((id) => ({
            id,
            x: id * 100,
            y: 0,
            width: 84,
            height: 67,
            node: {
              id,
              kind: 'cell' as const,
              name: `node-${id}`,
              cell_type: 'FDRE',
              seq: true,
              register: true,
              controls: [{
                role: 'clock' as const,
                pin: 'C',
                net_name: 'clk',
                driver_id: 10,
                fanout: 3,
              }],
            },
          })),
          edges: [],
          width: 384,
          height: 54,
        }}
        rootId={1}
        relevantIds={new Set()}
        overlayIds={new Set()}
        selectedId={null}
        interactive
        onSelect={() => undefined}
        onControlSelect={() => undefined}
        onExpand={() => undefined}
        active
        fitNonce={0}
      />,
    )

    const nodeTags = markup.match(/<g[^>]*class="g-node-body[^>]*>/g) ?? []
    expect(nodeTags).toHaveLength(3)
    expect(nodeTags.filter((tag) => tag.includes('tabindex="0"'))).toHaveLength(1)
    expect(nodeTags.filter((tag) => tag.includes('tabindex="-1"'))).toHaveLength(2)
    const controlTags =
      markup.match(/<g[^>]*class="g-control-label(?: [^"]*)?"[^>]*>/g) ?? []
    expect(controlTags).toHaveLength(3)
    expect(controlTags.every((tag) => !tag.includes('tabindex='))).toBe(true)
    expect(markup).toContain('class="g-control-labels" aria-hidden="true"')
    expect(markup).toContain('Schematic viewport. Use arrow keys to pan')
    expect(markup).toContain('double-click')
    expect(markup).toContain('Esc clears')
  })

  it('keeps overview graphs to accessible node shells while selected nodes retain detail', () => {
    const graph = {
      nodes: [1, 2, 3].map((id) => ({
        id,
        x: id * 3_000,
        y: id * 2_000,
        width: 84,
        height: 67,
        node: {
          id,
          kind: 'cell' as const,
          name: `node-${id}`,
          cell_type: 'FDRE',
          seq: true,
          register: true,
          controls: [{
            role: 'clock' as const,
            pin: 'C',
            net_name: 'clk',
            driver_id: 10,
            fanout: 3,
          }],
        },
      })),
      edges: [],
      width: 10_000,
      height: 8_000,
    }
    const renderGraph = (selectedId: number | null) => renderToStaticMarkup(
      <GraphView
        graph={graph}
        rootId={1}
        relevantIds={new Set()}
        overlayIds={new Set()}
        selectedId={selectedId}
        interactive
        onSelect={() => undefined}
        onControlSelect={() => undefined}
        active
        fitNonce={0}
      />,
    )

    const overviewMarkup = renderGraph(null)
    expect(overviewMarkup.match(/class="g-node-body/g)).toHaveLength(3)
    expect(overviewMarkup.match(/data-node-tooltip="FDRE — node-/g)).toHaveLength(3)
    expect(overviewMarkup).not.toContain('<title>')
    expect(overviewMarkup.match(/class="g-overview-label"/g)).toHaveLength(3)
    expect(overviewMarkup).toContain('>FDRE</text>')
    expect(overviewMarkup).not.toContain('class="g-node-label g-reg-name"')
    expect(overviewMarkup).not.toContain('class="g-symbol-detail"')
    expect(overviewMarkup).not.toContain('class="g-symbol-stack"')
    expect(overviewMarkup).not.toContain('class="g-reg-pins"')
    expect(overviewMarkup).not.toContain('class="g-control-labels"')

    const selectedMarkup = renderGraph(2)
    expect(selectedMarkup.match(/class="g-node-label g-reg-name"/g)).toHaveLength(1)
    expect(selectedMarkup.match(/class="g-symbol-detail"/g)).toHaveLength(1)
    expect(selectedMarkup.match(/class="g-reg-pins"/g)).toHaveLength(1)
    expect(selectedMarkup.match(/class="g-control-labels"/g)).toHaveLength(1)
  })
})

describe('GraphView group expansion controls', () => {
  it('shows a small plus on a collapsed group', () => {
    const markup = renderToStaticMarkup(
      <GraphView
        graph={{
          nodes: [{
            id: 100,
            x: 10,
            y: 20,
            width: 100,
            height: 58,
            node: {
              id: 100,
              kind: 'cell',
              name: 'memory [16×16]',
              cell_type: 'RAM32M',
              members: [1, 2, 3, 4],
              member_count: 4,
              width: 4,
            },
          }],
          edges: [],
          width: 120,
          height: 98,
        }}
        rootId={-1}
        relevantIds={new Set()}
        overlayIds={new Set()}
        selectedId={null}
        interactive
        onSelect={() => undefined}
        onExpandGroup={() => undefined}
        active={false}
        fitNonce={0}
      />,
    )

    expect(markup).toContain('data-group-action="expand"')
    expect(markup).toContain('aria-label="Expand group memory [16×16]"')
    expect(markup).toContain('class="g-group-toggle-hit" r="10"')
    expect(markup).toContain('<circle r="6"></circle>')
  })

  it('shows the plus for a singleton physical group', () => {
    const markup = renderToStaticMarkup(
      <GraphView
        graph={{
          nodes: [{
            id: 100,
            x: 10,
            y: 20,
            width: 100,
            height: 58,
            node: {
              id: 100,
              kind: 'cell',
              name: 'memory [16×16]',
              cell_type: 'SB_RAM40_4K',
              members: [1],
              member_count: 1,
              width: 1,
            },
          }],
          edges: [],
          width: 120,
          height: 98,
        }}
        rootId={-1}
        relevantIds={new Set()}
        overlayIds={new Set()}
        selectedId={null}
        interactive
        onSelect={() => undefined}
        onExpandGroup={() => undefined}
        active={false}
        fitNonce={0}
      />,
    )

    expect(markup).toContain('data-group-action="expand"')
  })

  it('keeps a dashed labeled boundary and minus around expanded members', () => {
    const markup = renderToStaticMarkup(
      <GraphView
        graph={{
          nodes: [1, 2].map((id, index) => ({
            id,
            x: 20 + index * 120,
            y: 30,
            width: 90,
            height: 58,
            node: { id, kind: 'cell' as const, name: `lane${id}`, cell_type: 'RAM32M' },
          })),
          edges: [],
          width: 240,
          height: 110,
        }}
        rootId={-1}
        relevantIds={new Set()}
        overlayIds={new Set()}
        selectedId={null}
        interactive
        onSelect={() => undefined}
        expandedGroups={[{ id: 100, label: 'memory [16×16]', members: [1, 2] }]}
        onCollapseGroup={() => undefined}
        active={false}
        fitNonce={0}
      />,
    )

    expect(markup).toContain('class="g-expanded-group-boundary"')
    expect(markup).toContain('data-group-action="collapse"')
    expect(markup).toContain('aria-label="Collapse group memory [16×16]"')
    expect(markup).toContain('class="g-group-toggle-hit" r="10"')
    expect(markup).toContain('<circle r="6"></circle>')
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

function laidOutPrimitiveEdge(from: number, to: number, toPort: string) {
  return {
    from,
    to,
    points: [
      { x: 74, y: 17 },
      { x: 200, y: 100 },
    ],
    edge: {
      from,
      to,
      from_port: toPort.toLowerCase(),
      to_port: toPort,
      net_name: toPort.toLowerCase(),
      bits: [from],
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
