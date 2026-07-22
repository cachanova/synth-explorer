#!/usr/bin/env node
// Verify that the production build emitted the canonical SchemWeave worker and
// its WebAssembly payload. Browser E2E exercises the worker protocol itself;
// this check catches bundling regressions before a server is started.

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const assets = join(root, 'dist', 'assets')
const files = readdirSync(assets)

const workerFile = files.find(
  (file) => file.startsWith('schemweave.worker-') && file.endsWith('.js'),
)
if (!workerFile) {
  console.error('FAIL: no schemweave.worker-*.js chunk in dist/assets — run npm run build first')
  process.exit(1)
}

const workerCode = readFileSync(join(assets, workerFile), 'utf8')
const wasmReferences = [...workerCode.matchAll(/[`"']([^`"']+\.wasm)[`"']/g)]
  .map((match) => match[1].split('/').at(-1))
const wasmFile = wasmReferences.find((file) => file && files.includes(file))
if (!wasmFile) {
  console.error(`FAIL: ${workerFile} does not reference an emitted WASM asset`)
  process.exit(1)
}

const wasm = readFileSync(join(assets, wasmFile))
if (wasm.length < 8 || !wasm.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109]))) {
  console.error(`FAIL: ${wasmFile} is not a valid WebAssembly binary`)
  process.exit(1)
}

for (const obsoletePrefix of ['elk.worker-', 'exploration.worker-']) {
  const obsolete = files.find(
    (file) => file.startsWith(obsoletePrefix) && file.endsWith('.js'),
  )
  if (obsolete) {
    console.error(`FAIL: obsolete worker was emitted: ${obsolete}`)
    process.exit(1)
  }
}

console.log(
  `PASS: ${workerFile} references valid ${wasmFile} (${wasm.length} bytes), with no obsolete worker chunks`,
)
