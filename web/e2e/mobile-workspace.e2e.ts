import { expect, test } from '@playwright/test'
import { waitForAnalysisReady } from './helpers'

function viewportScale(transform: string | null): number {
  const match = transform?.match(/scale\(([^)]+)\)/)
  if (!match) throw new Error(`viewport transform has no scale: ${transform}`)
  return Number(match[1])
}

test.describe('touch schematic viewport', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  })

  test('pinches the schematic without scaling the page', async ({ page, context }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Analysis', exact: true }).click()
    await waitForAnalysisReady(page)

    const stage = page.locator('.graph-stage')
    const viewport = stage.locator('svg > g').first()
    const box = await stage.boundingBox()
    if (!box) throw new Error('schematic stage has no bounding box')

    const centerX = box.x + box.width / 2
    const centerY = box.y + box.height / 2
    const initialTransform = await viewport.getAttribute('transform')
    const initialPageScale = await page.evaluate(() => window.visualViewport?.scale ?? 1)
    const cdp = await context.newCDPSession(page)
    const touchPoints = (spread: number) => [
      { x: centerX - spread, y: centerY, id: 0 },
      { x: centerX + spread, y: centerY, id: 1 },
    ]

    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: touchPoints(35),
    })
    for (const spread of [50, 70, 95]) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: touchPoints(spread),
      })
    }
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    })

    await expect
      .poll(async () => viewportScale(await viewport.getAttribute('transform')))
      .toBeGreaterThan(viewportScale(initialTransform) * 1.5)
    await expect
      .poll(() => page.evaluate(() => window.visualViewport?.scale ?? 1))
      .toBeCloseTo(initialPageScale, 5)
  })
})

test('keeps every setting reachable on a narrow phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')

  await page.getByRole('button', { name: 'Settings' }).click()
  const popover = page.getByRole('dialog', { name: 'Settings' })
  const clearCache = page.getByRole('button', { name: 'Clear synthesis cache' })
  await popover.evaluate((element) => element.scrollTo(0, element.scrollHeight))

  await expect(clearCache).toBeInViewport()
  await expect
    .poll(() =>
      popover.evaluate(
        (element) => element.scrollHeight > element.clientHeight && element.scrollTop > 0,
      ),
    )
    .toBe(true)
})

test('uses full-width Editor and Analysis views on a narrow phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')

  const workspaceNavigation = page.getByRole('navigation', { name: 'Workspace views' })
  const editorButton = page.getByRole('button', { name: 'Editor', exact: true })
  const analysisButton = page.getByRole('button', { name: 'Analysis', exact: true })
  const editorPane = page.locator('.pane-left')
  const analysisPane = page.locator('.pane-right')

  await expect(workspaceNavigation).toBeVisible()
  await expect(editorButton).toHaveAttribute('aria-pressed', 'true')
  await expect(editorButton).toHaveAttribute('aria-controls', 'workspace-editor')
  await expect(analysisButton).toHaveAttribute('aria-pressed', 'false')
  await expect(analysisButton).toHaveAttribute('aria-controls', 'workspace-analysis')
  await expect(editorPane).toBeVisible()
  await expect(analysisPane).toBeHidden()
  await expect
    .poll(() => editorPane.evaluate((element) => element.scrollWidth <= element.clientWidth))
    .toBe(true)
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
  await analysisButton.click()

  await expect(editorButton).toHaveAttribute('aria-pressed', 'false')
  await expect(analysisButton).toHaveAttribute('aria-pressed', 'true')
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

  await editorButton.click()
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
  await analysisButton.click()
  await expect(editorPane).toBeHidden()
  await expect(analysisPane).toBeVisible()
  await expect
    .poll(() => analysisPane.evaluate((element) => element.scrollWidth <= element.clientWidth))
    .toBe(true)
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
