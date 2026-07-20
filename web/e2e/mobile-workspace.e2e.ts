import { expect, test } from '@playwright/test'

test('uses full-width Editor and Analysis views on a portrait phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')

  const workspaceNavigation = page.getByRole('navigation', { name: 'Workspace views' })
  const editorPane = page.locator('.pane-left')
  const analysisPane = page.locator('.pane-right')

  await expect(workspaceNavigation).toBeVisible()
  await expect(page.getByRole('button', { name: 'Editor', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(editorPane).toBeVisible()
  await expect(analysisPane).toBeHidden()
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    )
    .toBe(true)

  await editorPane.evaluate((element) => Reflect.set(window, '__mobileEditorPane', element))
  await page.getByRole('button', { name: 'Analysis', exact: true }).click()

  await expect(page.getByRole('button', { name: 'Analysis', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(editorPane).toBeHidden()
  await expect(analysisPane).toBeVisible()
  await expect
    .poll(async () => Math.round((await analysisPane.boundingBox())?.width ?? 0))
    .toBeGreaterThanOrEqual(380)

  await page.getByRole('button', { name: 'Editor', exact: true }).click()
  await expect(editorPane).toBeVisible()
  expect(
    await editorPane.evaluate(
      (element) => Reflect.get(window, '__mobileEditorPane') === element,
    ),
  ).toBe(true)
})

test('keeps the resizable side-by-side workspace on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/')

  await expect(page.getByRole('navigation', { name: 'Workspace views' })).toBeHidden()
  await expect(page.locator('.pane-left')).toBeVisible()
  await expect(page.locator('.pane-right')).toBeVisible()
  await expect(page.locator('.divider')).toBeVisible()
})
