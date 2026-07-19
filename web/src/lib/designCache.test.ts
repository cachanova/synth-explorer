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
})
