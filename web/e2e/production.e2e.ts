import { expect, test, type Locator, type Page } from '@playwright/test'

async function dragDividerBy(page: Page, divider: Locator, deltaX: number) {
  const box = await divider.boundingBox()
  if (!box) throw new Error('divider is not visible')
  const startX = box.x + box.width / 2
  const y = box.y + 30
  await page.mouse.move(startX, y)
  await page.mouse.down()
  await page.mouse.move(startX + deltaX, y)
  await page.mouse.up()
  return box
}

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

test('graph viewport follows browser and pane resizing without resetting user zoom', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/')
  await page.getByLabel('Example').selectOption({ label: 'Register behind a mux' })

  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/synthesize') &&
      response.request().method() === 'POST',
  )
  await page.getByRole('button', { name: 'Synthesize', exact: true }).click()
  expect((await responsePromise).ok()).toBe(true)

  await page.getByRole('button', { name: 'Schematic', exact: true }).click()
  await page.getByRole('button', { name: 'Full netlist', exact: true }).click()

  const stage = page.locator('.graph-stage')
  const svg = stage.locator('svg')
  const viewport = svg.locator(':scope > g').first()
  await expect(svg).toBeVisible()
  await expect(page.locator('.g-node-body').first()).toBeVisible()

  const initialStage = await stage.boundingBox()
  expect(initialStage).not.toBeNull()
  await page.setViewportSize({ width: 1000, height: 650 })
  await expect
    .poll(async () => (await stage.boundingBox())?.width ?? 0)
    .toBeLessThan(initialStage!.width - 80)
  await expect
    .poll(async () => {
      const [stageBox, svgBox] = await Promise.all([
        stage.boundingBox(),
        svg.boundingBox(),
      ])
      return Math.abs((stageBox?.width ?? 0) - (svgBox?.width ?? 0))
    })
    .toBeLessThan(1)

  const divider = page.locator('.divider')
  const beforeDividerStage = (await stage.boundingBox())!.width
  const beforeDividerSvg = (await svg.boundingBox())!.width
  const paneResize = 64
  const meaningfulResize = paneResize / 2
  const dividerBox = await dragDividerBy(page, divider, -paneResize)
  await expect
    .poll(
      async () =>
        dividerBox.x - ((await divider.boundingBox())?.x ?? dividerBox.x),
    )
    .toBeGreaterThan(meaningfulResize)
  await expect
    .poll(async () => (await stage.boundingBox())?.width ?? 0)
    .toBeGreaterThan(beforeDividerStage + meaningfulResize)
  await expect
    .poll(async () => (await svg.boundingBox())?.width ?? 0)
    .toBeGreaterThan(beforeDividerSvg + meaningfulResize)
  await expect
    .poll(async () => {
      const [stageBox, svgBox] = await Promise.all([
        stage.boundingBox(),
        svg.boundingBox(),
      ])
      return Math.abs((stageBox?.width ?? 0) - (svgBox?.width ?? 0))
    })
    .toBeLessThan(1)

  const beforeZoom = await viewport.getAttribute('transform')
  await page.getByTitle('Zoom in').click()
  await expect
    .poll(async () => await viewport.getAttribute('transform'))
    .not.toBe(beforeZoom)
  const userTransform = await viewport.getAttribute('transform')

  const beforeSecondStage = (await stage.boundingBox())!.width
  const beforeSecondSvg = (await svg.boundingBox())!.width
  const secondDividerBox = await dragDividerBy(page, divider, paneResize)
  await expect
    .poll(
      async () =>
        ((await divider.boundingBox())?.x ?? secondDividerBox.x) -
        secondDividerBox.x,
    )
    .toBeGreaterThan(meaningfulResize)
  await expect
    .poll(
      async () =>
        beforeSecondStage -
        ((await stage.boundingBox())?.width ?? beforeSecondStage),
    )
    .toBeGreaterThan(meaningfulResize)
  await expect
    .poll(
      async () =>
        beforeSecondSvg - ((await svg.boundingBox())?.width ?? beforeSecondSvg),
    )
    .toBeGreaterThan(meaningfulResize)
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  await expect
    .poll(async () => await viewport.getAttribute('transform'))
    .toBe(userTransform)

  await page.getByTitle('Fit to view').click()
  const beforeTabSwitch = await viewport.getAttribute('transform')
  const beforeInactiveResize = await stage.boundingBox()
  if (!beforeInactiveResize) throw new Error('graph stage is not visible')
  const browserViewport = page.viewportSize()
  if (!browserViewport) throw new Error('browser viewport size is unavailable')
  const inactiveResize = { width: 120, height: 60 }
  await page.getByRole('button', { name: 'Overview', exact: true }).click()
  await page.setViewportSize({
    width: browserViewport.width + inactiveResize.width,
    height: browserViewport.height + inactiveResize.height,
  })
  await page.getByRole('button', { name: 'Schematic', exact: true }).click()
  await expect(svg).toBeVisible()
  await expect
    .poll(async () => {
      const afterInactiveResize = await stage.boundingBox()
      if (!afterInactiveResize) return 0
      return (
        Math.abs(afterInactiveResize.width - beforeInactiveResize.width) +
        Math.abs(afterInactiveResize.height - beforeInactiveResize.height)
      )
    })
    .toBeGreaterThan(Math.min(inactiveResize.width, inactiveResize.height) / 2)
  await expect
    .poll(async () => {
      const [stageBox, svgBox] = await Promise.all([
        stage.boundingBox(),
        svg.boundingBox(),
      ])
      return Math.abs((stageBox?.width ?? 0) - (svgBox?.width ?? 0))
    })
    .toBeLessThan(1)
  await expect
    .poll(async () => await viewport.getAttribute('transform'))
    .not.toBe(beforeTabSwitch)
})
