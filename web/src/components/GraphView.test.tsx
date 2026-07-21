import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GraphView } from './GraphView'

describe('GraphView LUT labels', () => {
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
    expect(markup).toContain('color-mix(in srgb, var(--green) 10%, transparent)')
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
    expect(markup).toContain('with_stages.shift_da…')
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
