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

  it('sends the family only for xilinx mode', () => {
    expect(buildSynthesizeRequest(files, 'top', 'xilinx', '', 'xcup').family).toBe(
      'xcup',
    )
    // Non-xilinx modes keep an identical request regardless of the selector.
    expect(buildSynthesizeRequest(files, 'top', 'gates', '', 'xcup').family).toBeUndefined()
    expect(buildSynthesizeRequest(files, 'top', 'gates', '', 'xcup')).toEqual(
      buildSynthesizeRequest(files, 'top', 'gates', '', 'xc7'),
    )
  })
})
