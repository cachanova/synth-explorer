import { describe, expect, it } from 'vitest'
import { synthesisInput } from './liveAnalysis'
import { buildSynthesizeRequest } from './synthesize'

describe('synthesis input identity', () => {
  it('changes for every value sent to synthesis', () => {
    const base = synthesisInput(
      [{ name: 'top.sv', content: 'module top; endmodule' }],
      'top',
      'gates',
      '',
    )

    expect(
      synthesisInput(
        [{ name: 'top.sv', content: 'module top; wire x; endmodule' }],
        'top',
        'gates',
        '',
      ).key,
    ).not.toBe(base.key)
    expect(
      synthesisInput(base.request.files, 'other', 'gates', '').key,
    ).not.toBe(base.key)
    expect(
      synthesisInput(base.request.files, 'top', 'lut6', '').key,
    ).not.toBe(base.key)
    expect(
      synthesisInput(base.request.files, 'top', 'gates', '-flatten').key,
    ).not.toBe(base.key)
  })

  it('uses the normalized request as the identity', () => {
    const files = [{ name: 'top.sv', content: 'module top; endmodule' }]
    const input = synthesisInput(files, '  top  ', 'gates', '  -flatten ')

    expect(input.request).toEqual(
      buildSynthesizeRequest(files, '  top  ', 'gates', '  -flatten '),
    )
    expect(input.key).toBe(
      synthesisInput(files, 'top', 'gates', '-flatten').key,
    )
  })

  it('keeps stable request identity separate from the cheap edit revision', () => {
    const files = [{ name: 'top.sv', content: 'module top; endmodule' }]
    const first = synthesisInput(files, 'top', 'gates', '', 2)
    const reverted = synthesisInput(files, 'top', 'gates', '', 9)

    expect(first.key).toBe(reverted.key)
    expect(first.revision).toBe(2)
    expect(reverted.revision).toBe(9)
  })
})

describe('buildSynthesizeRequest', () => {
  const files = [
    {
      name: 'design.sv',
      content: 'module top(input a, output y); assign y = a; endmodule',
    },
  ]

  it('forwards trimmed synthesis flags from the webpage', () => {
    expect(
      buildSynthesizeRequest(files, ' top ', 'gates', '  -nofsm   -noabc  '),
    ).toEqual({
      files,
      top: 'top',
      mode: 'gates',
      extra_args: '-nofsm   -noabc',
    })
  })

  it('omits empty optional fields', () => {
    expect(buildSynthesizeRequest(files, ' ', 'rtl', '   ')).toEqual({
      files,
      top: undefined,
      mode: 'rtl',
      extra_args: undefined,
    })
  })

  it('includes the exact local Vivado producer and resolved part', () => {
    expect(buildSynthesizeRequest(files, 'top', 'gates', '-retiming', 'vivado', {
      name: 'xc7a35tcpg236-1',
      family: 'artix7',
      speed: '-1',
      version: 'Vivado v2026.1; bridge 0.2.0',
    })).toEqual({
      files,
      top: 'top',
      tool: 'vivado',
      mode: 'xilinx',
      target: 'xc7a35tcpg236-1',
      vivado_family: 'artix7',
      vivado_speed: '-1',
      vivado_version: 'Vivado v2026.1; bridge 0.2.0',
      extra_args: '-retiming',
    })
  })
})
