import type { ValidatedSynthesis } from '../synthesis/yosysScript'
import type {
  VhdlTranslation,
  VhdlWorkerRequest,
  VhdlWorkerResponse,
} from '../synthesis/vhdl'
import { LocalSynthesisError } from '../synthesis/synthesisError'
import { createPooledWorkerRunner } from './pooledWorker'

const runGhdlWorker = createPooledWorkerRunner<
  VhdlWorkerRequest,
  VhdlWorkerResponse,
  VhdlTranslation
>(createGhdlWorker)

export function runGhdl(
  input: ValidatedSynthesis,
  signal?: AbortSignal,
): Promise<VhdlTranslation> {
  if (!input.top) {
    return Promise.reject(new Error('VHDL synthesis requires an explicit top entity'))
  }
  return runGhdlWorker(
    { files: input.files, top: input.top },
    {
      timeoutMs: 30_000,
      signal,
      onResponse(response, resolve, reject) {
        if (response.ok) resolve(response.result)
        else {
          reject(
            new LocalSynthesisError(
              response.error || 'GHDL failed',
              response.log ?? '',
              response.kind,
            ),
          )
        }
      },
      timeoutError: () => new LocalSynthesisError('GHDL timed out', '', 'timeout'),
      workerError: (event) =>
        new LocalSynthesisError(
          event.message || 'failed to load the GHDL worker',
          '',
          'load',
        ),
    },
  )
}

function createGhdlWorker(): Worker {
  return new Worker(new URL('../../workers/ghdl.worker.ts', import.meta.url), {
    type: 'module',
  })
}
