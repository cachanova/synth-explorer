import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GraphView } from './GraphView'
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
    expect(markup).toContain('data-control-node-id="100"')
    expect(markup).toContain('aria-label="Expand group memory [16×16]"')
    expect(markup).toContain('transform="translate(107,23)"')
    expect(markup).toContain('class="g-group-toggle-hit" r="19"')
    expect(markup).not.toContain('<circle r="6"></circle>')
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

  it('does not show group controls for top-level port vectors', () => {
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
              kind: 'port',
              name: 'count[7:0]',
              members: [1, 2, 3, 4, 5, 6, 7, 8],
              member_count: 8,
              width: 8,
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
        expandedGroups={[{
          id: 101,
          label: 'other[1:0]',
          members: [100],
        }]}
        onCollapseGroup={() => undefined}
        active={false}
        fitNonce={0}
      />,
    )

    expect(markup).not.toContain('data-group-action="expand"')
    expect(markup).not.toContain('data-group-action="collapse"')
  })

  it('keeps re-rendered group members inside one collapsible boundary', () => {
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
    expect(markup).toContain('class="g-expanded-group-label"')
    expect(markup.match(/data-group-action="collapse"/g)).toHaveLength(1)
    expect(markup).toContain('data-control-node-id="1"')
    expect(markup).toContain('aria-label="Collapse group memory [16×16]"')
    expect(markup).toContain('transform="translate(229,17)"')
    expect(markup).toContain('class="g-group-toggle-hit" r="19"')
    expect(markup).not.toContain('<circle r="6"></circle>')
  })

  it('gives each open group its own boundary while others stay expandable', () => {
    const markup = renderToStaticMarkup(
      <GraphView
        graph={{
          nodes: [
            ...[1, 2, 3, 4].map((id, index) => ({
              id,
              x: 20 + index * 120,
              y: 30,
              width: 90,
              height: 58,
              node: { id, kind: 'cell' as const, name: `lane${id}`, cell_type: 'FDRE' },
            })),
            {
              id: 300,
              x: 520,
              y: 30,
              width: 90,
              height: 58,
              node: {
                id: 300,
                kind: 'cell' as const,
                name: 'still_grouped[3:0]',
                cell_type: 'FDRE',
                members: [5, 6, 7, 8],
                member_count: 4,
                width: 4,
              },
            },
          ],
          edges: [],
          width: 640,
          height: 110,
        }}
        rootId={-1}
        relevantIds={new Set()}
        overlayIds={new Set()}
        selectedId={null}
        interactive
        onSelect={() => undefined}
        onExpandGroup={() => undefined}
        expandedGroups={[
          { id: 100, label: 'a[1:0]', members: [1, 2] },
          { id: 200, label: 'b[1:0]', members: [3, 4] },
        ]}
        onCollapseGroup={() => undefined}
        active={false}
        fitNonce={0}
      />,
    )

    expect(markup.match(/class="g-expanded-group-boundary"/g)).toHaveLength(2)
    expect(markup.match(/data-group-action="collapse"/g)).toHaveLength(2)
    expect(markup).toContain('aria-label="Collapse group a[1:0]"')
    expect(markup).toContain('aria-label="Collapse group b[1:0]"')
    // A group that is still collapsed keeps its own expand control, so opening
    // one group never removes the way into another.
    expect(markup.match(/data-group-action="expand"/g)).toHaveLength(1)
    expect(markup).toContain('aria-label="Expand group still_grouped[3:0]"')
  })
})
