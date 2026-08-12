import { expect, test } from '@playwright/test'

const COMMIT_PAGE = /^https:\/\/github\.com\/cachanova\/synth-explorer\/commit\/[0-9a-f]{40}$/

test('names the commit the running bundle was built from', async ({ page }) => {
  await page.goto('/')

  await page.getByRole('button', { name: 'Settings' }).click()

  const settings = page.getByRole('dialog', { name: 'Settings' })
  const commit = settings.getByRole('link', { name: /^[0-9a-f]{12}$/ })
  await expect(commit).toBeVisible()

  const href = await commit.getAttribute('href')
  expect(href).toMatch(COMMIT_PAGE)
  await expect(commit).toHaveText(href!.slice(-40, -28))
})
