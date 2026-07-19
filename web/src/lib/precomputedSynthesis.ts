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

export async function getPrecomputedSynthesis(
  key: string,
  input: ValidatedSynthesis,
): Promise<SynthesisArtifact | null> {
  if (!availableKeys.has(key)) return null
  try {
    const response = await fetch(`/precomputed/${key}.json`, {
      cache: 'force-cache',
    })
    if (!response.ok) return null
    const artifact: unknown = await response.json()
    return isValidSynthesisArtifact(artifact, key, input) ? artifact : null
  } catch {
    // A missing edge artifact must not make ordinary browser synthesis fail.
    return null
  }
}
