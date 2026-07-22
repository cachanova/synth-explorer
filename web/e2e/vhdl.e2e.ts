import { expect, test, type Page } from '@playwright/test'
import { retriggerCurrentInput, waitForAnalysisReady } from './helpers'

function recordApiRequests(page: Page): string[] {
  const requests: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      requests.push(`${request.method()} ${url.pathname}`)
    }
  })
  return requests
}

test('synthesizes VHDL-2008 locally with source provenance', async ({ page }) => {
  const apiRequests = recordApiRequests(page)
  // Force the real frontend path even though bundled examples also have an
  // edge-cached artifact for fast first paint.
  await page.route('**/precomputed/*.json', (route) =>
    route.fulfill({ status: 404, body: 'not found' }),
  )
  await page.goto('/')
  await page.getByLabel('Language').selectOption('vhdl')
  await page.getByLabel('Bundled example').selectOption('counter')
  await expect(page.locator('.pane-right')).toHaveAttribute(
    'data-analysis-state',
    'current',
    { timeout: 120_000 },
  )
  await expect(page.locator('.error-strip')).toHaveCount(0)

  const report = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('synth-explorer')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const request = database.transaction('syntheses').objectStore('syntheses').getAll()
    const records = await new Promise<Array<{
      producer: string
      input: { language: string; top: string }
      output: { sourceNetlistJson: string }
    }>>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const record = records.find((entry) => entry.input.language === 'vhdl')
    if (!record) throw new Error('VHDL synthesis cache record is missing')
    const netlist = JSON.parse(record.output.sourceNetlistJson) as {
      modules: Record<string, { cells?: Record<string, { attributes?: { src?: string } }> }>
    }
    const cells = Object.values(netlist.modules).flatMap((module) =>
      Object.values(module.cells ?? {}),
    )
    return {
      producer: record.producer,
      top: record.input.top,
      cells: cells.length,
      vhdlCells: cells.filter((cell) => cell.attributes?.src?.includes('.vhdl:')).length,
    }
  })
  expect(report).toMatchObject({
    producer: expect.stringContaining('ghdl-5.0.1'),
    top: 'counter',
  })
  expect(report.cells).toBeGreaterThan(0)
  expect(report.vhdlCells).toBe(report.cells)

  await page.getByRole('tab', { name: 'Schematic', exact: true }).click()
  await expect(page.locator('.graph-stage svg')).toBeAttached({ timeout: 120_000 })
  await page.getByRole('tab', { name: /counter\.vhdl/ }).click()
  const sourceLine = page.locator('.cm-line', { hasText: "if reset = '1' then" })
  await sourceLine.click()
  await expect.poll(() => page.locator('.g-node-body.hl').count()).toBeGreaterThan(0)
  await expect.poll(() => page.locator('.g-edge.hl').count()).toBeGreaterThan(0)

  // Keep the full schematic stable while clearing the source-originated
  // selection, then reverse-probe one of its known relevant wires.
  const focus = page.getByLabel('Focus')
  await expect(focus).toBeEnabled()
  await focus.uncheck()
  await page.locator('.cm-content').press('Escape')
  await expect(page.locator('.cm-line.cm-src-hl')).toHaveCount(0)
  const edgePoint = await page.locator<SVGPathElement>('.g-edge').first().evaluate((edge) => {
    const point = edge.getPointAtLength(edge.getTotalLength() / 2)
    const matrix = edge.getScreenCTM()
    if (!matrix) throw new Error('VHDL edge has no screen transform')
    const screen = point.matrixTransform(matrix)
    return { x: screen.x, y: screen.y }
  })
  await page.mouse.click(edgePoint.x, edgePoint.y + 4)
  await expect.poll(() => page.locator('.cm-line.cm-src-hl').count()).toBeGreaterThan(0)
  await expect(page.locator('.cm-src-range-hl')).toHaveCount(0)
  expect(apiRequests).toEqual([])
})

test('synthesizes inferred memory and black-box VHDL through the cold engine path', async ({
  page,
}) => {
  test.setTimeout(180_000)
  await page.route('**/precomputed/*.json', (route) =>
    route.fulfill({ status: 404, body: 'not found' }),
  )
  await page.goto('/')
  await page.getByLabel('Language').selectOption('vhdl')
  await page.getByRole('tab', { name: 'Overview', exact: true }).click()
  const example = page.getByLabel('Bundled example')
  const analysis = page.locator('.pane-right')
  const top = page
    .locator('.card')
    .filter({ has: page.getByText('Top', { exact: true }) })
    .locator('.v')

  for (const [name, expectedTop] of [
    ['inferred_fifo', 'inferred_fifo'],
    ['async_fifo_blackbox', 'async_fifo_wrapper'],
  ] as const) {
    await example.selectOption(name)
    await expect(analysis).not.toHaveAttribute('data-analysis-state', 'current')
    await expect(analysis).toHaveAttribute('data-analysis-state', 'current', {
      timeout: 120_000,
    })
    await expect(page.locator('.error-strip')).toHaveCount(0)
    await expect(top).toHaveText(expectedTop)
  }
})

test('surfaces VHDL analysis diagnostics without invoking Yosys', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Language').selectOption('vhdl')
  await page.getByLabel('Bundled example').selectOption('counter')
  await expect(page.locator('.pane-right')).toHaveAttribute(
    'data-analysis-state',
    'current',
    { timeout: 120_000 },
  )

  await page.getByRole('tab', { name: /counter\.vhdl/ }).click()
  const editor = page.locator('.cm-content')
  await editor.click()
  await editor.press('Control+A')
  await page.keyboard.insertText('entity broken is\nend entity')

  const error = page.locator('.error-strip')
  await expect(error).toContainText('GHDL failed to analyze counter.vhdl', {
    timeout: 120_000,
  })
  await error.locator('summary').click()
  await expect(error.locator('pre')).toContainText('missing ";"')
  await expect(error.locator('pre')).not.toContainText('Yosys')
})

test('recovers after the GHDL engine download fails', async ({ page }) => {
  let blockEngine = true
  await page.route('**/precomputed/*.json', (route) =>
    route.fulfill({ status: 404, body: 'not found' }),
  )
  await page.route('**/ghdl/ghdl-synth.wasm*', (route) => {
    if (blockEngine) return route.abort('failed')
    return route.continue()
  })

  await page.goto('/')
  await page.getByLabel('Language').selectOption('vhdl')
  await page.getByLabel('Bundled example').selectOption('counter')
  await expect(page.locator('.error-strip')).toContainText('Tool failed to load (503)', {
    timeout: 120_000,
  })

  blockEngine = false
  await retriggerCurrentInput(page)
  await waitForAnalysisReady(page)
  await expect(page.locator('.error-strip')).toHaveCount(0)
})
