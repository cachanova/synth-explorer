import { describe, expect, it, vi } from 'vitest'
import {
  computerFileCollisions,
  MAX_COMPUTER_FILE_BYTES,
  MAX_COMPUTER_FILE_COUNT,
  MAX_COMPUTER_FILES_BYTES,
  mergeComputerFiles,
  readComputerFiles,
} from './computerFiles'

describe('computer files', () => {
  it('reads selected Verilog files and SystemVerilog headers in selection order', async () => {
    const files = await readComputerFiles([
      new File(['module top; endmodule'], 'top.sv'),
      new File(['`define WIDTH 8'], 'defs.svh'),
      new File(['module helper; endmodule'], 'helper.v'),
    ])

    expect(files).toEqual([
      { name: 'top.sv', content: 'module top; endmodule' },
      { name: 'defs.svh', content: '`define WIDTH 8' },
      { name: 'helper.v', content: 'module helper; endmodule' },
    ])
  })

  it('rejects unsupported, unsafe, and duplicate source names', async () => {
    await expect(readComputerFiles([new File([''], 'notes.txt')])).rejects.toThrow(
      'must end in .v, .sv, or .svh',
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

  it('rejects selections that exceed file, count, or aggregate limits before reading', async () => {
    const fakeFile = (name: string, size: number) =>
      ({ name, size, text: vi.fn() }) as unknown as File
    const tooLarge = fakeFile('large.sv', MAX_COMPUTER_FILE_BYTES + 1)
    await expect(readComputerFiles([tooLarge])).rejects.toThrow('16 MiB')
    expect(tooLarge.text).not.toHaveBeenCalled()

    const tooMany = Array.from(
      { length: MAX_COMPUTER_FILE_COUNT + 1 },
      (_, index) => fakeFile(`file${index}.sv`, 1),
    )
    await expect(readComputerFiles(tooMany)).rejects.toThrow('Select at most')
    expect(
      tooMany.every((file) => !vi.mocked(file.text).mock.calls.length),
    ).toBe(true)

    const thirdOfTotal = Math.floor(MAX_COMPUTER_FILES_BYTES / 3) + 1
    const overTotal = [
      fakeFile('first.sv', thirdOfTotal),
      fakeFile('second.sv', thirdOfTotal),
      fakeFile('third.sv', thirdOfTotal),
    ]
    await expect(readComputerFiles(overTotal)).rejects.toThrow('32 MiB')
    expect(
      overTotal.every((file) => !vi.mocked(file.text).mock.calls.length),
    ).toBe(true)
  })

  it('reads selected files sequentially', async () => {
    let releaseFirst!: (content: string) => void
    const firstText = vi.fn(
      () => new Promise<string>((resolve) => (releaseFirst = resolve)),
    )
    const secondText = vi.fn(async () => 'second')
    const reading = readComputerFiles([
      { name: 'first.sv', size: 5, text: firstText } as unknown as File,
      { name: 'second.sv', size: 6, text: secondText } as unknown as File,
    ])

    await vi.waitFor(() => expect(firstText).toHaveBeenCalledOnce())
    expect(secondText).not.toHaveBeenCalled()
    releaseFirst('first')
    await expect(reading).resolves.toEqual([
      { name: 'first.sv', content: 'first' },
      { name: 'second.sv', content: 'second' },
    ])
  })

  it('rejects imports that would make the merged workspace exceed its limits', async () => {
    const text = vi.fn(async () => 'new')
    const selected = {
      name: 'new.sv',
      size: 3,
      text,
    } as unknown as File
    const fullWorkspace = Array.from(
      { length: MAX_COMPUTER_FILE_COUNT },
      (_, index) => ({ name: `existing${index}.sv`, content: '' }),
    )
    await expect(readComputerFiles([selected], fullWorkspace)).rejects.toThrow(
      '128-file workspace limit',
    )
    expect(text).not.toHaveBeenCalled()

    expect(() =>
      mergeComputerFiles(
        [{ name: 'large.sv', content: 'x'.repeat(MAX_COMPUTER_FILES_BYTES) }],
        [{ name: 'extra.sv', content: 'y' }],
      ),
    ).toThrow('32 MiB workspace limit')
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

  it('treats every same-name import as a collision even when content matches', () => {
    expect(
      computerFileCollisions(
        [{ name: 'design.sv', content: 'same' }],
        [
          { name: 'design.sv', content: 'same' },
          { name: 'helper.sv', content: 'new' },
        ],
      ),
    ).toEqual(['design.sv'])
  })
})
