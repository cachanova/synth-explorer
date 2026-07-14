import { describe, expect, it } from 'vitest'
import { buildSynthesizeRequest } from './synthesize'

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

  it('sends the family and retime only for xilinx mode', () => {
    const xil = buildSynthesizeRequest(files, 'top', 'xilinx', '', 'xcup', true)
    expect(xil.family).toBe('xcup')
    expect(xil.retime).toBe(true)
    expect(buildSynthesizeRequest(files, 'top', 'xilinx', '', 'xcup', false).retime).toBe(
      false,
    )
    // Non-xilinx modes keep an identical request regardless of the selectors.
    const gates = buildSynthesizeRequest(files, 'top', 'gates', '', 'xcup', true)
    expect(gates.family).toBeUndefined()
    expect(gates.retime).toBeUndefined()
    expect(gates).toEqual(buildSynthesizeRequest(files, 'top', 'gates', '', 'xc7', false))
  })
})
