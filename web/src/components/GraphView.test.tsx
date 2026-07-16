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
})
