export type SynthesisFailureKind = 'load' | 'timeout' | 'bridge'

export class RequestValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RequestValidationError'
  }
}

export class LocalSynthesisError extends Error {
  readonly log: string
  readonly kind?: SynthesisFailureKind

  constructor(message: string, log: string, kind?: SynthesisFailureKind) {
    super(message)
    this.name = 'LocalSynthesisError'
    this.log = log
    this.kind = kind
  }
}

export function isResourceFailure(error: unknown): boolean {
  if (!(error instanceof LocalSynthesisError)) return false
  // A load failure is a network problem, not a resource limit: retrying with
  // abstracted memories could cache a degraded synthesis for a design that
  // never exceeded anything.
  if (error.kind === 'load') return false
  if (error.kind === 'timeout') return true
  const detail = `${error.message}\n${error.log}`
  return /bad_alloc|out of memory|memory access out of bounds/i.test(detail)
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError')
}

export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError())
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
