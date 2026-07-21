import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SynthTool } from '../types'

const state = vi.hoisted(() => ({
  designTool: 'yosys' as SynthTool,
}))

vi.mock('../useStore', () => ({
  shallowEqual: Object.is,
  useStore: (selector: (store: object) => unknown) =>
    selector({
      design: { tool: state.designTool },
      files: [],
      highlightSources: vi.fn(),
      openCone: vi.fn(),
      openControlCone: vi.fn(),
    }),
}))

import { NodeCard } from './NodeCard'

describe('NodeCard synthesis details', () => {
  beforeEach(() => {
    state.designTool = 'yosys'
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
})
