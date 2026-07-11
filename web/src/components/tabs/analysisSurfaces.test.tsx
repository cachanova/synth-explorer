import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TimingPath } from '../../types'
import { ModeName } from './Overview'
import {
  BitCohort,
  OutputAliasName,
  PathClassName,
  PathEndpointName,
} from './Paths'

describe('analysis surface labels', () => {
  it('labels generic LUT modes as metrics rather than target fabrics', () => {
    expect(renderToStaticMarkup(<ModeName mode="lut6" />)).toBe(
      'Generic LUT6 metric',
    )
  })

  it('formats grouped path bits as descending cohorts', () => {
    expect(renderToStaticMarkup(<BitCohort bits={[2, 1, 0, 6, 5, 2]} />)).toBe(
      '[6:5], [2:0]',
    )
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
})
