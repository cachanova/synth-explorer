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
      tool: 'yosys',
      mode: 'gates',
      target: undefined,
      extra_args: '-nofsm   -noabc',
    })
  })

  it('omits empty optional fields', () => {
    expect(buildSynthesizeRequest(files, ' ', 'rtl', '   ')).toEqual({
      files,
      top: undefined,
      tool: 'yosys',
      mode: 'rtl',
      target: undefined,
      extra_args: undefined,
    })
  })

  it('passes xilinx family/retime through as ordinary flags (no dedicated fields)', () => {
    // The Xilinx controls assemble -family/-retime into the flags string, so
    // buildSynthesizeRequest just forwards them via extra_args.
    expect(
      buildSynthesizeRequest(
        files,
        'top',
        'xilinx',
        '-family xcup -retime',
      ),
    ).toEqual({
      files,
      top: 'top',
      tool: 'yosys',
      mode: 'xilinx',
      target: undefined,
      extra_args: '-family xcup -retime',
    })
  })

  it('keeps Vivado target and flags independent from mode', () => {
    expect(
      buildSynthesizeRequest(
        files,
        'top',
        'gates',
        '-retiming',
        'vivado',
        'xc7a35tcpg236-1',
      ),
    ).toEqual({
      files,
      top: 'top',
      tool: 'vivado',
      mode: 'gates',
      target: 'xc7a35tcpg236-1',
      extra_args: '-retiming',
    })
  })
})
