// Engine assets (WASM modules, resource archives) are fetched lazily and
// cached per worker — but failures are never cached: a dropped connection
// mid-download must not poison every later attempt, so a failed load clears
// the cache and the next call retries.
//
// Load failures are wrapped in EngineLoadError so callers can tell "the
// engine never arrived" (retryable, says nothing about the design or any
// cached synthesis) apart from design errors. Workers forward the
// distinction across postMessage as a `kind: 'load'` field on their failure
// responses, and the client rebuilds the typed error from it.

export class EngineLoadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EngineLoadError'
  }
}

export function lazyLoad<T>(context: string, load: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | null = null
  return () => {
    cached ??= load().catch((error: unknown) => {
      cached = null
      const detail = error instanceof Error ? error.message : String(error)
      throw new EngineLoadError(`${context}: ${detail}`)
    })
    return cached
  }
}
