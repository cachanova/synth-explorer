import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { YOSYS_VERSION } from '../web/src/lib/synthesis/yosysScript'
import type { SynthesizeRequest, XilinxFamily } from '../web/src/types'
import {
  isXilinxCalibrationVariant,
  renderCalibrationScript,
  type XilinxCalibrationVariant,
} from './xilinx-matrix'

const run = promisify(execFile)
const yosysBin = process.env.SYNTH_EXPLORER_YOSYS?.trim() || 'yosys'

interface Case {
  name: string
  file: string
  top: string
}

interface Spec {
  parts: Record<string, Record<string, string>>
  speed_grade_cases: string[]
  cases: Case[]
}

interface BridgeStatus {
  bridge_version: string
  vivado_version: string
  edif_timing?: boolean
  parts: { name: string }[]
}

interface Timing {
  data_path_delay_ns: number
  logic_delay_ns?: number
  net_delay_ns?: number
  logic_levels?: number
}

interface ResultRow {
  case: string
  family: string
  speed_grade: string
  variant: XilinxCalibrationVariant
  target: string
  data_path_ns: number
  logic_ns: number
  route_ns: number
  logic_levels: number
}

const FAMILY_ARGS: Record<string, XilinxFamily> = {
  series7: 'xc7',
  ultrascale: 'xcu',
  ultrascale_plus: 'xcup',
}

async function main() {
  const [casesArg, outArg, variantsArg = 'production', bridge = 'http://127.0.0.1:32123', origin = 'http://127.0.0.1:32126'] = process.argv.slice(2)
  if (!casesArg || !outArg) {
    throw new Error('usage: collect-vivado.ts <cases-dir> <out-dir> [variants] [bridge-url] [origin]')
  }
  const casesDir = resolve(casesArg)
  const outDir = resolve(outArg)
  const variants = variantsArg.split(',').map((value) => value.trim())
  if (variants.some((value) => !isXilinxCalibrationVariant(value))) {
    throw new Error(`unknown variant in ${variantsArg}`)
  }
  const typedVariants = variants as XilinxCalibrationVariant[]
  if (new Set(typedVariants).size !== typedVariants.length) {
    throw new Error('calibration variants must be unique')
  }

  const specText = await readFile(join(casesDir, 'cases.json'), 'utf8')
  const spec = JSON.parse(specText) as Spec
  validateSpec(spec)
  const sourcesHash = await hashSources(casesDir, spec)
  const synthesisContractHash = await hashSynthesisContract()
  const yosys = await yosysVersion()
  const [expectedVersion, expectedCommit] = YOSYS_VERSION.split('-', 2)
  if (!expectedVersion || !expectedCommit
      || !yosys.includes(`Yosys ${expectedVersion}`)
      || !yosys.includes(expectedCommit)) {
    throw new Error(`native ${yosys.trim()} does not match production ${YOSYS_VERSION}`)
  }
  const status = await bridgeRequest<BridgeStatus>(bridge, origin, '/v1/status')
  if (!status.edif_timing) {
    throw new Error('the local Vivado bridge does not advertise EDIF timing support')
  }
  const installed = new Set(status.parts.map((part) => part.name))
  for (const grades of Object.values(spec.parts)) {
    for (const part of Object.values(grades)) {
      if (!installed.has(part)) throw new Error(`required Vivado part is not installed: ${part}`)
    }
  }

  await mkdir(outDir, { recursive: true })
  for (const variant of typedVariants) {
    await collectVariant({
      bridge,
      casesDir,
      origin,
      outDir,
      sourcesHash,
      synthesisContractHash,
      spec,
      status,
      variant,
      yosys: yosys.trim(),
    })
  }
}

