import { expect, test } from '@playwright/test'
import examples from '../src/data/examples/manifest.json' with { type: 'json' }

test('opens every language variant without downloading synthesis engines', async ({ page }) => {
  test.setTimeout(120_000)
  const synthesisAssets: string[] = []
  await page.route(/\/(yosys|ghdl)\//, (route) => {
    synthesisAssets.push(route.request().url())
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

  const exampleSelect = page.getByLabel('Bundled example')
  const languageSelect = page.getByLabel('Language')
  for (const language of ['verilog', 'vhdl'] as const) {
    await languageSelect.selectOption(language)
    for (const example of examples) {
      await exampleSelect.selectOption(example.name)
      await expect(analysisPane).not.toHaveAttribute('data-analysis-state', 'current')
      await expect(analysisPane).toHaveAttribute('data-analysis-state', 'current', {
        timeout: 10_000,
      })
      await expect(topValue).toHaveText(example.variants[language].top)
      const sourceTabs = page.getByRole('tablist', { name: 'Source files' }).getByRole('tab')
      const names = await sourceTabs.evaluateAll((tabs) =>
        tabs.map((tab) => tab.getAttribute('aria-label')?.split('. Press')[0] ?? ''),
      )
      expect(names).toHaveLength(example.variants[language].files.length)
      expect(
        names.every((name) =>
          language === 'vhdl' ? /\.vhdl?$/.test(name) : /\.s?vh?$/.test(name),
        ),
      ).toBe(true)
    }
  }
  expect(synthesisAssets).toEqual([])
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
