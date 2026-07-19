import { expect, type Page } from '@playwright/test'

export async function waitForAnalysisReady(page: Page) {
  await expect(page.locator('.pane-right')).toHaveAttribute('data-analysis-state', 'current', {
    timeout: 120_000,
  })
  await expect(page.locator('.graph-stage svg')).toBeAttached({ timeout: 120_000 })
  await expect(page.locator('.graph-loading-indicator')).toHaveCount(0)
}

// A no-op edit (type a space, delete it) marks the input changed so the
// auto-synthesis debounce re-runs the current design.
export async function retriggerCurrentInput(page: Page) {
  const editor = page.locator('.cm-content')
  await editor.click()
  await editor.press('Control+End')
  await editor.type(' ')
  await editor.press('Backspace')
}
