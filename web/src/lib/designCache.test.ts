import { describe, expect, it } from 'vitest'
import {
  isValidSynthesisArtifact,
  synthesisKey,
  synthesisProducer,
  type SynthesisArtifact,
} from './designCache'
import { YOSYS_CACHE_SCHEMA, type ValidatedSynthesis } from './yosysScript'

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
