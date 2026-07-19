import type { Page } from '@playwright/test'

// A no-op edit (type a space, delete it) marks the input changed so the
// auto-synthesis debounce re-runs the current design.
export async function retriggerCurrentInput(page: Page) {
  const editor = page.locator('.cm-content')
  await editor.click()
  await editor.press('Control+End')
  await editor.type(' ')
  await editor.press('Backspace')
}
