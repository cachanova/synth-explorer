import { describe, expect, it } from 'vitest'
import { parseStoredWorkspace } from './workspaceStorage'

const valid = {
  schema: 1,
  files: [
    { name: 'top.sv', content: 'module top; endmodule' },
    { name: 'helper.v', content: 'module helper; endmodule' },
  ],
  activeFileName: 'helper.v',
  top: 'top',
  mode: 'xilinx',
  extraArgs: '-family xc7',
}

describe('stored workspace validation', () => {
  it('restores exact editable synthesis inputs', () => {
    expect(parseStoredWorkspace(valid)).toEqual({
      files: valid.files,
      activeFileName: 'helper.v',
      top: 'top',
      mode: 'xilinx',
      extraArgs: '-family xc7',
    })
  })

  it('rejects stale schemas and malformed inputs', () => {
    expect(parseStoredWorkspace({ ...valid, schema: 2 })).toBeNull()
    expect(parseStoredWorkspace({ ...valid, files: [] })).toBeNull()
    expect(parseStoredWorkspace({ ...valid, activeFileName: 'missing.sv' })).toBeNull()
    expect(parseStoredWorkspace({ ...valid, mode: 'unknown' })).toBeNull()
    expect(
      parseStoredWorkspace({
        ...valid,
        files: [valid.files[0], { ...valid.files[0] }],
      }),
    ).toBeNull()
    expect(
      parseStoredWorkspace({
        ...valid,
        files: [{ name: '../top.sv', content: '' }],
        activeFileName: '../top.sv',
      }),
    ).toBeNull()
  })
})
