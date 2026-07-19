import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import {
  isValidSynthesisArtifact,
  synthesisKey,
  type SynthesisArtifact,
} from '../src/lib/designCache'
import {
  validateSynthesisRequest,
  type ValidatedSynthesis,
} from '../src/lib/yosysScript'

interface SourceManifestEntry {
  name: string
  top: string
  files: string[]
}

interface PrecomputedEntry {
  name: string
  key: string
}

const expectedStructuralFacts: Record<
  string,
  { top: string; inputs: number; outputs: number }
> = {
  default: { top: 'top', inputs: 19, outputs: 8 },
  reg_mux: { top: 'reg_mux', inputs: 19, outputs: 8 },
  priority_encoder_case: { top: 'priority_encoder_case', inputs: 32, outputs: 38 },
  priority_encoder_for: { top: 'priority_encoder_for', inputs: 32, outputs: 38 },
  priority_encoder_carry: { top: 'priority_encoder_carry', inputs: 32, outputs: 38 },
  adder_chain: { top: 'adder_chain', inputs: 64, outputs: 18 },
  barrel_shifter: { top: 'barrel_shifter', inputs: 39, outputs: 32 },
  round_robin_arbiter: { top: 'round_robin_arbiter', inputs: 7, outputs: 7 },
  pipe: { top: 'pipe', inputs: 19, outputs: 16 },
  srl_pipe: { top: 'srl_pipe', inputs: 12, outputs: 9 },
  fifo_pipe: { top: 'fifo_pipe', inputs: 20, outputs: 18 },
  inferred_fifo: { top: 'inferred_fifo', inputs: 20, outputs: 23 },
  async_fifo_blackbox: { top: 'async_fifo_wrapper', inputs: 22, outputs: 18 },
  handshake_controller: { top: 'handshake_controller', inputs: 5, outputs: 5 },
  vhdl_counter: { top: 'vhdl_counter', inputs: 3, outputs: 8 },
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
expected.set('default', validateSynthesisRequest({
  files: [
    {
      name: 'design.sv',
      content: readFileSync(join(root, 'src', 'data', 'default.sv'), 'utf8'),
    },
  ],
  mode: 'gates',
}))
for (const entry of sourceManifest) {
  expected.set(entry.name, validateSynthesisRequest({
    files: entry.files
      .map((name) => ({
        name,
        content: readFileSync(join(sourceDirectory, name), 'utf8'),
      })),
    top: entry.top,
    mode: 'gates',
  }))
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
  verifyStructuralFacts(entry.name, artifact)
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

function verifyStructuralFacts(name: string, artifact: SynthesisArtifact) {
  const expectedFacts = expectedStructuralFacts[name]
  if (!expectedFacts) throw new Error(`Missing structural expectations for ${name}`)
  for (const [label, json] of [
    ['mapped', artifact.output.netlistJson],
    ['source', artifact.output.sourceNetlistJson],
  ] as const) {
    const netlist = JSON.parse(json) as {
      modules?: Record<
        string,
        {
          attributes?: Record<string, unknown>
          ports?: Record<string, { direction?: string; bits?: unknown[] }>
          cells?: Record<string, unknown>
        }
      >
    }
    const top = netlist.modules?.[expectedFacts.top]
    if (!top) throw new Error(`${name} ${label} netlist is missing top ${expectedFacts.top}`)
    const topAttribute = String(top.attributes?.top ?? '')
    if (!/[1-9]/.test(topAttribute)) {
      throw new Error(`${name} ${label} netlist does not mark ${expectedFacts.top} as top`)
    }
    let inputs = 0
    let outputs = 0
    for (const port of Object.values(top.ports ?? {})) {
      const width = Array.isArray(port.bits) ? port.bits.length : 0
      if (port.direction === 'input') inputs += width
      if (port.direction === 'output') outputs += width
    }
    if (inputs !== expectedFacts.inputs || outputs !== expectedFacts.outputs) {
      throw new Error(
        `${name} ${label} ports changed: expected ${expectedFacts.inputs}/${expectedFacts.outputs} input/output bits, found ${inputs}/${outputs}`,
      )
    }
    if (label === 'mapped' && Object.keys(top.cells ?? {}).length === 0) {
      throw new Error(`${name} mapped netlist has no cells`)
    }
  }
}
