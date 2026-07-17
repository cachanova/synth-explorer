import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GraphView } from './GraphView'

describe('GraphView LUT labels', () => {
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
                bits: [1],
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
    expect(markup).toMatch(/data-relevant="0"[^>]*><path class="g-edge/)
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

    const edgeTags = markup.match(/<path class="g-edge[^"]*"[^>]*>/g) ?? []
    expect(edgeTags).toHaveLength(4)
    expect(edgeTags[0]).toContain('class="g-edge hl"')
    expect(edgeTags[1]).toContain('class="g-edge hl"')
    expect(edgeTags[2]).toContain('class="g-edge"')
    expect(edgeTags[2]).not.toContain('class="g-edge hl"')
    expect(edgeTags[3]).toContain('class="g-edge hl"')

    const pathMarkup = renderToStaticMarkup(<GraphView {...props} />)
    const pathEdgeTags = pathMarkup.match(/<path class="g-edge[^"]*"[^>]*>/g) ?? []
    expect(pathEdgeTags[0]).not.toContain('class="g-edge hl"')
    expect(pathEdgeTags[1]).not.toContain('class="g-edge hl"')
    expect(pathEdgeTags[2]).not.toContain('class="g-edge hl"')
    expect(pathEdgeTags[3]).toContain('class="g-edge hl"')
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
