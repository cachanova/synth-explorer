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

  await page.getByRole('button', { name: 'Graph', exact: true }).click()
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

  const beforeDivider = (await stage.boundingBox())!.width
  const divider = page.locator('.divider')
  const dividerBox = await divider.boundingBox()
  expect(dividerBox).not.toBeNull()
  await page.mouse.move(dividerBox!.x + dividerBox!.width / 2, dividerBox!.y + 30)
  await page.mouse.down()
  await page.mouse.move(300, dividerBox!.y + 30)
  await page.mouse.up()
  await expect
    .poll(async () => (await stage.boundingBox())?.width ?? 0)
    .toBeGreaterThan(beforeDivider + 100)

  const beforeZoom = await viewport.getAttribute('transform')
  await page.getByTitle('Zoom in').click()
  await expect
    .poll(async () => await viewport.getAttribute('transform'))
    .not.toBe(beforeZoom)
  const userTransform = await viewport.getAttribute('transform')

  const beforeSecondDivider = (await stage.boundingBox())!.width
  const secondDividerBox = await divider.boundingBox()
  expect(secondDividerBox).not.toBeNull()
  await page.mouse.move(
    secondDividerBox!.x + secondDividerBox!.width / 2,
    secondDividerBox!.y + 30,
  )
  await page.mouse.down()
  await page.mouse.move(500, secondDividerBox!.y + 30)
  await page.mouse.up()
  await expect
    .poll(async () => (await stage.boundingBox())?.width ?? 0)
    .toBeLessThan(beforeSecondDivider - 100)
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
  await page.getByRole('button', { name: 'Overview', exact: true }).click()
  const hiddenDividerBox = await divider.boundingBox()
  expect(hiddenDividerBox).not.toBeNull()
  await page.mouse.move(
    hiddenDividerBox!.x + hiddenDividerBox!.width / 2,
    hiddenDividerBox!.y + 30,
  )
  await page.mouse.down()
  await page.mouse.move(350, hiddenDividerBox!.y + 30)
  await page.mouse.up()
  await page.getByRole('button', { name: 'Graph', exact: true }).click()
  await expect(svg).toBeVisible()
  await expect
    .poll(async () => await viewport.getAttribute('transform'))
    .not.toBe(beforeTabSwitch)
})
