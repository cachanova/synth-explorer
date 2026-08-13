import type { MemoryHandling, ValidatedSynthesis } from '../synthesis/yosysScript'
import { LocalSynthesisError } from '../synthesis/synthesisError'
import { createPooledWorkerRunner } from './pooledWorker'
import type {
  YosysWorkerRequest,
  YosysWorkerResponse,
  YosysWorkerResult,
} from './yosysProtocol'

const executeYosysWorker = createPooledWorkerRunner<
  YosysWorkerRequest,
  YosysWorkerResponse,
  YosysWorkerResult
>(createYosysWorker)

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

function runYosysWorker(
  request: YosysWorkerRequest,
  signal?: AbortSignal,
): Promise<YosysWorkerResult> {
  return executeYosysWorker(request, {
    timeoutMs: 60_000,
    signal,
    onResponse(response, resolve, reject) {
      if (response.ok) resolve(response.result)
      else {
        reject(
          new LocalSynthesisError(response.error, response.log ?? '', response.kind),
        )
      }
    },
    timeoutError: () => new LocalSynthesisError('yosys timed out', '', 'timeout'),
    // run() catches everything inside the worker, so an 'error' event here
    // means the worker script itself failed to load or parse.
    workerError: (event) =>
      new LocalSynthesisError(
        event.message || 'failed to load the Yosys worker',
        '',
        'load',
      ),
  })
}

function createYosysWorker(): Worker {
  return new Worker(new URL('../../workers/yosys.worker.ts', import.meta.url), {
    type: 'module',
  })
}