async function collectVariant(input: {
  bridge: string
  casesDir: string
  origin: string
  outDir: string
  sourcesHash: string
  synthesisContractHash: string
  spec: Spec
  status: BridgeStatus
  variant: XilinxCalibrationVariant
  yosys: string
}) {
  const resultPath = join(input.outDir, `${input.variant}.json`)
  const metadataPath = join(input.outDir, `${input.variant}.meta.json`)
  const metadata = {
    schema_version: 1,
    variant: input.variant,
    sources_sha256: input.sourcesHash,
    synthesis_contract_sha256: input.synthesisContractHash,
    yosys: input.yosys,
    bridge: input.status.bridge_version,
    vivado: input.status.vivado_version,
  }
  let rows: ResultRow[] = []
  const existingMetadataText = await readOptional(metadataPath)
  const existingRowsText = await readOptional(resultPath)
  if (existingMetadataText === null && existingRowsText !== null) {
    throw new Error(`resume result has no identity metadata: ${metadataPath}`)
  }
  if (existingMetadataText !== null) {
    const existingMetadata = JSON.parse(existingMetadataText) as unknown
    if (JSON.stringify(existingMetadata) !== JSON.stringify(metadata)) {
      throw new Error(`resume metadata does not match ${metadataPath}`)
    }
    if (existingRowsText === null) {
      await atomicJson(resultPath, rows)
    } else {
      rows = JSON.parse(existingRowsText) as ResultRow[]
    }
  } else {
    await atomicJson(metadataPath, metadata)
    await atomicJson(resultPath, rows)
  }
  const completed = new Set<string>()
  const expectedRows = expectedRowTargets(input.spec, input.variant)
  for (const row of rows) {
    const key = rowKey(row.case, row.family, row.speed_grade)
    if (row.variant !== input.variant
        || completed.has(key)
        || expectedRows.get(key) !== row.target
        || !validTimingRow(row)) {
      throw new Error(`invalid or duplicate resume row: ${key}`)
    }
    await requireArtifacts(input.outDir, input.variant, row.family, row.case)
    completed.add(key)
  }

  for (const [family, grades] of Object.entries(input.spec.parts)) {
    const familyArg = FAMILY_ARGS[family]
    if (!familyArg) throw new Error(`unsupported calibration family: ${family}`)
    for (const calibrationCase of input.spec.cases) {
      const requiredGrades = input.variant === 'production' && input.spec.speed_grade_cases.includes(calibrationCase.name)
        ? Object.keys(grades)
        : ['-1']
      const missingGrades = requiredGrades.filter((grade) => !completed.has(rowKey(calibrationCase.name, family, grade)))
      if (missingGrades.length === 0) continue
      const edif = await synthesizeEdif(input, calibrationCase, family, familyArg)
      for (const grade of missingGrades) {
        const target = grades[grade]
        if (!target) throw new Error(`missing ${family} ${grade} part in cases.json`)
        const response = await bridgeRequest<{
          top?: string
          target?: string
          timing?: Timing
        }>(
          input.bridge,
          input.origin,
          '/v1/time-edif',
          { edif, top: calibrationCase.top, target, max_paths: 1 },
        )
        if (response.top !== calibrationCase.top || response.target !== target) {
          throw new Error(
            `bridge identity mismatch for ${calibrationCase.name} ${family} ${grade}`,
          )
        }
        const timing = response.timing
        if (!timing || timing.logic_delay_ns === undefined || timing.net_delay_ns === undefined || timing.logic_levels === undefined) {
          throw new Error(`incomplete timing for ${calibrationCase.name} ${family} ${grade}`)
        }
        const row: ResultRow = {
          case: calibrationCase.name,
          family,
          speed_grade: grade,
          variant: input.variant,
          target,
          data_path_ns: timing.data_path_delay_ns,
          logic_ns: timing.logic_delay_ns,
          route_ns: timing.net_delay_ns,
          logic_levels: timing.logic_levels,
        }
        rows.push(row)
        completed.add(rowKey(row.case, row.family, row.speed_grade))
        rows.sort((left, right) => rowKey(left.case, left.family, left.speed_grade).localeCompare(rowKey(right.case, right.family, right.speed_grade)))
        await atomicJson(resultPath, rows)
        process.stdout.write(`ok: ${input.variant} ${row.case} ${family} ${grade}\n`)
      }
    }
  }
  const missing = [...expectedRows.keys()].filter((key) => !completed.has(key))
  if (rows.length !== expectedRows.size || missing.length !== 0) {
    throw new Error(
      `${input.variant}: expected ${expectedRows.size} results, found ${rows.length}; missing ${missing.join(', ')}`,
    )
  }
}

