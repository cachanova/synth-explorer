import { expect, test } from '@playwright/test'
import {
  cacheEntryCount,
  recordApiRequests,
  retriggerCurrentInput,
  waitForAutomaticSynthesis,
} from './helpers'

test('synthesizes and analyzes locally, then reuses the per-browser cache', async ({ page }) => {
  const apiRequests = recordApiRequests(page)
  await page.goto('/')

  await expect(page.getByText('Synth Explorer', { exact: true })).toBeVisible()
  const flags = page.getByLabel('Synthesis flags')
  await waitForAutomaticSynthesis(page, async () => {
    await page.getByLabel('Bundled example').selectOption('reg_mux')
    await page.getByLabel('Platform').selectOption('xilinx')
  })
  await expect(flags).toHaveValue('-narrowcarry 8 -nowidelut -noiopad')

  await page.getByRole('tab', { name: 'Overview', exact: true }).click()
  await expect(page.locator('.card').filter({ hasText: 'Cells' }).locator('.v')).toHaveText(/^\d+$/)
  expect(await cacheEntryCount(page)).toBeGreaterThanOrEqual(1)

  const started = Date.now()
  await waitForAutomaticSynthesis(page, () => retriggerCurrentInput(page))
  // Cache reuse still reinitializes analysis in a worker. Keep this well below
  // cold synthesis without making the assertion depend on sub-second CI load.
  expect(Date.now() - started).toBeLessThan(2_000)

  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('synth-explorer')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const transaction = database.transaction('syntheses', 'readwrite')
    const store = transaction.objectStore('syntheses')
    const read = store.getAll()
    const records = await new Promise<Array<{
      input: { mode: string }
      output: { netlistJson: string }
    }>>(
      (resolve, reject) => {
        read.onsuccess = () => resolve(read.result)
        read.onerror = () => reject(read.error)
      },
    )
    const xilinx = records.find((record) => record.input.mode === 'xilinx')
    if (!xilinx) throw new Error('xilinx cache entry is missing')
    xilinx.output.netlistJson = '{'
    store.put(xilinx)
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  })
  await waitForAutomaticSynthesis(page, () => retriggerCurrentInput(page))
  const repaired = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('synth-explorer')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const read = database.transaction('syntheses').objectStore('syntheses').getAll()
    const records = await new Promise<Array<{
      input: { mode: string }
      output: { netlistJson: string }
    }>>(
      (resolve, reject) => {
        read.onsuccess = () => resolve(read.result)
        read.onerror = () => reject(read.error)
      },
    )
    const xilinx = records.find((record) => record.input.mode === 'xilinx')
    if (!xilinx) throw new Error('xilinx cache entry is missing')
    JSON.parse(xilinx.output.netlistJson)
    return records.length
  })
  expect(repaired).toBeGreaterThanOrEqual(1)

  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Clear synthesis cache' }).click()
  await expect(page.getByRole('status')).toHaveText('Cleared from this browser.')
  expect(await cacheEntryCount(page)).toBe(0)
  expect(apiRequests).toEqual([])
})

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
  const edgePoint = await page.locator('.g-edge').first().evaluate((edge) => {
    if (!(edge instanceof SVGPathElement)) throw new Error('VHDL edge is not a path')
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
