import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { readFile, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { mkdtemp } from 'node:fs/promises'

const execFile = promisify(execFileCallback)
const scriptDir = dirname(fileURLToPath(import.meta.url))
const publicDir = resolve(scriptDir, '../public')
const galleryScript = join(publicDir, 'logo-lab/app.js')

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
}

const interactionHarness = [
  '<!doctype html>',
  '<html><body>',
  '<iframe id="gallery"></iframe>',
  '<output id="result">PENDING</output>',
  '<script>',
  "const frame = document.querySelector('#gallery')",
  "const result = document.querySelector('#result')",
  'const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))',
  "const check = (condition, message) => { if (!condition) throw new Error(message) }",
  "frame.addEventListener('load', async () => {",
  '  try {',
  '    const doc = frame.contentDocument',
  "    check(doc.querySelectorAll('.logo-card').length === 63, 'initial card count')",
  "    check(doc.querySelector('#selection-id').textContent === 'N07', 'hash selection')",
  "    doc.querySelector('.filter[data-family=signal]').click()",
  "    check(doc.querySelectorAll('.logo-card').length === 9, 'signal filter')",
  "    const search = doc.querySelector('#search')",
  "    search.value = 'phase'",
  "    search.dispatchEvent(new Event('input', { bubbles: true }))",
  "    check(doc.querySelectorAll('.logo-card').length === 1, 'search result count')",
  "    check(doc.querySelector('.logo-card h3').textContent === 'Phase Pair', 'search result')",
  "    doc.querySelector('.theme-button[data-theme=light]').click()",
  "    check(doc.querySelector('#selected-stage').classList.contains('theme-light'), 'light theme')",
  "    doc.querySelector('.filter[data-family=all]').click()",
  "    search.value = ''",
  "    search.dispatchEvent(new Event('input', { bubbles: true }))",
  "    doc.querySelector('input[value=M01]').click()",
  "    check(doc.querySelector('#selection-id').textContent === 'M01', 'radio selection')",
  "    check(doc.querySelector('input[value=M01]').checked, 'native radio state')",
  "    Object.defineProperty(frame.contentWindow.navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) }, configurable: true })",
  '    doc.execCommand = () => false',
  "    doc.querySelector('#copy-choice').click()",
  '    await delay(100)',
  "    check(doc.querySelector('#toast').textContent.startsWith('Copy failed'), 'copy failure feedback')",
  "    frame.contentWindow.location.hash = 'bogus'",
  '    await delay(100)',
  "    check(doc.querySelector('#selection-id').textContent === 'None', 'invalid hash clears selection')",
  "    check(frame.contentWindow.localStorage.getItem('synth-explorer-logo-choice') === null, 'invalid hash clears storage')",
  "    result.textContent = 'PASS interactions'",
  '  } catch (error) {',
  "    result.textContent = 'FAIL ' + error.message",
  '  }',
  '})',
  "frame.src = '/logo-lab/index.html#n07'",
  '</scr' + 'ipt>',
  '</body></html>',
].join('\n')

function countMatches(text, pattern) {
  return Array.from(text.matchAll(pattern)).length
}

async function findChromium() {
  const candidates = [
    process.env.CHROMIUM_BIN,
    'chromium',
    'chromium-browser',
    'google-chrome',
    'google-chrome-stable',
  ].filter(Boolean)

  for (const candidate of candidates) {
    try {
      await execFile(candidate, ['--version'], { timeout: 5_000 })
      return candidate
    } catch {
      // Try the next supported binary name.
    }
  }

  throw new Error('Chromium not found; set CHROMIUM_BIN to run the logo-lab browser smoke test')
}

function createStaticServer() {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/__logo_lab_test__.html') {
        response.writeHead(200, {
          'Cache-Control': 'no-store',
          'Content-Type': 'text/html; charset=utf-8',
        })
        response.end(interactionHarness)
        return
      }

      const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, '')
      let filePath = resolve(publicDir, relativePath)

      if (filePath !== publicDir && !filePath.startsWith(publicDir + sep)) {
        response.writeHead(403).end('Forbidden')
        return
      }

      const fileStat = await stat(filePath)
      if (fileStat.isDirectory()) filePath = join(filePath, 'index.html')

      const body = await readFile(filePath)
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': mimeTypes[extname(filePath)] ?? 'application/octet-stream',
      })
      response.end(body)
    } catch {
      response.writeHead(404).end('Not found')
    }
  })
}

