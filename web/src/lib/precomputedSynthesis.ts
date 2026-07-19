import manifest from '../data/precomputedManifest.json'
import {
  isValidSynthesisArtifact,
  type SynthesisArtifact,
} from './designCache'
import type { ValidatedSynthesis } from './yosysScript'

const availableKeys = new Set(
  (manifest.entries as Array<{ name: string; key: string }>).map(
    (entry) => entry.key,
  ),
)
const PRECOMPUTED_FETCH_TIMEOUT_MS = 5_000

export async function getPrecomputedSynthesis(
  key: string,
  input: ValidatedSynthesis,
  signal?: AbortSignal,
): Promise<SynthesisArtifact | null> {
  if (!availableKeys.has(key)) return null
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Precomputed synthesis timed out', 'TimeoutError')),
    PRECOMPUTED_FETCH_TIMEOUT_MS,
  )
  try {
    const response = await fetch(`/precomputed/${key}.json`, {
      cache: 'force-cache',
      signal: controller.signal,
    })
    if (!response.ok) return null
    const artifact: unknown = await response.json()
    return isValidSynthesisArtifact(artifact, key, input) ? artifact : null
  } catch {
    // A missing edge artifact must not make ordinary browser synthesis fail.
    return null
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}
