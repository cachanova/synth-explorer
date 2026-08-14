import { expect, test } from '@playwright/test'
import { retriggerCurrentInput, waitForAnalysisReady } from './helpers'

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

  await page.getByRole('tab', { name: 'Schematic', exact: true }).click()
  const blackbox = page.locator(
    '.g-node-body[data-node-tooltip^="async_fifo_ip — fifo_ip"]',
  )
  await expect(blackbox).toHaveCount(1)
  await expect(page.locator('.g-node-body[data-node-tooltip*="$paramod"]')).toHaveCount(0)
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
  await expect(page.locator('.error-strip')).toContainText('Tool failed to load', {
    timeout: 120_000,
  })

  blockEngine = false
  await retriggerCurrentInput(page)
  await waitForAnalysisReady(page)
  await expect(page.locator('.error-strip')).toHaveCount(0)
})
