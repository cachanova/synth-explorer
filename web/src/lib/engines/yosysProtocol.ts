import type { VivadoTimingReport } from '../../types'
import type { MemoryHandling, ValidatedSynthesis } from '../synthesis/yosysScript'

export type YosysWorkerRequest =
  | {
      kind: 'synthesis'
      input: ValidatedSynthesis
      memory: MemoryHandling
    }
  | {
      kind: 'vivado-normalize'
      netlist: string
      sourceNetlistJson: string
      flatSourceNetlistJson: string
      top: string
    }

export interface YosysWorkerResult {
  netlistJson: string
  sourceNetlistJson: string
  flatSourceNetlistJson: string
  log: string
  vivadoTiming?: VivadoTimingReport
}

export type YosysWorkerResponse =
  | { ok: true; result: YosysWorkerResult }
  | { ok: false; error: string; kind?: 'load'; log?: string }
