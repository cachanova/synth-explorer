import { describe, expect, it } from 'vitest'
import { rewriteVhdlSourceLocations, translatedYosysInput } from './vhdl'
import type { ValidatedSynthesis } from './yosysScript'

describe('VHDL translation', () => {
  it('turns GHDL location comments into Yosys line directives', () => {
    const result = rewriteVhdlSourceLocations(
      'module counter;\n  /* counter.vhdl:22:16  */\n  assign q = d;\nendmodule\n',
    )
    expect(result.rewritten).toBe(1)
    expect(result.verilog).toContain('`line 22 "counter.vhdl" 0\n  assign q = d;')
  })

  it('builds a generated-Verilog Yosys input while retaining synthesis settings', () => {
    const input: ValidatedSynthesis = {
      files: [{ name: 'counter.vhdl', content: 'entity counter is end;' }],
      top: 'Counter',
      mode: 'gates',
      extraArgs: ['-noabc'],
      language: 'vhdl',
    }
    const translated = translatedYosysInput(input, {
      verilog: 'module counter;\n/* counter.vhdl:1:1 */\nendmodule\n',
      log: '',
    })
    expect(translated).toMatchObject({
      top: 'Counter',
      mode: 'gates',
      extraArgs: ['-noabc'],
      language: 'verilog',
    })
    expect(translated.files[0].name).toBe('ghdl-counter.v')
    expect(translated.files[0].content).toContain('`line 1 "counter.vhdl" 0')
  })
})
