import { describe, expect, it } from 'vitest'
import { firstYosysSourceError } from './yosysDiagnostics'

describe('Yosys source diagnostics', () => {
  it('extracts a submitted file and line from a syntax error', () => {
    const log = [
      '1. Executing Verilog-2005 frontend: design.sv',
      "Parsing SystemVerilog input from `design.sv' to AST representation.",
      "design.sv:4: ERROR: syntax error, unexpected '=', expecting TOK_ID",
    ].join('\n')

    expect(firstYosysSourceError(log, ['design.sv'])).toEqual({
      file: 'design.sv',
      line: 4,
      message: "syntax error, unexpected '=', expecting TOK_ID",
    })
  })

  it('preserves a column when Yosys supplies one', () => {
    expect(
      firstYosysSourceError('rtl/control.sv:12:7: ERROR: unexpected token', [
        'rtl/control.sv',
      ]),
    ).toEqual({
      file: 'rtl/control.sv',
      line: 12,
      column: 7,
      message: 'unexpected token',
    })
  })

  it('ignores script and unsubmitted-file locations', () => {
    const log = [
      '/script.ys:2: ERROR: command failed',
      'stale.sv:9: ERROR: syntax error',
    ].join('\n')

    expect(firstYosysSourceError(log, ['design.sv'])).toBeUndefined()
  })

  it('returns no diagnostic for an unlocated synthesis error', () => {
    expect(
      firstYosysSourceError("ERROR: Module `missing' not found!", ['design.sv']),
    ).toBeUndefined()
  })
})
