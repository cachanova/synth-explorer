import { describe, expect, it } from 'vitest'
import type { Mode, SynthesizeRequest } from '../types'
import {
  buildVivadoNormalizeScript,
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

  it('makes SystemVerilog headers available without compiling them as units', () => {
    const input = validateSynthesisRequest({
      ...request('gates'),
      files: [
        { name: 'top.sv', content: '`include "defs.svh"\nmodule top; endmodule' },
        { name: 'defs.svh', content: '`define WIDTH 8' },
      ],
    })

    expect(input.files.map((file) => file.name)).toEqual(['defs.svh', 'top.sv'])
    expect(buildYosysScript(input).match(/^read_verilog.*$/gm)).toEqual([
      'read_verilog -sv top.sv',
      'read_verilog -sv top.sv',
    ])
  })

  it('requires a Verilog compilation unit in addition to headers', () => {
    expect(() =>
      validateSynthesisRequest({
        ...request('gates'),
        files: [{ name: 'defs.svh', content: '`define WIDTH 8' }],
      }),
    ).toThrow('at least one .v or .sv source file is required')
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

  it('accepts ordered VHDL-2008 sources and requires an explicit top entity', () => {
    const vhdl: SynthesizeRequest = {
      files: [
        { name: 'types.vhd', content: 'package types is end package;' },
        { name: 'top.vhdl', content: 'entity top is end entity;' },
      ],
      top: 'top',
      mode: 'gates',
    }
    const input = validateSynthesisRequest(vhdl)
    expect(input.language).toBe('vhdl')
    expect(input.files.map((file) => file.name)).toEqual(['types.vhd', 'top.vhdl'])
    expect(() => validateSynthesisRequest({ ...vhdl, top: '' })).toThrow(
      'explicit top entity',
    )
  })

  it('rejects mixed-language workspaces', () => {
    expect(() =>
      validateSynthesisRequest({
        ...request('gates'),
        files: [
          { name: 'top.sv', content: 'module top; endmodule' },
          { name: 'helper.vhdl', content: 'entity helper is end entity;' },
        ],
      }),
    ).toThrow('mixed Verilog and VHDL')
  })

  it('selects the delay family from the visible Xilinx flag', () => {
    expect(defaultDelayProfile(validateSynthesisRequest(request('xilinx', '-family xcup')))).toBe(
      'ultrascale_plus',
    )
    expect(defaultDelayProfile(validateSynthesisRequest(request('gates')))).toBe('generic')
  })

  it('validates local Vivado identity and builds one fixed normalizer script', () => {
    const input = validateSynthesisRequest({
      ...request('xilinx', '-retiming'),
      tool: 'vivado',
      target: 'xc7a35tcpg236-1',
      vivado_family: 'artix7',
      vivado_speed: '-1',
      vivado_version: 'Vivado v2026.1; bridge 0.2.0',
    })
    expect(input.tool).toBe('vivado')
    expect(defaultDelayProfile(input)).toBe('series7')
    expect(buildVivadoNormalizeScript('top')).toBe(
      'read_verilog -lib /share/xilinx/cells_sim.v\n' +
        'read_verilog -lib /share/xilinx/cells_xtra.v\n' +
        'read_verilog vivado-netlist.v\n' +
        'hierarchy -check -top top\n' +
        'flatten\nselect -clear\nselect top\n' +
        'write_json -selected netlist.json\n',
    )
    expect(() => buildVivadoNormalizeScript('top; exec')).toThrow('invalid top')
  })

  it('rejects incomplete or overriding local Vivado requests', () => {
    expect(() => validateSynthesisRequest({ ...request('xilinx'), tool: 'vivado' })).toThrow(
      'installed target',
    )
    expect(() => validateSynthesisRequest({
      ...request('xilinx', '-part other'),
      tool: 'vivado',
      target: 'xc7a35tcpg236-1',
      vivado_family: 'artix7',
      vivado_speed: '-1',
      vivado_version: 'Vivado v2026.1',
    })).toThrow('dedicated fields')
  })
})