async function listen(server) {
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })

  const address = server.address()
  assert(address && typeof address !== 'string')
  return 'http://127.0.0.1:' + address.port
}

async function dumpDom(browser, url, profileDir) {
  const { stdout } = await execFile(
    browser,
    [
      '--headless',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-background-networking',
      '--disable-component-update',
      '--no-first-run',
      '--virtual-time-budget=1800',
      '--user-data-dir=' + profileDir,
      '--dump-dom',
      url,
    ],
    { maxBuffer: 64 * 1024 * 1024, timeout: 30_000 },
  )
  return stdout
}

const source = await readFile(galleryScript, 'utf8')
const ids = Array.from(source.matchAll(/id: '([A-Z][0-9]{2})'/g), (match) => match[1])
assert.equal(ids.length, 63, 'catalog must contain 63 logo IDs')
assert.equal(new Set(ids).size, 63, 'catalog logo IDs must be unique')

const browser = await findChromium()
const server = createStaticServer()
const origin = await listen(server)
const profileDir = await mkdtemp(join(tmpdir(), 'synth-logo-lab-'))
const invalidProfileDir = await mkdtemp(join(tmpdir(), 'synth-logo-lab-invalid-'))
const interactionProfileDir = await mkdtemp(join(tmpdir(), 'synth-logo-lab-interaction-'))
const seProfileDir = await mkdtemp(join(tmpdir(), 'synth-logo-lab-se-'))

try {
  const selectedDom = await dumpDom(
    browser,
    origin + '/logo-lab/index.html#m01',
    profileDir,
  )
  assert.equal(countMatches(selectedDom, /class="logo-card/g), 63, 'must render 63 cards')
  assert.equal(countMatches(selectedDom, /class="logo-radio"/g), 63, 'must render 63 radios')
  assert.match(selectedDom, /id="selection-id">M01</, 'hash must select M01')
  assert.match(selectedDom, /id="decision-title">Circuit S</, 'selected name must render')
  assert.doesNotMatch(selectedDom, /stroke-width="[^"]*\/>/, 'SVG attributes must be well formed')
  assert.doesNotMatch(selectedDom, /&gt;&lt;/, 'SVG markup must not rely on parser recovery')

  const persistedDom = await dumpDom(
    browser,
    origin + '/logo-lab/index.html',
    profileDir,
  )
  assert.match(persistedDom, /id="selection-id">M01</, 'stored selection must survive reload')

  const invalidDom = await dumpDom(
    browser,
    origin + '/logo-lab/index.html#%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E',
    invalidProfileDir,
  )
  assert.match(invalidDom, /id="selection-id">None</, 'invalid hash must remain unselected')
  assert.doesNotMatch(invalidDom, /<img src="x"/, 'hash content must never become markup')

  const seDom = await dumpDom(
    browser,
    origin + '/logo-lab/index.html?family=se#e13',
    seProfileDir,
  )
  assert.equal(countMatches(seDom, /class="logo-card/g), 15, 'SE filter must render 15 cards')
  assert.match(seDom, /id="selection-id">E13</, 'SE deep link must select E13')
  assert.match(seDom, /data-family="se" aria-pressed="true"/, 'SE filter must be active')

  const interactionDom = await dumpDom(
    browser,
    origin + '/__logo_lab_test__.html',
    interactionProfileDir,
  )
  assert.match(interactionDom, /id="result">PASS interactions</, 'gallery interactions must pass')

  process.stdout.write('Logo lab verified: 63 unique options, valid SVG DOM, filters, search, themes, radios, persistence, copy feedback, and hash handling.\n')
} finally {
  await new Promise((resolveClose) => server.close(resolveClose))
  await Promise.all([
    rm(profileDir, { recursive: true, force: true }),
    rm(invalidProfileDir, { recursive: true, force: true }),
    rm(interactionProfileDir, { recursive: true, force: true }),
    rm(seProfileDir, { recursive: true, force: true }),
  ])
}
