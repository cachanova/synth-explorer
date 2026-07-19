import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { chromium } from 'playwright'

const root = process.cwd()
const baseURL = 'http://127.0.0.1:4183'
const outputDirectory = join(root, 'public', 'precomputed')
const manifestPath = join(root, 'src', 'data', 'precomputedManifest.json')

const build = spawnSync('npm', ['run', 'build'], {
  cwd: root,
  encoding: 'utf8',
  stdio: 'inherit',
})
if (build.status !== 0) process.exit(build.status ?? 1)

const preview = spawn(
  process.execPath,
  [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--host', '127.0.0.1', '--port', '4183'],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
)
let previewLog = ''
preview.stdout.on('data', (chunk) => {
  previewLog += chunk
})
preview.stderr.on('data', (chunk) => {
  previewLog += chunk
})

try {
  await waitForPreview()
  const executablePath = browserExecutable()
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  })
  try {
    const context = await browser.newContext()
    const page = await context.newPage()
    // Always regenerate from the pinned Yosys engine, even when the previous
    // artifact set is present in the build used by this script.
    await page.route('**/precomputed/**', (route) => route.abort())
    await page.goto(baseURL, { waitUntil: 'domcontentloaded' })
    await waitForMapping(page)

    const generated = [{ name: 'default', artifact: await newestCacheRecord(page) }]
    const exampleSelect = page.getByLabel('Example')
    const exampleNames = await exampleSelect.locator('option').evaluateAll((options) =>
      options.map((option) => option.value).filter(Boolean),
    )
    for (const name of exampleNames) {
      await exampleSelect.selectOption(name)
      await page.waitForFunction(
        () => document.querySelector('.pane-right')?.dataset.analysisState !== 'current',
      )
      await waitForMapping(page)
      generated.push({ name, artifact: await newestCacheRecord(page) })
    }
    await context.close()

    mkdirSync(outputDirectory, { recursive: true })
    const retained = new Set()
    const entries = generated.map(({ name, artifact }) => {
      const reusable = {
        schema: artifact.schema,
        producer: artifact.producer,
        key: artifact.key,
        input: artifact.input,
        profile: artifact.profile,
        memoriesAbstracted: artifact.memoriesAbstracted,
        output: artifact.output,
      }
      const filename = `${artifact.key}.json`
      retained.add(filename)
      writeFileSync(join(outputDirectory, filename), `${JSON.stringify(reusable)}\n`)
      return { name, key: artifact.key }
    })
    for (const filename of readdirSync(outputDirectory)) {
      if (filename.endsWith('.json') && !retained.has(filename)) {
        rmSync(join(outputDirectory, filename))
      }
    }
    writeFileSync(manifestPath, `${JSON.stringify({ entries }, null, 2)}\n`)
    process.stdout.write(`Generated ${entries.length} precomputed gate-mode designs.\n`)
  } finally {
    await browser.close()
  }
} finally {
  preview.kill('SIGTERM')
}

function browserExecutable() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    chromium.executablePath(),
    '/usr/bin/chromium',
  ]
  return candidates.find((candidate) => candidate && existsSync(candidate))
}

async function waitForPreview() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (preview.exitCode != null) {
      throw new Error(`Vite preview exited early:\n${previewLog}`)
    }
    try {
      const response = await fetch(baseURL)
      if (response.ok) return
    } catch {
      // Preview is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for Vite preview:\n${previewLog}`)
}

function waitForMapping(page) {
  return page.waitForFunction(
    () => document.querySelector('.pane-right')?.dataset.analysisState === 'current',
    undefined,
    { timeout: 120_000 },
  )
}

function newestCacheRecord(page) {
  return page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const open = indexedDB.open('synth-explorer')
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error)
    })
    const read = database.transaction('syntheses').objectStore('syntheses').getAll()
    const records = await new Promise((resolve, reject) => {
      read.onsuccess = () => resolve(read.result)
      read.onerror = () => reject(read.error)
    })
    const newest = records.sort((left, right) => right.createdAt - left.createdAt)[0]
    if (!newest) throw new Error('Synthesis completed without a cache record')
    if (newest.input.mode !== 'gates') {
      throw new Error(`Expected a gate-mode artifact, received ${newest.input.mode}`)
    }
    return newest
  })
}
