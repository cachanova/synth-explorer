import type { ValidatedSynthesis } from '../yosysScript'
import { isAbortError, isResourceFailure } from '../synthesisError'
import type { SynthEngine } from './types'
import { runYosys } from './yosysWorkerClient'

export const yosysEngine: SynthEngine = {
  async produce({ yosysInput, ghdlLog }, signal) {
    let output
    let memoriesAbstracted = false
    try {
      output = await runYosys(yosysInput, 'map', signal)
    } catch (error) {
      if (isAbortError(error)) throw error
      if (!isResourceFailure(error) || !isGeneric(yosysInput.mode)) throw error
      output = await runYosys(yosysInput, 'abstract', signal)
      memoriesAbstracted = true
    }
    if (ghdlLog) {
      output = {
        ...output,
        log: `GHDL:\n${ghdlLog}\n\nYosys:\n${output.log}`,
      }
    }
    return { output, memoriesAbstracted }
  },
}

function isGeneric(mode: ValidatedSynthesis['mode']): boolean {
  return mode === 'gates' || mode === 'lut4' || mode === 'lut6'
}
