import { expect, test } from '@playwright/test'
import {
  CAPABILITIES_SEEN_KEY,
  CAPABILITIES_VERSION,
} from '../src/lib/capabilities'

test('shows capabilities once and keeps the full catalog available in settings', async ({
  baseURL,
  browser,
}) => {
  const context = await browser.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
  })
  const page = await context.newPage()

  await page.goto('/')

  const dialog = page.getByRole('dialog', { name: 'Available Tools' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('heading', { name: 'Synthesis' })).toBeVisible()
  await expect(dialog.getByRole('heading', { name: 'Analysis' })).toBeVisible()
  await expect(dialog.getByRole('heading', { name: 'Schematic' })).toBeVisible()
  await expect(dialog.getByText('Browser Yosys and local Vivado')).toBeVisible()
  await expect(dialog.getByText('Not a timing-closure report.')).toBeVisible()

  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toHaveCount(0)
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), CAPABILITIES_SEEN_KEY))
    .toBe(String(CAPABILITIES_VERSION))

  await page.reload()
  await expect(page.getByRole('dialog', { name: 'Available Tools' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Capabilities' }).click()
  const reopened = page.getByRole('dialog', { name: 'Available Tools' })
  await expect(reopened).toBeVisible()
  await expect(reopened.getByText('Source cross-probing')).toBeVisible()
  await reopened.getByRole('button', { name: 'Close' }).click()
  await expect(reopened).toHaveCount(0)

  await context.close()
})
