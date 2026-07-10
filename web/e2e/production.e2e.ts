import { expect, test } from '@playwright/test'

test('synthesizes from the webpage with the entered Yosys flags', async ({
  page,
}) => {
  await page.goto('/')

  await expect(page.getByText('Synth Explorer', { exact: true })).toBeVisible()
  const flags = page.getByLabel('Synthesis flags')
  await expect(flags).toBeVisible()
  await flags.fill('-noabc')

  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/synthesize') &&
      response.request().method() === 'POST',
  )
  await page.getByRole('button', { name: 'Synthesize', exact: true }).click()

  const response = await responsePromise
  expect(response.ok()).toBe(true)
  expect(response.request().postDataJSON()).toMatchObject({
    mode: 'gates',
    extra_args: '-noabc',
  })
  await expect(
    page.locator('.card').filter({ hasText: 'Cells' }).locator('.v'),
  ).toHaveText(/^\d+$/)
})
