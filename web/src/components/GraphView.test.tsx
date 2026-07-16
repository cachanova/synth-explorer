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
        highlight={new Set()}
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
        highlight={new Set()}
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
        highlight={new Set()}
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
