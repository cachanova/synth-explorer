import { expect, test } from '@playwright/test'

test('shows a branded shell before the application bundle loads', async ({ page }) => {
  await page.route(/\/assets\/index-.*\.js$/, (route) => route.abort())

  await page.goto('/', { waitUntil: 'domcontentloaded' })

  await expect(page.getByTestId('boot-shell')).toBeVisible()
  await expect(page.getByText('Synth Explorer', { exact: true })).toBeVisible()
})

test('matches the narrow editor workspace before the application bundle loads', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.route(/\/assets\/index-.*\.js$/, (route) => route.abort())

  await page.goto('/', { waitUntil: 'domcontentloaded' })

  const shell = page.getByTestId('boot-shell')
  await expect(shell.locator('.boot-workspace-nav')).toBeVisible()
  await expect(shell.locator('.boot-workspace-nav')).toContainText(/Editor\s+Analysis/)
  await expect(shell.locator('.boot-pane-left')).toBeVisible()
  await expect(shell.locator('.boot-pane-right')).toBeHidden()
  await expect
    .poll(async () => Math.round((await shell.locator('.boot-pane-left').boundingBox())?.width ?? 0))
    .toBe(390)
})
