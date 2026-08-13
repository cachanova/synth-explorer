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
  vivadoExtraArgs: '-mode default -max_dsp 0',
  synthTool: 'vivado',
  vivadoTarget: 'xc7a100t-csg324-1',
}

describe('stored workspace validation', () => {
  it('restores exact editable synthesis inputs', () => {
    expect(parseStoredWorkspace(valid)).toEqual({
      files: valid.files,
      activeFileName: 'helper.v',
      top: 'top',
      mode: 'xilinx',
      extraArgs: '-family xc7',
      vivadoExtraArgs: '-mode default -max_dsp 0',
      synthTool: 'vivado',
      vivadoTarget: 'xc7a100t-csg324-1',
    })
  })

  it('defaults the selected tool for workspaces saved before it persisted', () => {
    const { synthTool: _tool, vivadoTarget: _target, ...legacy } = valid
    const restored = parseStoredWorkspace(legacy)
    expect(restored?.synthTool).toBe('yosys')
    expect(restored?.vivadoTarget).toBe('')
  })

  it('keeps the files when the stored tool is not one this build knows', () => {
    // Discarding the workspace would delete every source file the user has,
    // so an unusable tool preference degrades instead of failing the parse.
    const unknownTool = parseStoredWorkspace({ ...valid, synthTool: 'quartus' })
    expect(unknownTool?.files).toEqual(valid.files)
    expect(unknownTool?.synthTool).toBe('yosys')

    const unusableTarget = parseStoredWorkspace({ ...valid, vivadoTarget: 7 })
    expect(unusableTarget?.files).toEqual(valid.files)
    expect(unusableTarget?.vivadoTarget).toBe('')
  })

  it('migrates older workspaces to the visible Vivado default', () => {
    const { vivadoExtraArgs: _omitted, ...legacy } = valid
    expect(parseStoredWorkspace(legacy)?.vivadoExtraArgs).toBe('-mode out_of_context')
  })

  it('preserves explicit removal of the Vivado default', () => {
    expect(parseStoredWorkspace({ ...valid, vivadoExtraArgs: '' })?.vivadoExtraArgs).toBe('')
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
