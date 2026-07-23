import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TimingPath } from '../../types'
import { StaleResultsChip } from '../StaleResultsChip'
import { PlatformName } from './Overview'
import {
  OutputAliasName,
  PathClassName,
  PathEndpointName,
} from './Paths'

describe('analysis surface labels', () => {
  it('labels generic LUT modes as metrics rather than target fabrics', () => {
    expect(renderToStaticMarkup(<PlatformName mode="lut6" />)).toBe(
      'Generic LUT6 metric',
    )
  })

  it('labels Xilinx mode without repeating the selected synthesis tool', () => {
    expect(renderToStaticMarkup(<PlatformName mode="xilinx" />)).toBe('Xilinx')
  })

  it('renders path classes and registered-output aliases in product terms', () => {
    expect(
      renderToStaticMarkup(<PathClassName value="register_to_output" />),
    ).toBe('Register → output')
    expect(
      renderToStaticMarkup(
        <OutputAliasName
          alias={{
            name: 'valid',
            width: 1,
            bits: [{ output_bit: 0, register_bit: 0 }],
          }}
        />,
      ),
    ).toBe('valid')
  })

  it('does not expose a hidden Yosys endpoint group name', () => {
    const path: TimingPath = {
      depth: 0,
      class: 'register_to_register',
      endpoint_group: '$procdff$7',
      endpoint_kind: 'register',
      bits: [0],
      output_aliases: [],
      startpoint: {
        id: 1,
        kind: 'cell',
        name: 'source_reg',
        cell_type: '$_DFF_P_',
        seq: true,
      },
      endpoint: {
        id: 2,
        kind: 'cell',
        name: '$procdff$7',
        cell_type: '$_DFF_P_',
        seq: true,
      },
      endpoint_port: 'D',
      nodes: [],
    }

    expect(renderToStaticMarkup(<PathEndpointName path={path} />)).toBe('DFF')
  })

  it('flags non-current analysis results with a stale chip', () => {
    for (const state of ['refreshing', 'stale', 'error'] as const) {
      expect(renderToStaticMarkup(<StaleResultsChip state={state} />)).toContain(
        'showing previous results — refreshing',
      )
    }
  })

  it('renders no stale chip when the analysis is current', () => {
    expect(renderToStaticMarkup(<StaleResultsChip state="current" />)).toBe('')
    expect(renderToStaticMarkup(<StaleResultsChip state="none" />)).toBe('')
  })
})
