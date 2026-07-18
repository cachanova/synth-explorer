import { expect, test } from '@playwright/test'

// A dropped connection while downloading the analysis WASM used to poison the
// worker permanently: the rejected load stayed cached, so every later
// synthesis surfaced the same "Validation error (422)" until a full reload.
test('recovers after the analysis engine download fails', async ({ page }) => {
  let blockEngine = true
  await page.route('**/assets/analysis_bg-*.wasm', (route) => {
    if (blockEngine) return route.abort('failed')
    return route.continue()
  })

  await page.goto('/')

  // The initial automatic synthesis runs Yosys fine but cannot load the
  // analysis engine, and the failure is labeled as such (not "Validation").
  const errorStrip = page.locator('.error-strip')
  await expect(errorStrip).toContainText('Engine failed to load (503)', {
    timeout: 90_000,
  })

  // Connectivity returns; re-triggering the same input must retry the engine
  // download in the existing worker instead of replaying the cached failure.
  blockEngine = false
  const editor = page.locator('.cm-content')
  await editor.click()
  await editor.press('Control+End')
  await editor.type(' ')
  await editor.press('Backspace')

  await expect(page.locator('.pane-left .tag')).toHaveText('mapping live', {
    timeout: 90_000,
  })
  await expect(errorStrip).toHaveCount(0)
})
