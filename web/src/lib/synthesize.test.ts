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

  it('passes xilinx family/retime through as ordinary flags (no dedicated fields)', () => {
    // The Xilinx controls assemble -family/-retime into the flags string, so
    // buildSynthesizeRequest just forwards them via extra_args.
    expect(
      buildSynthesizeRequest(files, 'top', 'xilinx', '-family xcup -retime'),
    ).toEqual({
      files,
      top: 'top',
      mode: 'xilinx',
      extra_args: '-family xcup -retime',
    })
  })

  it('omits yosys-only options for vivado mode', () => {
    expect(buildSynthesizeRequest(files, 'top', 'vivado', '-noabc')).toEqual({
      files,
      top: 'top',
      mode: 'vivado',
      extra_args: undefined,
    })
  })
})
