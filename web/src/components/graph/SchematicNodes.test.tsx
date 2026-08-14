import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GraphView } from './GraphView'
describe('schematic nodes', () => {
  it('uses the schematic contrast tokens for constant nodes', () => {
    const markup = renderToStaticMarkup(
      <GraphView
        graph={{
          nodes: [{
            id: 1,
            x: 0,
            y: 0,
            width: 48,
            height: 28,
            node: { id: 1, kind: 'const', name: "1'b0" },
          }],
          edges: [],
          width: 48,
          height: 28,
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

    expect(markup).toContain('class="g-node-body g-symbol-const')
    expect(markup).toContain('fill="var(--schematic-gate-fill)"')
    expect(markup).toContain('stroke="var(--schematic-gate-stroke)"')
  })

  it('renders canonical input direction when visible topology is incomplete', () => {
    const markup = renderToStaticMarkup(
      <GraphView
        graph={{
          nodes: [
            {
              id: 1,
              x: 0,
              y: 0,
              width: 74,
              height: 34,
              node: {
                id: 1,
                kind: 'port',
                name: 'clk',
                port_direction: 'input',
              },
            },
          ],
          edges: [],
          width: 74,
          height: 34,
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

    expect(markup).toMatch(
      /data-node-tooltip="clk" class="g-node-body g-symbol-port-in/,
    )
  })

  it('renders hidden control-only boundary drivers as primary inputs', () => {
    const markup = renderToStaticMarkup(
      <GraphView
        graph={{
          nodes: [
            {
              id: 1,
              x: 0,
              y: 0,
              width: 74,
              height: 34,
              node: { id: 1, kind: 'port', name: 'clk' },
            },
            {
              id: 2,
              x: 160,
              y: 0,
              width: 82,
              height: 71,
              node: {
                id: 2,
                kind: 'cell',
                name: 'state',
                cell_type: 'FDRE',
                seq: true,
                register: true,
                controls: [
                  { role: 'clock', pin: 'C', net_name: 'clk', driver_id: 1, fanout: 1 },
                ],
              },
            },
          ],
          edges: [],
          width: 242,
          height: 71,
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

    expect(markup).toMatch(
      /data-node-tooltip="clk" class="g-node-body g-symbol-port-in/,
    )
    expect(markup).not.toMatch(
      /data-node-tooltip="clk" class="g-node-body g-symbol-port-out/,
    )
  })

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

  it('renders a grouped top-level port as one range-labeled shape without stacking', () => {
    const markup = renderToStaticMarkup(
      <GraphView
        graph={{
          nodes: [{
            id: 21,
            x: 0,
            y: 0,
            width: 180,
            height: 42,
            node: {
              id: 21,
              kind: 'port',
              name: 'data_in[15:0]',
              width: 16,
              member_count: 16,
              members: Array.from({ length: 16 }, (_, index) => index + 1),
            },
          }],
          edges: [],
          width: 180,
          height: 42,
        }}
        rootId={-1}
        relevantIds={new Set()}
        overlayIds={new Set()}
        selectedId={21}
        interactive={false}
        onSelect={() => undefined}
        active
        fitNonce={0}
      />,
    )

    expect(markup).toContain('g-symbol-port-')
    expect(markup).toContain('>data_in[15:0]<')
    expect(markup).not.toContain('class="g-symbol-stack"')
    expect(markup).not.toContain('>×16<')
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
