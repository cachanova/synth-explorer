import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  autoSynthesize: true,
  synthesizing: false,
}))

vi.mock('../useStore', () => ({
  shallowEqual: Object.is,
  useStore: (selector: (store: object) => unknown) =>
    selector({
      examples: [],
      loadExample: vi.fn(),
      top: '',
      setTop: vi.fn(),
      synthTool: 'yosys',
      setSynthTool: vi.fn(),
      mode: 'gates',
      setMode: vi.fn(),
      extraArgs: '',
      setExtraArgs: vi.fn(),
      vivadoStatus: null,
      vivadoTarget: '',
      setVivadoTarget: vi.fn(),
      vivadoExtraArgs: '',
      setVivadoExtraArgs: vi.fn(),
      connectVivado: vi.fn(async () => false),
      disconnectVivado: vi.fn(),
      autoSynthesize: state.autoSynthesize,
      synthesizing: state.synthesizing,
      synthesize: vi.fn(),
    }),
}))

import { Toolbar } from './Toolbar'

describe('Toolbar synthesis action', () => {
  beforeEach(() => {
    state.autoSynthesize = true
    state.synthesizing = false
  })

  it('hides the manual action while automatic synthesis is enabled', () => {
    expect(renderToStaticMarkup(<Toolbar />)).not.toContain('>Synthesize<')
  })

  it('shows the manual action only when automatic synthesis is disabled', () => {
    state.autoSynthesize = false
    expect(renderToStaticMarkup(<Toolbar />)).toContain('>Synthesize<')
  })

  it('disables the manual action while synthesis is running', () => {
    state.autoSynthesize = false
    state.synthesizing = true
    const markup = renderToStaticMarkup(<Toolbar />)

    expect(markup).toContain('disabled=""')
    expect(markup).toContain('>Synthesizing…<')
  })
})
