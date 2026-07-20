import { expect, test } from '@playwright/test'

test('uses full-width Editor and Analysis views on a narrow phone', async ({ page }) => {
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

  const editor = page.locator('.cm-content')
  await editor.click()
  await editor.press('Control+End')
  await page.keyboard.insertText('\n// mobile workspace state')
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
  await expect
    .poll(() => analysisPane.evaluate((element) => element.scrollWidth <= element.clientWidth))
    .toBe(true)
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    )
    .toBe(true)

  await page.getByRole('button', { name: 'Editor', exact: true }).click()
  await expect(editorPane).toBeVisible()
  await expect(editor).toContainText('// mobile workspace state')
  expect(
    await editorPane.evaluate(
      (element) => Reflect.get(window, '__mobileEditorPane') === element,
    ),
  ).toBe(true)

  await page.setViewportSize({ width: 667, height: 375 })
  await expect(workspaceNavigation).toBeVisible()
  await expect(editorPane).toBeVisible()
  await expect(analysisPane).toBeHidden()
})

test('keeps the resizable side-by-side workspace on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/')

  await expect(page.getByRole('navigation', { name: 'Workspace views' })).toBeHidden()
  const editorPane = page.locator('.pane-left')
  await expect(editorPane).toBeVisible()
  await expect(page.locator('.pane-right')).toBeVisible()
  const divider = page.locator('.divider')
  await expect(divider).toBeVisible()

  const beforeWidth = Math.round((await editorPane.boundingBox())?.width ?? 0)
  const dividerBox = await divider.boundingBox()
  if (!dividerBox) throw new Error('desktop divider has no bounding box')
  await page.mouse.move(
    dividerBox.x + dividerBox.width / 2,
    dividerBox.y + dividerBox.height / 2,
  )
  await page.mouse.down()
  await page.mouse.move(760, dividerBox.y + dividerBox.height / 2)
  await page.mouse.up()
  await expect
    .poll(async () => Math.round((await editorPane.boundingBox())?.width ?? 0))
    .toBeGreaterThan(beforeWidth + 100)
})
