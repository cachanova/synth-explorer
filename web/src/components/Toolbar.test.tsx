import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  synthTool: 'yosys' as 'yosys' | 'vivado',
  vivadoStatus: null as null | {
    protocol_version: number
    bridge_version: string
    vivado_version: string
    parts: Array<{ name: string; family: string; speed: string }>
  },
  vivadoTarget: '',
  vivadoExtraArgs: '-mode out_of_context',
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
      synthTool: state.synthTool,
      setSynthTool: vi.fn(),
      mode: 'gates',
      setMode: vi.fn(),
      extraArgs: '',
      setExtraArgs: vi.fn(),
      vivadoStatus: state.vivadoStatus,
      vivadoTarget: state.vivadoTarget,
      setVivadoTarget: vi.fn(),
      vivadoExtraArgs: state.vivadoExtraArgs,
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
    state.synthTool = 'yosys'
    state.vivadoStatus = null
    state.vivadoTarget = ''
    state.vivadoExtraArgs = '-mode out_of_context'
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

  it('keeps Vivado manual even when automatic Yosys synthesis is enabled', () => {
    state.synthTool = 'vivado'
    state.vivadoStatus = {
      protocol_version: 2,
      bridge_version: '0.2.0-test',
      vivado_version: 'Vivado v2026.1',
      parts: [{ name: 'xc7a35tcpg236-1', family: 'artix7', speed: '-1' }],
    }
    state.vivadoTarget = 'xc7a35tcpg236-1'

    const markup = renderToStaticMarkup(<Toolbar />)
    expect(markup).toContain('>Synthesize<')
    expect(markup).toContain('flags-menu-trigger')
    expect(markup).toContain('1 selected')
  })
})
