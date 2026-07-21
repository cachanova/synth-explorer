import { describe, expect, it } from 'vitest'
import {
  isValidSynthesisArtifact,
  synthesisKey,
  synthesisProducer,
  type SynthesisArtifact,
} from './designCache'
import {
  GHDL_VERSION,
  YOSYS_CACHE_SCHEMA,
  YOSYS_VERSION,
  type ValidatedSynthesis,
} from './yosysScript'

const input: ValidatedSynthesis = {
  files: [{ name: 'design.sv', content: 'module top; endmodule' }],
  top: 'top',
  mode: 'gates',
  extraArgs: [],
  language: 'verilog',
}

function artifact(key: string): SynthesisArtifact {
  return {
    schema: YOSYS_CACHE_SCHEMA,
    producer: synthesisProducer(input),
    key,
    input,
    profile: 'generic',
    memoriesAbstracted: false,
    output: {
      netlistJson: '{}',
      sourceNetlistJson: '{}',
      log: 'ok',
    },
  }
}

describe('precomputed synthesis identity', () => {
  it('versions VHDL artifacts with both synthesis engines', async () => {
    const vhdlInput: ValidatedSynthesis = {
      ...input,
      files: [{ name: 'design.vhdl', content: 'entity top is end entity;' }],
      language: 'vhdl',
    }

    expect(synthesisProducer(input)).toBe(YOSYS_VERSION)
    expect(synthesisProducer(vhdlInput)).toBe(`${YOSYS_VERSION}+ghdl-${GHDL_VERSION}`)
    await expect(synthesisKey(vhdlInput)).resolves.not.toBe(await synthesisKey(input))
  })

  it('preserves existing Yosys keys and isolates local Vivado producers', async () => {
    await expect(synthesisKey(input)).resolves.toBe(
      '986bb5711941737939fd119203defe7526140ad397557afd4e780426f4d2bbc2',
    )
    const vivadoInput: ValidatedSynthesis = {
      ...input,
      tool: 'vivado',
      mode: 'xilinx',
      target: 'xc7a35tcpg236-1',
      vivadoFamily: 'artix7',
      vivadoSpeed: '-1',
      vivadoVersion: 'Vivado v2026.1; bridge 0.2.0',
    }
    expect(synthesisProducer(vivadoInput)).toBe(
      `vivado-${vivadoInput.vivadoVersion}+normalizer-${YOSYS_VERSION}`,
    )
    await expect(synthesisKey(vivadoInput)).resolves.not.toBe(await synthesisKey(input))
  })

  it('accepts only the exact cache key, producer, schema, and input', async () => {
    const key = await synthesisKey(input)
    expect(isValidSynthesisArtifact(artifact(key), key, input)).toBe(true)
    expect(isValidSynthesisArtifact({ ...artifact(key), producer: 'other' }, key, input)).toBe(false)
    expect(isValidSynthesisArtifact(artifact(key), `${key}0`, input)).toBe(false)
    expect(
      isValidSynthesisArtifact(artifact(key), key, {
        ...input,
        files: [{ name: 'design.sv', content: 'module changed; endmodule' }],
      }),
    ).toBe(false)
  })

  it('validates cached Vivado timing shape', async () => {
    const vivadoInput: ValidatedSynthesis = {
      ...input,
      tool: 'vivado',
      mode: 'xilinx',
      target: 'xc7a35tcpg236-1',
      vivadoFamily: 'artix7',
      vivadoSpeed: '-1',
      vivadoVersion: 'Vivado v2026.1; bridge 0.2.0',
    }
    const key = await synthesisKey(vivadoInput)
    const withTiming: SynthesisArtifact = {
      ...artifact(key),
      input: vivadoInput,
      producer: synthesisProducer(vivadoInput),
      output: {
        ...artifact(key).output,
        vivadoTiming: {
          data_path_delay_ns: 4.016,
          logic_delay_ns: 3.216,
          net_delay_ns: 0.8,
          logic_levels: 2,
          slack_ns: -0.125,
          startpoint: 'q_reg/C',
          endpoint: 'q',
          path_group: 'clk',
          corner: 'Slow',
          delay_type: 'max',
          report: 'Timing Report',
        },
      },
    }

    expect(isValidSynthesisArtifact(withTiming, key, vivadoInput)).toBe(true)
    expect(
      isValidSynthesisArtifact(
        {
          ...withTiming,
          output: {
            ...withTiming.output,
            vivadoTiming: {
              ...withTiming.output.vivadoTiming,
              corner: 7,
            },
          },
        },
        key,
        vivadoInput,
      ),
    ).toBe(false)
    expect(
      isValidSynthesisArtifact(
        {
          ...withTiming,
          output: {
            ...withTiming.output,
            vivadoTiming: {
              ...withTiming.output.vivadoTiming,
              data_path_delay_ns: -1,
            },
          },
        },
        key,
        vivadoInput,
      ),
    ).toBe(false)
  })
})
