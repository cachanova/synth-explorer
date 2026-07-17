import { describe, expect, it } from 'vitest'
import type { Mode, SynthesizeRequest } from '../types'
import {
  buildYosysScript,
  defaultDelayProfile,
  validateSynthesisRequest,
} from './yosysScript'

function request(mode: Mode, extra_args?: string): SynthesizeRequest {
  return {
    files: [{ name: 'design.sv', content: 'module top; endmodule' }],
    top: 'top',
    mode,
    extra_args,
  }
}

describe('browser Yosys script', () => {
  it('matches the canonical generic flow', () => {
    const input = validateSynthesisRequest(request('gates', '  -nofsm   -noabc  '))
    expect(buildYosysScript(input)).toBe(
      'read_verilog -sv design.sv\n' +
        'hierarchy -top top\nproc\nwrite_json source-netlist.json\ndesign -reset\n' +
        'read_verilog -sv design.sv\n' +
        'synth -top top -flatten -nofsm -noabc\n' +
        'write_json netlist.json\n',
    )
  })

  it('keeps inferred memories abstract in the retry flow', () => {
    const script = buildYosysScript(validateSynthesisRequest(request('lut6')), 'abstract')
    expect(script).toContain('synth -top top -flatten -lut 6 -run begin:fine')
    expect(script).toContain('abc -lut 6')
    expect(script).not.toContain('memory_map')
  })

  it('soft maps narrow Xilinx arithmetic between identical flow halves', () => {
    const input = validateSynthesisRequest(
      request('xilinx', '-narrowcarry 8 -family xc7 -nowidelut'),
    )
    const script = buildYosysScript(input)
    const synth = 'synth_xilinx -top top -flatten -family xc7 -nowidelut'
    expect(script).toContain(`${synth} -run begin:fine`)
    expect(script).toContain('select -set narrow_alu t:$alu r:Y_WIDTH<=8 %i')
    expect(script).toContain(`${synth} -run fine:`)
    expect(script).not.toContain('-narrowcarry')
  })

  it('rejects script injection and malformed pseudo flags', () => {
    expect(() => validateSynthesisRequest(request('gates', '-noabc;rm'))).toThrow(
      'invalid extra_args token',
    )
    expect(() => validateSynthesisRequest(request('xilinx', '-narrowcarry 0'))).toThrow(
      'takes a width',
    )
    expect(() => validateSynthesisRequest(request('ice40', '-narrowcarry 8'))).toThrow(
      'only supported in xilinx',
    )
  })

  it('selects the delay family from the visible Xilinx flag', () => {
    expect(defaultDelayProfile(validateSynthesisRequest(request('xilinx', '-family xcup')))).toBe(
      'ultrascale_plus',
    )
    expect(defaultDelayProfile(validateSynthesisRequest(request('gates')))).toBe('generic')
  })
})
