import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SynthTool } from '../types'

const state = vi.hoisted(() => ({
  designTool: 'yosys' as SynthTool,
  editorHighlight: null as {
    sourceTiers?: {
      nodeIds: number[]
      exact: Array<{
        file: string
        startLine: number
        startCol: number
        endLine: number
        endCol: number
      }>
    }
  } | null,
}))

vi.mock('../useStore', () => ({
  shallowEqual: Object.is,
  useStore: (selector: (store: object) => unknown) =>
    selector({
      design: { tool: state.designTool },
      files: [{ name: 'top.sv' }],
      editorHighlight: state.editorHighlight,
      highlightSources: vi.fn(),
      openCone: vi.fn(),
      openControlCone: vi.fn(),
    }),
}))

import { NodeCard } from './NodeCard'

describe('NodeCard synthesis details', () => {
  beforeEach(() => {
    state.designTool = 'yosys'
    state.editorHighlight = null
  })

  it('labels raw Vivado node metadata with the completed design tool', () => {
    state.designTool = 'vivado'

    const markup = renderToStaticMarkup(
      <NodeCard
        node={{ id: 1, kind: 'cell', name: 'memory_reg', cell_type: 'RAM32M' }}
        onClose={vi.fn()}
      />,
    )

    expect(markup).toContain('<summary>Vivado details</summary>')
    expect(markup).not.toContain('<summary>Yosys details</summary>')
  })

  it('keeps the Yosys label for Yosys designs', () => {
    const markup = renderToStaticMarkup(
      <NodeCard
        node={{ id: 1, kind: 'cell', name: 'logic_cell', cell_type: '$_AND_' }}
        onClose={vi.fn()}
      />,
    )

    expect(markup).toContain('<summary>Yosys details</summary>')
  })

  it('describes a grouped memory as physical primitives rather than bits', () => {
    const markup = renderToStaticMarkup(
      <NodeCard
        node={{
          id: 100,
          kind: 'cell',
          name: 'memory [128×16]',
          cell_type: 'RAM64M',
          width: 12,
          member_count: 5_000,
          members: Array.from({ length: 12 }, (_, index) => index),
          seq: true,
          register: false,
        }}
        onClose={vi.fn()}
      />,
    )

    expect(markup).toContain('<span class="k">primitives</span><span class="v">5000</span>')
    expect(markup).not.toContain('12 bits')
  })

  it('uses selected-node exact tiers instead of the raw source summary', () => {
    state.editorHighlight = {
      sourceTiers: {
        nodeIds: [5],
        exact: [
          {
            file: 'top.sv',
            startLine: 21,
            startCol: 1,
            endLine: 23,
            endCol: 1,
          },
        ],
      },
    }

    const markup = renderToStaticMarkup(
      <NodeCard
        node={{
          id: 5,
          kind: 'cell',
          name: 'logic_cell',
          src: 'top.sv:4.1-4.3',
        }}
        onClose={vi.fn()}
      />,
    )

    expect(markup).toContain('top.sv:21-23')
    expect(markup).not.toContain('top.sv:4')
  })

  it('falls back to raw source spans when the exact tier is empty', () => {
    state.editorHighlight = {
      sourceTiers: {
        nodeIds: [5],
        exact: [],
      },
    }

    const markup = renderToStaticMarkup(
      <NodeCard
        node={{
          id: 5,
          kind: 'cell',
          name: 'logic_cell',
          src: 'top.sv:4.1-4.3',
        }}
        onClose={vi.fn()}
      />,
    )

    expect(markup).toContain('top.sv:4')
  })

})
