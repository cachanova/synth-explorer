import { expect, test } from '@playwright/test'

const COMMIT_PAGE =
  /^https:\/\/github\.com\/cachanova\/synth-explorer\/commit\/([0-9a-f]{40})$/

test('names the commit the running bundle was built from', async ({ page }) => {
  await page.goto('/')

  await page.getByRole('button', { name: 'Settings' }).click()

  const settings = page.getByRole('dialog', { name: 'Settings' })
  const commit = settings.getByRole('link', {
    name: /^Build commit [0-9a-f]{12} on GitHub/,
  })
  await expect(commit).toBeVisible()

  const href = (await commit.getAttribute('href')) ?? ''
  const sha = COMMIT_PAGE.exec(href)?.[1]
  expect(sha, `commit link href was ${href}`).toBeDefined()
  await expect(commit).toHaveText(sha!.slice(0, 12))
})
