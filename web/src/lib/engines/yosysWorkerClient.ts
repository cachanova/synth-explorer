import type { MemoryHandling, ValidatedSynthesis } from '../synthesis/yosysScript'
import { createPooledWorkerRunner, mapToolWorkerResponse } from './pooledWorker'
import type {
  YosysWorkerRequest,
  YosysWorkerResponse,
  YosysWorkerResult,
} from './yosysProtocol'

const runYosysWorker = createPooledWorkerRunner<
  YosysWorkerRequest,
  YosysWorkerResponse,
  YosysWorkerResult
>(createYosysWorker, {
  label: 'yosys',
  timeoutMs: 60_000,
  mapResponse: mapToolWorkerResponse,
})

export function runYosys(
  input: ValidatedSynthesis,
  memory: MemoryHandling,
  signal?: AbortSignal,
): Promise<YosysWorkerResult> {
  return runYosysWorker({ kind: 'synthesis', input, memory }, signal)
}

export function runVivadoNormalizer(
  netlist: string,
  top: string,
  sourceNetlistJson: string,
  flatSourceNetlistJson: string,
  signal?: AbortSignal,
): Promise<YosysWorkerResult> {
  return runYosysWorker(
    {
      kind: 'vivado-normalize',
      netlist,
      top,
      sourceNetlistJson,
      flatSourceNetlistJson,
    },
    signal,
  )
}

function createYosysWorker(): Worker {
  return new Worker(new URL('../../workers/yosys.worker.ts', import.meta.url), {
    type: 'module',
  })
}
