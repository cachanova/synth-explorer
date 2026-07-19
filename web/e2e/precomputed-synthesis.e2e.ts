import { expect, test } from '@playwright/test'

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

  const exampleSelect = page.getByLabel('Example')
  const examples = await exampleSelect.locator('option').evaluateAll((options) =>
    options.map((option) => (option as HTMLOptionElement).value).filter(Boolean),
  )
  for (const example of examples) {
    await exampleSelect.selectOption(example)
    await expect(analysisPane).not.toHaveAttribute('data-analysis-state', 'current')
    await expect(analysisPane).toHaveAttribute('data-analysis-state', 'current', {
      timeout: 10_000,
    })
  }
  expect(yosysAssets).toEqual([])
})
