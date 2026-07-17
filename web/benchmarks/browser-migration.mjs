import { writeFile } from 'node:fs/promises'
import { chromium } from '@playwright/test'

const DEFAULT_TRIALS = 5
const DEFAULT_TIMEOUT_MS = 120_000

function usage() {
  return `Usage:
  npm run benchmark:migration -- \\
    --control http://127.0.0.1:8787 \\
    --control-revision <40-character commit> \\
    --candidate http://127.0.0.1:8788 \\
    --candidate-revision <40-character commit> \\
    [--trials ${DEFAULT_TRIALS}] [--output result.json]

The control and candidate must be production builds served by separate local
server processes. The harness runs them sequentially under 0 ms and 150 ms
request-latency profiles.`
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') {
      options.help = true
      continue
    }
    if (!argument.startsWith('--')) throw new Error(`unexpected argument: ${argument}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${argument}`)
    options[argument.slice(2)] = value
    index += 1
  }
  return options
}

function requireUrl(value, name) {
  if (!value) throw new Error(`missing --${name}`)
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`--${name} must use http or https`)
  }
  return url.href.replace(/\/$/, '')
}

function requireRevision(value, name) {
  if (!value || !/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error(`--${name} must be a full 40-character commit hash`)
  }
  return value.toLowerCase()
}

function percentile(values, fraction) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.ceil(fraction * sorted.length) - 1]
}

function summarize(samples) {
  const fields = [
    'duration_ms',
    'requests',
    'transfer_bytes',
    'failed_requests',
    'peak_renderer_js_heap_bytes',
  ]
  return Object.fromEntries(
    fields.map((field) => {
      const values = samples.map((sample) => sample[field])
      return [
        field,
        {
          median: percentile(values, 0.5),
          p95: percentile(values, 0.95),
          min: Math.min(...values),
          max: Math.max(...values),
        },
      ]
    }),
  )
}

function summarizeRuns(runs) {
  const grouped = new Map()
  for (const run of runs) {
    for (const phase of run.phases) {
      const key = `${run.warmth}:${phase.name}`
      const samples = grouped.get(key) ?? []
      samples.push(phase)
      grouped.set(key, samples)
    }
  }
  return Object.fromEntries(
    [...grouped.entries()].map(([key, samples]) => [key, summarize(samples)]),
  )
}

async function attachMetrics(page, latencyMs) {
  const session = await page.context().newCDPSession(page)
  await session.send('Network.enable')
  await session.send('Performance.enable')
  await session.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: latencyMs,
    downloadThroughput: -1,
    uploadThroughput: -1,
    connectionType: 'none',
  })

  const traffic = {
    requests: 0,
    transferBytes: 0,
    failedRequests: 0,
  }
  session.on('Network.requestWillBeSent', ({ request }) => {
    if (/^https?:/.test(request.url)) traffic.requests += 1
  })
  session.on('Network.loadingFinished', ({ encodedDataLength }) => {
    traffic.transferBytes += encodedDataLength
  })
  session.on('Network.loadingFailed', () => {
    traffic.failedRequests += 1
  })

  return { session, traffic }
}

function trafficSnapshot(traffic) {
  return {
    requests: traffic.requests,
    transferBytes: traffic.transferBytes,
    failedRequests: traffic.failedRequests,
  }
}

async function rendererHeapBytes(session) {
  const { metrics } = await session.send('Performance.getMetrics')
  return metrics.find(({ name }) => name === 'JSHeapUsedSize')?.value ?? 0
}

async function measure(name, metrics, action) {
  const before = trafficSnapshot(metrics.traffic)
  let peakHeap = await rendererHeapBytes(metrics.session)
  let sampling = false
  const timer = setInterval(async () => {
    if (sampling) return
    sampling = true
    try {
      peakHeap = Math.max(peakHeap, await rendererHeapBytes(metrics.session))
    } finally {
      sampling = false
    }
  }, 25)
  const started = performance.now()
  try {
    await action()
  } finally {
    clearInterval(timer)
  }
  peakHeap = Math.max(peakHeap, await rendererHeapBytes(metrics.session))
  const after = trafficSnapshot(metrics.traffic)
  return {
    name,
    duration_ms: Number((performance.now() - started).toFixed(2)),
    requests: after.requests - before.requests,
    transfer_bytes: after.transferBytes - before.transferBytes,
    failed_requests: after.failedRequests - before.failedRequests,
    peak_renderer_js_heap_bytes: Math.round(peakHeap),
  }
}

function armSynthesisStart(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const button = document.querySelector('button[title="Synthesize (Ctrl+Enter)"]')
        if (!button) {
          reject(new Error('synthesis button is missing'))
          return
        }
        const timer = window.setTimeout(() => {
          observer.disconnect()
          reject(new Error('synthesis did not start'))
        }, 5_000)
        const observer = new MutationObserver((records) => {
          const disabledWasAdded = records.some(
            (record) =>
              record.type === 'attributes' &&
              record.attributeName === 'disabled' &&
              record.oldValue === null,
          )
          if (!disabledWasAdded) return
          window.clearTimeout(timer)
          observer.disconnect()
          resolve()
        })
        observer.observe(button, {
          attributes: true,
          attributeOldValue: true,
        })
      }),
  )
}

