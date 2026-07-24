import type { ValidatedSynthesis } from '../yosysScript'
import type { YosysWorkerResult } from '../../workers/yosys.worker'

export interface SynthEngineRequest {
  /** The validated request as submitted; Vivado consumes these files natively. */
  input: ValidatedSynthesis
  /** Yosys-ready variant: VHDL sources arrive pre-translated by GHDL. */
  yosysInput: ValidatedSynthesis
  /** GHDL translation log, empty when no translation ran. */
  ghdlLog: string
}

export interface SynthEngineResult {
  output: YosysWorkerResult
  memoriesAbstracted: boolean
}

/** One synthesis tool path. Implementations own their log composition. */
export interface SynthEngine {
  produce(
    request: SynthEngineRequest,
    signal?: AbortSignal,
  ): Promise<SynthEngineResult>
}
