import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'

test('keeps long metadata values inside their stat cards', async ({ page }) => {
  const styles = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')

  await page.setContent(`
    <style>${styles}</style>
    <div class="cards" style="width: 327px">
      <div class="card">
        <div class="k">Top</div>
        <div class="v" style="font-size: 15px; font-family: var(--mono)">
          round_robin_arbiter
        </div>
      </div>
      <div class="card">
        <div class="k">Tool</div>
        <div class="v" style="font-size: 15px; font-family: var(--mono)">Yosys</div>
      </div>
    </div>
  `)

  const topCard = page.locator('.card').first()
  await expect(topCard).toHaveText(/round_robin_arbiter/)
  await expect
    .poll(() => topCard.evaluate((card) => card.scrollWidth <= card.clientWidth))
    .toBe(true)
})