async function synthesizeEdif(
  input: { casesDir: string; outDir: string; variant: XilinxCalibrationVariant },
  calibrationCase: Case,
  family: string,
  familyArg: XilinxFamily,
): Promise<string> {
  const content = await readFile(join(input.casesDir, calibrationCase.name, calibrationCase.file), 'utf8')
  const request: SynthesizeRequest = {
    files: [{ name: calibrationCase.file, content }],
    top: calibrationCase.top,
    mode: 'xilinx',
  }
  const script = renderCalibrationScript({ request, family: familyArg, variant: input.variant, writeEdif: true })
  const work = await mkdtemp(join(tmpdir(), 'synth-calibration-'))
  try {
    await writeFile(join(work, calibrationCase.file), content)
    await writeFile(join(work, 'script.ys'), script)
    await run(yosysBin, ['-q', '-T', '-s', 'script.ys', '-l', 'yosys.log'], { cwd: work, maxBuffer: 16 * 1024 * 1024 })
    const artifactDir = join(input.outDir, 'artifacts', input.variant, family, calibrationCase.name)
    await mkdir(artifactDir, { recursive: true })
    for (const name of ['script.ys', 'netlist.json', 'netlist.edif']) {
      await writeFile(join(artifactDir, name), await readFile(join(work, name)))
    }
    if (input.variant === 'production') {
      const edifDir = join(input.casesDir, 'edif')
      await mkdir(edifDir, { recursive: true })
      await writeFile(
        join(edifDir, `${calibrationCase.name}.${family}.edif`),
        await readFile(join(work, 'netlist.edif')),
      )
    }
    return await readFile(join(work, 'netlist.edif'), 'utf8')
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

async function bridgeRequest<T>(bridge: string, origin: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${bridge.replace(/\/$/, '')}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`${path}: ${response.status} ${response.statusText}: ${detail}`)
  }
  return await response.json() as T
}

function validateSpec(spec: Spec) {
  if (!spec.cases.length) throw new Error('cases.json has no cases')
  if (new Set(spec.cases.map((entry) => entry.name)).size !== spec.cases.length) {
    throw new Error('cases.json has duplicate case names')
  }
  for (const family of Object.keys(spec.parts)) {
    if (!FAMILY_ARGS[family]) throw new Error(`unknown family in cases.json: ${family}`)
    for (const grade of ['-1', '-2', '-3']) {
      if (!spec.parts[family][grade]) throw new Error(`${family} has no ${grade} part`)
    }
  }
}

async function hashSources(casesDir: string, spec: Spec): Promise<string> {
  const hash = createHash('sha256')
  hash.update(await readFile(join(casesDir, 'cases.json')))
  for (const entry of spec.cases) {
    hash.update(entry.name)
    hash.update(await readFile(join(casesDir, entry.name, entry.file)))
  }
  return hash.digest('hex')
}

async function hashSynthesisContract(): Promise<string> {
  const files = [
    'render-yosys-script.ts',
    'xilinx-matrix.ts',
    '../web/src/lib/synthesis/yosysScript.ts',
    '../web/src/lib/synthesis/flagRegistry.ts',
    '../web/src/lib/synthesis/synthFlags.ts',
  ]
  const hash = createHash('sha256')
  for (const relative of files) {
    const path = fileURLToPath(new URL(relative, import.meta.url))
    hash.update(relative)
    hash.update(await readFile(path))
  }
  return hash.digest('hex')
}

async function yosysVersion(): Promise<string> {
  const result = await run(yosysBin, ['-V'])
  return result.stdout || result.stderr
}

function expectedRowTargets(
  spec: Spec,
  variant: XilinxCalibrationVariant,
): Map<string, string> {
  const expected = new Map<string, string>()
  for (const [family, grades] of Object.entries(spec.parts)) {
    for (const calibrationCase of spec.cases) {
      const requiredGrades = variant === 'production'
        && spec.speed_grade_cases.includes(calibrationCase.name)
        ? Object.keys(grades)
        : ['-1']
      for (const grade of requiredGrades) {
        expected.set(
          rowKey(calibrationCase.name, family, grade),
          grades[grade],
        )
      }
    }
  }
  return expected
}

function rowKey(caseName: string, family: string, grade: string): string {
  return `${family}:${caseName}:${grade}`
}

async function atomicJson(path: string, value: unknown) {
  const temporary = join(dirname(path), `.${basename(path)}.tmp`)
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`)
  await rename(temporary, path)
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function validTimingRow(row: ResultRow): boolean {
  return row.data_path_ns >= 0
    && Number.isFinite(row.data_path_ns)
    && Number.isFinite(row.logic_ns)
    && Number.isFinite(row.route_ns)
    && Number.isInteger(row.logic_levels)
    && row.logic_levels >= 0
}

async function requireArtifacts(
  outDir: string,
  variant: XilinxCalibrationVariant,
  family: string,
  caseName: string,
) {
  const artifactDir = join(outDir, 'artifacts', variant, family, caseName)
  for (const name of ['script.ys', 'netlist.json', 'netlist.edif']) {
    try {
      await access(join(artifactDir, name))
    } catch {
      throw new Error(`resume row has no ${artifactDir}/${name}`)
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
