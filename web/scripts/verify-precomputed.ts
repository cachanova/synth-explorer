import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import {
  isValidSynthesisArtifact,
  synthesisKey,
  type SynthesisArtifact,
} from '../src/lib/designCache'
import type { ValidatedSynthesis } from '../src/lib/yosysScript'

interface SourceManifestEntry {
  name: string
  top: string
  files: string[]
}

interface PrecomputedEntry {
  name: string
  key: string
}

const root = process.cwd()
const sourceDirectory = join(root, 'src', 'data', 'examples')
const artifactDirectory = join(root, 'public', 'precomputed')
const sourceManifest = JSON.parse(
  readFileSync(join(sourceDirectory, 'manifest.json'), 'utf8'),
) as SourceManifestEntry[]
const precomputedManifest = JSON.parse(
  readFileSync(join(root, 'src', 'data', 'precomputedManifest.json'), 'utf8'),
) as { entries: PrecomputedEntry[] }

const expected = new Map<string, ValidatedSynthesis>()
expected.set('default', {
  files: [
    {
      name: 'design.sv',
      content: readFileSync(join(root, 'src', 'data', 'default.sv'), 'utf8'),
    },
  ],
  mode: 'gates',
  extraArgs: [],
})
for (const entry of sourceManifest) {
  expected.set(entry.name, {
    files: entry.files
      .map((name) => ({
        name,
        content: readFileSync(join(sourceDirectory, name), 'utf8'),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    top: entry.top,
    mode: 'gates',
    extraArgs: [],
  })
}

if (precomputedManifest.entries.length !== expected.size) {
  throw new Error(
    `Expected ${expected.size} precomputed entries, found ${precomputedManifest.entries.length}`,
  )
}

const retainedFiles = new Set<string>()
for (const entry of precomputedManifest.entries) {
  const input = expected.get(entry.name)
  if (!input) throw new Error(`Unexpected precomputed entry: ${entry.name}`)
  expected.delete(entry.name)
  const key = await synthesisKey(input)
  if (entry.key !== key) {
    throw new Error(`Stale precomputed key for ${entry.name}: expected ${key}, found ${entry.key}`)
  }
  const filename = `${key}.json`
  retainedFiles.add(filename)
  const artifact = JSON.parse(
    readFileSync(join(artifactDirectory, filename), 'utf8'),
  ) as SynthesisArtifact
  if (!isValidSynthesisArtifact(artifact, key, input)) {
    throw new Error(`Invalid precomputed artifact for ${entry.name}`)
  }
}
if (expected.size > 0) {
  throw new Error(`Missing precomputed entries: ${[...expected.keys()].join(', ')}`)
}
const extraFiles = readdirSync(artifactDirectory).filter(
  (filename) => filename.endsWith('.json') && !retainedFiles.has(filename),
)
if (extraFiles.length > 0) {
  throw new Error(`Unreferenced precomputed artifacts: ${extraFiles.join(', ')}`)
}

process.stdout.write(`Verified ${retainedFiles.size} precomputed gate-mode designs.\n`)
