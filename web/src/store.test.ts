import { describe, expect, it } from 'vitest'
import { normalizeSourceSelection, synthesisInput } from './lib/liveAnalysis'

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
    expect(synthesisInput(files, '  top  ', 'gates', '  -flatten ').key).toBe(
      synthesisInput(files, 'top', 'gates', '-flatten').key,
    )
  })
})

describe('source selection normalization', () => {
  it('supports forward and backward multiline selections', () => {
    expect(normalizeSourceSelection('top.sv', 18, 12)).toEqual({
      file: 'top.sv',
      startLine: 12,
      endLine: 18,
    })
  })

  it('never emits a line below one', () => {
    expect(normalizeSourceSelection('top.sv', 0, -4)).toEqual({
      file: 'top.sv',
      startLine: 1,
      endLine: 1,
    })
  })
})
