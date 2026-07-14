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

test('synthesizes from the webpage with the default Yosys flags', async ({
  page,
}) => {
  await page.goto('/')

  await expect(page.getByText('Synth Explorer', { exact: true })).toBeVisible()
  const repositoryLink = page.getByRole('link', {
    name: 'View source on GitHub (opens in a new tab)',
  })
  await expect(repositoryLink).toBeVisible()
  await expect(repositoryLink).toHaveAttribute(
    'href',
    'https://github.com/cachanova/synth-explorer',
  )
  await expect(repositoryLink).toHaveAttribute('target', '_blank')
  await expect(repositoryLink).toHaveAttribute('rel', 'noopener noreferrer')
  const flags = page.getByLabel('Synthesis flags')
  await expect(flags).toBeVisible()
  await page
    .getByText('Mode')
    .locator('..')
    .locator('select')
    .selectOption('xilinx')
  await expect(flags).toHaveValue('-noiopad')

  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/synthesize') &&
      response.request().method() === 'POST',
  )
  await page.getByRole('button', { name: 'Synthesize', exact: true }).click()

  const response = await responsePromise
  expect(response.ok()).toBe(true)
  expect(response.request().postDataJSON()).toMatchObject({
    mode: 'xilinx',
    extra_args: '-noiopad',
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

  const netlistResponse = page.waitForResponse((response) =>
    response.url().includes('/netlist?'),
  )
  await page.getByRole('button', { name: 'Schematic', exact: true }).click()
  const netlistParams = new URL((await netlistResponse).url()).searchParams
  expect(netlistParams.get('hide_control')).toBe('true')
  expect(netlistParams.get('hide_const')).toBe('true')
  expect(netlistParams.get('show_infrastructure')).toBe('false')
  await expect(page.getByRole('button', { name: 'Full netlist' })).toHaveCount(0)
  await expect(page.getByLabel('infrastructure')).toHaveCount(0)
  await expect(page.getByLabel('Focus')).toBeDisabled()

  const stage = page.locator('.graph-stage')
  const svg = stage.locator('svg')
  const viewport = svg.locator(':scope > g').first()
  await expect(svg).toBeVisible()
  await expect(page.locator('.g-node-body').first()).toBeVisible()
  await expect(page.locator('.g-node-body.hl')).toHaveCount(0)
  await expect(page.locator('.g-edge.hl')).toHaveCount(0)

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

test('Focus switches between the relevant cone and a highlighted full diagram', async ({
  page,
}) => {
  await page.goto('/')
  await page
    .getByText('Example')
    .locator('..')
    .locator('select')
    .selectOption('05_shared_logic')
  await page
    .getByText('Mode')
    .locator('..')
    .locator('select')
    .selectOption('xilinx')

  const synthResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/synthesize') &&
      response.request().method() === 'POST',
  )
  await page.getByRole('button', { name: 'Synthesize', exact: true }).click()
  expect((await synthResponse).ok()).toBe(true)

  // Select the q2 output declaration, whose focused Xilinx graph includes a
  // grouped register fed by several carry-chain D edges.
  await page.locator('.cm-line').nth(11).click()
  const focusedResponse = page.waitForResponse((response) =>
    response.url().includes('/line-cone?'),
  )
  await page.getByRole('button', { name: 'Schematic', exact: true }).click()
  expect((await focusedResponse).ok()).toBe(true)

  const focus = page.getByLabel('Focus')
  await expect(focus).toBeChecked()
  await expect(page.locator('.graph-count')).toBeVisible()
  const focusedNodeCount = await page.locator('.g-node-body').count()
  expect(focusedNodeCount).toBeGreaterThan(0)
  expect(
    await page.locator('.g-edge').filter({ hasText: '→D' }).count(),
  ).toBeGreaterThan(0)

  let fullNetlistRequests = 0
  let releaseFullProjection: () => void = () => {}
  const fullProjectionGate = new Promise<void>((resolve) => {
    releaseFullProjection = resolve
  })
  await page.route('**/netlist?**', async (route) => {
    fullNetlistRequests += 1
    await fullProjectionGate
    await route.continue().catch(() => {})
  })
  const fullResponse = page.waitForResponse((response) =>
    response.url().includes('/netlist?'),
  )
  await focus.uncheck()
  await expect.poll(() => fullNetlistRequests).toBe(1)

  // Change the relevant source while the full projection is still in flight.
  // Selection cleanup must not abort that shared projection and start another.
  const supersedingRelevantResponse = page.waitForResponse((response) =>
    response.url().includes('/line-cone?'),
  )
  await page.locator('.cm-line').nth(10).click()
  expect((await supersedingRelevantResponse).ok()).toBe(true)
  await page.waitForTimeout(50)
  const inFlightRequestCount = fullNetlistRequests
  releaseFullProjection()
  expect(inFlightRequestCount).toBe(1)
  const resolvedFullResponse = await fullResponse
  expect(resolvedFullResponse.ok()).toBe(true)
  const fullParams = new URL(resolvedFullResponse.url()).searchParams
  expect(fullParams.get('hide_control')).toBe('true')
  expect(fullParams.get('hide_const')).toBe('true')
  await expect
    .poll(async () => page.locator('.g-node-body').count())
    .toBeGreaterThan(focusedNodeCount)
  const fullNodeCount = await page.locator('.g-node-body').count()
  await expect(focus).not.toBeChecked()
  expect(await page.locator('.g-edge.hl').count()).toBeGreaterThan(0)
  expect(
    await page.locator('.g-edge').filter({ hasText: '→D' }).count(),
  ).toBeGreaterThan(0)

  const refocusedResponse = page.waitForResponse((response) =>
    response.url().includes('/line-cone?'),
  )
  await focus.check()
  expect((await refocusedResponse).ok()).toBe(true)
  await expect
    .poll(async () => page.locator('.g-node-body').count())
    .toBeLessThan(fullNodeCount)
  const refocusedNodeCount = await page.locator('.g-node-body').count()
  expect(refocusedNodeCount).toBeGreaterThan(0)

  // The full projection is stable for this design and option set. A second
  // Focus-off transition reuses it rather than rescanning the whole design.
  const cachedRelevantResponse = page.waitForResponse((response) =>
    response.url().includes('/line-cone?'),
  )
  await focus.uncheck()
  expect((await cachedRelevantResponse).ok()).toBe(true)
  await expect
    .poll(async () => page.locator('.g-node-body').count())
    .toBeGreaterThan(refocusedNodeCount)
  expect(fullNetlistRequests).toBe(1)

  // Escape clears the relevant source selection. The full diagram remains,
  // but no relevance highlight is retained when nothing is selected.
  await page.locator('.cm-content').press('Escape')
  await expect(focus).toBeDisabled()
  await expect(page.locator('.g-node-body.hl')).toHaveCount(0)
  await expect(page.locator('.g-edge.hl')).toHaveCount(0)
  expect(fullNetlistRequests).toBe(1)
})
