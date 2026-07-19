import { expect, test } from '@playwright/test'

test('shows a branded shell before the application bundle loads', async ({ page }) => {
  await page.route(/\/assets\/index-.*\.js$/, (route) => route.abort())

  await page.goto('/', { waitUntil: 'domcontentloaded' })

  await expect(page.getByTestId('boot-shell')).toBeVisible()
  await expect(page.getByText('Synth Explorer', { exact: true })).toBeVisible()
})
