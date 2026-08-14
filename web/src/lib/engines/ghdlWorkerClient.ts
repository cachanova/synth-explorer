import type { ValidatedSynthesis } from '../synthesis/yosysScript'
import type {
  VhdlTranslation,
  VhdlWorkerRequest,
  VhdlWorkerResponse,
} from './ghdlProtocol'
import { createPooledWorkerRunner, mapToolWorkerResponse } from './pooledWorker'

const runGhdlWorker = createPooledWorkerRunner<
  VhdlWorkerRequest,
  VhdlWorkerResponse,
  VhdlTranslation
>(createGhdlWorker, {
  label: 'GHDL',
  timeoutMs: 30_000,
  mapResponse: (response) => mapToolWorkerResponse(response, 'GHDL failed'),
})

export function runGhdl(
  input: ValidatedSynthesis,
  signal?: AbortSignal,
): Promise<VhdlTranslation> {
  if (!input.top) {
    return Promise.reject(new Error('VHDL synthesis requires an explicit top entity'))
  }
  return runGhdlWorker({ files: input.files, top: input.top }, signal)
}

function createGhdlWorker(): Worker {
  return new Worker(new URL('../../workers/ghdl.worker.ts', import.meta.url), {
    type: 'module',
  })
}
