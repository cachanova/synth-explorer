#!/usr/bin/env node
// Verifies the PRODUCTION-BUILT elk worker chunk end-to-end without a browser:
// runs dist/assets/elk.worker-*.js inside a VM context shaped like a Web
// Worker global scope (self defined, document NOT defined, postMessage
// captured), sends a layout request through the worker's onmessage handler,
// and asserts a laid-out graph comes back with coordinates.
//
// This reproduces exactly the environment where the "o is not a constructor"
// elkjs interop bug fired. Run after `npm run build`:  node scripts/verify-worker.mjs

import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const assets = join(root, 'dist', 'assets')

const workerFile = readdirSync(assets).find(
  (f) => f.startsWith('elk.worker-') && f.endsWith('.js'),
)
if (!workerFile) {
  console.error('FAIL: no elk.worker-*.js chunk in dist/assets — run npm run build first')
  process.exit(1)
}
const code = readFileSync(join(assets, workerFile), 'utf8')

// --- worker-like global scope: self, postMessage, timers; NO document ---
const messages = []
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  queueMicrotask,
  postMessage: (m) => messages.push(m),
  navigator: { userAgent: 'node-vm' },
  location: { href: 'http://localhost/worker.js' },
}
sandbox.self = sandbox
sandbox.globalThis = sandbox
vm.createContext(sandbox)

if ('document' in sandbox) {
  console.error('FAIL: harness precondition broken (document defined)')
  process.exit(1)
}

try {
  vm.runInContext(code, sandbox, { filename: workerFile })
} catch (e) {
  console.error(`FAIL: worker chunk threw at eval time: ${e}`)
  process.exit(1)
}

if (typeof sandbox.onmessage !== 'function' && typeof sandbox.self.onmessage !== 'function') {
  console.error(
    'FAIL: worker chunk did not install self.onmessage (elk-worker may have hijacked it or eval order broke)',
  )
  process.exit(1)
}
// --- drive the worker protocol with a real layered-layout request ---
const graph = {
  id: 'root',
  layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT' },
  children: [
    { id: '1', width: 80, height: 46 },
    { id: '2', width: 80, height: 46 },
    { id: '3', width: 80, height: 46 },
  ],
  edges: [
    { id: 'e0', sources: ['1'], targets: ['2'] },
    { id: 'e1', sources: ['2'], targets: ['3'] },
  ],
}

// Build the request inside the VM realm: elk's GWT code is realm-sensitive
// (host-realm objects/arrays fail its internal type checks), and in a real
// browser worker structuredClone delivers same-realm objects anyway.
vm.runInContext(
  `(self.onmessage ?? globalThis.onmessage)({ data: JSON.parse(${JSON.stringify(
    JSON.stringify({ id: 42, graph }),
  )}) })`,
  sandbox,
)

// The fake elk worker dispatches via setTimeout(0); poll for the reply.
const deadline = Date.now() + 10000
while (messages.length === 0 && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 25))
}

if (messages.length === 0) {
  console.error('FAIL: no response from worker within 10s')
  process.exit(1)
}
const msg = messages[0]
if (!msg.ok) {
  console.error(`FAIL: worker replied with error: ${msg.error}`)
  process.exit(1)
}
const res = msg.result
const allPlaced =
  Array.isArray(res.children) &&
  res.children.length === 3 &&
  res.children.every((c) => typeof c.x === 'number' && typeof c.y === 'number')
const routed =
  Array.isArray(res.edges) && res.edges.every((e) => e.sections?.length > 0)

if (msg.id !== 42 || !allPlaced || !routed || !(res.width > 0)) {
  console.error('FAIL: layout result malformed:', JSON.stringify(res).slice(0, 400))
  process.exit(1)
}

console.log(
  `PASS: ${workerFile} constructed ELK and returned a layered layout ` +
    `(root ${res.width}x${res.height}, children at x=${res.children
      .map((c) => c.x)
      .join(',')})`,
)