async function waitForSynthesis(page, running) {
  await running
  const ready = page.getByRole('button', { name: 'Synthesize', exact: true })
  await ready.waitFor()
  if (!(await ready.isEnabled())) throw new Error('synthesis button did not become enabled')
  await page.getByRole('tab', { name: 'Overview', exact: true }).click()
  await page.getByText('Structural logic depth', { exact: true }).waitFor()
}

async function runFlow(page, metrics, url, warmth) {
  const phases = []
  phases.push(
    await measure('page_ready', metrics, async () => {
      if (warmth === 'cold') {
        await page.goto(url, { waitUntil: 'networkidle' })
      } else {
        await page.reload({ waitUntil: 'networkidle' })
      }
      await page.getByLabel('Example').waitFor()
      await page.getByRole('button', { name: 'Synthesize', exact: true }).waitFor()
    }),
  )

  await page.getByLabel('Example').selectOption('reg_mux')
  phases.push(
    await measure('synthesize_to_overview', metrics, async () => {
      const running = armSynthesisStart(page)
      await page.getByRole('button', { name: 'Synthesize', exact: true }).click()
      await waitForSynthesis(page, running)
    }),
  )

  phases.push(
    await measure('endpoints_ready', metrics, async () => {
      await page.getByRole('tab', { name: 'Endpoints', exact: true }).click()
      await page.getByText(/^Logical endpoints \(\d+ matched \/ \d+\)$/).waitFor()
    }),
  )

  phases.push(
    await measure('endpoint_to_cone', metrics, async () => {
      await page.locator('.virtual-table-scroll tr.clickable').first().click()
      const schematic = page.getByRole('tab', { name: 'Schematic', exact: true })
      await schematic.waitFor()
      if ((await schematic.getAttribute('aria-selected')) !== 'true') {
        throw new Error('endpoint selection did not open the Schematic tab')
      }
      await page.locator('.g-node-body').first().waitFor()
    }),
  )

  phases.push(
    await measure('paths_ready', metrics, async () => {
      await page.getByRole('tab', { name: 'Paths', exact: true }).click()
      await page.getByText(/^Longest logical path variants \(\d+\)$/).waitFor()
    }),
  )

  phases.push(
    await measure('fanout_ready', metrics, async () => {
      await page.getByRole('tab', { name: 'Fanout', exact: true }).click()
      const title = page.getByText(/^High-fanout drivers \(\d+\)$/)
      const empty = page.getByText('No fanout data.', { exact: true })
      await title.or(empty).waitFor()
    }),
  )

  return phases
}

async function runTarget(browser, target, latencyMs, trials, timeoutMs) {
  const runs = []
  for (let trial = 1; trial <= trials; trial += 1) {
    const context = await browser.newContext()
    const page = await context.newPage()
    page.setDefaultTimeout(timeoutMs)
    const metrics = await attachMetrics(page, latencyMs)
    for (const warmth of ['cold', 'warm']) {
      try {
        const phases = await runFlow(page, metrics, target.url, warmth)
        runs.push({ trial, warmth, phases })
      } catch (error) {
        throw new Error(
          `${target.label}, ${latencyMs} ms latency, trial ${trial}, ${warmth}: ${error.message}`,
          { cause: error },
        )
      }
    }
    await context.close()
  }
  return { latency_ms: latencyMs, runs, summary: summarizeRuns(runs) }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }

  const trials = Number(options.trials ?? DEFAULT_TRIALS)
  if (!Number.isInteger(trials) || trials < 1) throw new Error('--trials must be a positive integer')
  const timeoutMs = Number(options.timeout ?? DEFAULT_TIMEOUT_MS)
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('--timeout must be a positive integer')

  const targets = [
    {
      label: 'control',
      url: requireUrl(options.control, 'control'),
      revision: requireRevision(options['control-revision'], 'control-revision'),
    },
    {
      label: 'candidate',
      url: requireUrl(options.candidate, 'candidate'),
      revision: requireRevision(options['candidate-revision'], 'candidate-revision'),
    },
  ]

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  })
  const result = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    browser_version: browser.version(),
    trials,
    profiles: [],
  }
  try {
    for (const latencyMs of [0, 150]) {
      const targetsResult = []
      for (const target of targets) {
        process.stderr.write(`Running ${target.label} at ${latencyMs} ms latency...\n`)
        targetsResult.push({
          label: target.label,
          url: target.url,
          revision: target.revision,
          ...(await runTarget(browser, target, latencyMs, trials, timeoutMs)),
        })
      }
      result.profiles.push({ latency_ms: latencyMs, targets: targetsResult })
    }
  } finally {
    await browser.close()
  }

  const output = `${JSON.stringify(result, null, 2)}\n`
  if (options.output) {
    await writeFile(options.output, output, 'utf8')
    process.stdout.write(`Wrote ${options.output}\n`)
  } else {
    process.stdout.write(output)
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n\n${usage()}\n`)
  process.exitCode = 1
})
