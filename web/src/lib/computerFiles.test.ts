import { describe, expect, it } from 'vitest'
import {
  mergeComputerFiles,
  readComputerFiles,
} from './computerFiles'

describe('computer files', () => {
  it('reads selected Verilog files in selection order', async () => {
    const files = await readComputerFiles([
      new File(['module top; endmodule'], 'top.sv'),
      new File(['module helper; endmodule'], 'helper.v'),
    ])

    expect(files).toEqual([
      { name: 'top.sv', content: 'module top; endmodule' },
      { name: 'helper.v', content: 'module helper; endmodule' },
    ])
  })

  it('rejects unsupported, unsafe, and duplicate source names', async () => {
    await expect(readComputerFiles([new File([''], 'notes.txt')])).rejects.toThrow(
      'must end in .v or .sv',
    )
    await expect(readComputerFiles([new File([''], '../top.sv')])).rejects.toThrow(
      'Invalid source filename',
    )
    await expect(
      readComputerFiles([
        new File(['first'], 'top.sv'),
        new File(['second'], 'top.sv'),
      ]),
    ).rejects.toThrow('More than one selected file is named top.sv')
  })

  it('replaces same-named tabs and appends new files without dropping others', () => {
    expect(
      mergeComputerFiles(
        [
          { name: 'design.sv', content: 'old' },
          { name: 'keep.v', content: 'keep' },
        ],
        [
          { name: 'design.sv', content: 'new' },
          { name: 'helper.sv', content: 'helper' },
        ],
      ),
    ).toEqual([
      { name: 'design.sv', content: 'new' },
      { name: 'keep.v', content: 'keep' },
      { name: 'helper.sv', content: 'helper' },
    ])
  })
})
