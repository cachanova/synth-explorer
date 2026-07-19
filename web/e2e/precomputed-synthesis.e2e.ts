import { expect, test } from '@playwright/test'
import examples from '../src/data/examples/manifest.json' with { type: 'json' }

test('opens the default and example designs without downloading Yosys', async ({ page }) => {
  test.setTimeout(60_000)
  const yosysAssets: string[] = []
  await page.route('**/yosys/**', (route) => {
    yosysAssets.push(route.request().url())
    return route.abort()
  })

  await page.goto('/')

  const analysisPane = page.locator('.pane-right')
  await expect(analysisPane).toHaveAttribute('data-analysis-state', 'current', {
    timeout: 10_000,
  })
  await page.getByRole('tab', { name: 'Overview', exact: true }).click()
  const topValue = page
    .locator('.card')
    .filter({ has: page.getByText('Top', { exact: true }) })
    .locator('.v')
  await expect(topValue).toHaveText('top')

  const exampleSelect = page.getByLabel('Example')
  for (const example of examples) {
    await exampleSelect.selectOption(example.name)
    await expect(analysisPane).not.toHaveAttribute('data-analysis-state', 'current')
    await expect(analysisPane).toHaveAttribute('data-analysis-state', 'current', {
      timeout: 10_000,
    })
    await expect(topValue).toHaveText(example.top)
  }
  expect(yosysAssets).toEqual([])
})

test('falls back to local Yosys when a precomputed netlist is unusable', async ({ page }) => {
  test.setTimeout(120_000)
  const yosysAssets: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/yosys/')) {
      yosysAssets.push(request.url())
    }
  })
  await page.route('**/precomputed/*.json', async (route) => {
    const response = await route.fetch()
    const artifact = (await response.json()) as {
      output: { netlistJson: string; sourceNetlistJson: string }
    }
    artifact.output.netlistJson = '{}'
    artifact.output.sourceNetlistJson = '{}'
    await route.fulfill({ json: artifact })
  })

  await page.goto('/')

  await expect(page.locator('.pane-right')).toHaveAttribute(
    'data-analysis-state',
    'current',
    { timeout: 120_000 },
  )
  expect(yosysAssets.length).toBeGreaterThan(0)
})
