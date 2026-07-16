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

test('unlocks Vivado family and speed presets through a password-manager form', async ({
  page,
}) => {
  const accessKey = 'a'.repeat(64)
  await page.route('**/healthz', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'ok',
        commit: 'test',
        version: 'test',
        yosys_version: 'Yosys test',
        vivado_version: 'Vivado v2026.1',
        vivado_access_protected: true,
      }),
    })
  })
  await page.route('**/api/vivado/access', async (route) => {
    expect(route.request().headers().authorization).toBe(`Bearer ${accessKey}`)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        parts: [
          { name: 'xc7a35tcpg236-1', family: 'artix7', speed: '-1' },
          { name: 'xcku025-ffva1156-1-e', family: 'kintexu', speed: '-1' },
          { name: 'xcku040-ffva1156-2-e', family: 'kintexu', speed: '-2' },
          { name: 'xczu3eg-sbva484-1-e', family: 'zynquplus', speed: '-1' },
        ],
      }),
    })
  })

  await page.goto('/')
  await page.getByLabel('Synth tool').selectOption('vivado')

  const password = page.getByLabel('API key', { exact: true })
  await expect(password).toHaveAttribute('type', 'password')
  await expect(password).toHaveAttribute('name', 'password')
  await expect(password).toHaveAttribute('autocomplete', 'current-password')
  await expect(page.locator('input[name="username"]')).toHaveCount(0)
  await expect(page.locator('form[autocomplete="on"]')).toBeVisible()
  await password.fill(accessKey)
  await page.getByRole('button', { name: 'Unlock', exact: true }).click()

  await expect(page.getByLabel('Synth tool')).toHaveValue('vivado')
  await expect(page.getByLabel('Mode')).toHaveCount(0)
  await expect(page.getByLabel('Family')).toHaveValue('artix7')
  await expect(page.getByLabel('Family').locator('option')).toHaveCount(3)
  await expect(page.getByLabel('Speed grade')).toHaveValue('-1')
  await expect(page.getByLabel('Speed grade')).toHaveAttribute(
    'title',
    'Resolved Vivado part: xc7a35tcpg236-1',
  )

  await page.getByLabel('Family').selectOption('kintexu')
  await expect(page.getByLabel('Speed grade')).toHaveValue('-1')
  await expect(page.getByLabel('Speed grade').locator('option')).toHaveCount(2)
  await expect(page.getByLabel('Speed grade')).toHaveAttribute(
    'title',
    'Resolved Vivado part: xcku025-ffva1156-1-e',
  )
  await page.getByLabel('Speed grade').selectOption('-2')
  await expect(page.getByLabel('Speed grade')).toHaveAttribute(
    'title',
    'Resolved Vivado part: xcku040-ffva1156-2-e',
  )

  await expect(page.getByText('Flags', { exact: true })).toBeVisible()
  await page.getByTitle('Add or remove synthesis flags for this mode').click()
  await page.getByRole('checkbox', { name: 'Enable -directive' }).check()
  await expect(page.getByLabel('-directive value')).toHaveValue('default')
  await page.getByLabel('-directive value').selectOption('PerformanceOptimized')
  await expect(page.getByLabel('Synthesis flags')).toHaveValue(
    '-directive PerformanceOptimized',
  )

  const dspLimit = page.getByRole('checkbox', { name: 'Enable -max_dsp' })
  await dspLimit.check()
  await expect(page.getByLabel('-max_dsp value')).toHaveValue('0')
  await page.getByLabel('-max_dsp value').fill('24')
  await expect(page.getByLabel('Synthesis flags')).toHaveValue(
    '-directive PerformanceOptimized -max_dsp 24',
  )
  await dspLimit.uncheck()
  await expect(page.getByLabel('Synthesis flags')).toHaveValue(
    '-directive PerformanceOptimized',
  )
})

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
    tool: 'yosys',
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
  await page.getByLabel('Example').selectOption({ label: 'Reg Mux' })

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

test('Focus toggles a stable relevant overlay without refetching or refitting', async ({
  page,
}) => {
  await page.goto('/')
  await page
    .getByText('Example')
    .locator('..')
    .locator('select')
    .selectOption('handshake_controller')
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

  let lineConeRequests = 0
  let netlistRequests = 0
  page.on('request', (request) => {
    if (request.url().includes('/line-cone?')) lineConeRequests += 1
    if (request.url().includes('/netlist?')) netlistRequests += 1
  })

  // Select the timeout counter update, whose relevant graph includes the
  // counter register while the context projection includes nearby controller
  // logic.
  await page
    .locator('.cm-line', { hasText: 'wait_count <= wait_count + 1\'b1;' })
    .click()
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
  expect(lineConeRequests).toBe(1)
  expect(netlistRequests).toBe(0)
  expect(
    await page.locator('.g-edge').filter({ hasText: '→D' }).count(),
  ).toBeGreaterThan(0)

  const stage = page.locator('.graph-stage')
  const viewport = stage.locator('svg > g').first()
  const retainedNode = page.locator('.g-node-body').first()
  await page.getByTitle('Zoom in').click()
  const userTransform = await viewport.getAttribute('transform')
  const retainedBox = await retainedNode.boundingBox()
  expect(retainedBox).not.toBeNull()
  const viewportScale = (transform: string | null) =>
    Number(/scale\(([^)]+)\)/.exec(transform ?? '')?.[1])

  const contextResponse = page.waitForResponse((response) =>
    response.url().includes('/netlist?'),
  )
  await focus.uncheck()
  const resolvedContextResponse = await contextResponse
  expect(resolvedContextResponse.ok()).toBe(true)
  const contextParams = new URL(resolvedContextResponse.url()).searchParams
  expect(contextParams.get('hide_control')).toBe('true')
  expect(contextParams.get('hide_const')).toBe('true')
  expect(contextParams.get('around')).toMatch(/^\d+(,\d+)*$/)
  await expect
    .poll(async () => page.locator('.g-node-body').count())
    .toBeGreaterThan(focusedNodeCount)
  const laidOutNodeCount = await page.locator('.g-node-body').count()
  await expect(focus).not.toBeChecked()
  expect(lineConeRequests).toBe(1)
  expect(netlistRequests).toBe(1)

  const contextNodes = page.locator('.g-node-body[data-relevant="0"]')
  const relevantNodes = page.locator('.g-node-body[data-relevant="1"]')
  const contextEdges = page.locator('.g-edge-wrap[data-relevant="0"]')
  expect(await contextNodes.count()).toBeGreaterThan(0)
  expect(await contextEdges.count()).toBeGreaterThan(0)
  expect(await relevantNodes.count()).toBe(focusedNodeCount)
  await expect(contextNodes.first()).toHaveCSS('opacity', '0.25')
  await expect(contextEdges.first()).toHaveCSS('opacity', '0.25')
  expect(await page.locator('.g-node-body.hl').count()).toBeGreaterThan(0)
  expect(await page.locator('.g-edge.hl').count()).toBeGreaterThan(0)
  const stabilizedBox = await retainedNode.boundingBox()
  const stabilizedTransform = await viewport.getAttribute('transform')
  expect(Math.abs((stabilizedBox?.x ?? 0) - retainedBox!.x)).toBeLessThan(1)
  expect(Math.abs((stabilizedBox?.y ?? 0) - retainedBox!.y)).toBeLessThan(1)
  expect(viewportScale(stabilizedTransform)).toBe(viewportScale(userTransform))

  await focus.check()
  await expect(contextNodes.first()).toHaveCSS('visibility', 'hidden')
  await expect(contextEdges.first()).toHaveCSS('visibility', 'hidden')
  expect(await page.locator('.g-node-body').count()).toBe(laidOutNodeCount)
  expect(lineConeRequests).toBe(1)
  expect(netlistRequests).toBe(1)
  await expect(viewport).toHaveAttribute('transform', stabilizedTransform ?? '')

  await focus.uncheck()
  await expect(contextNodes.first()).toHaveCSS('opacity', '0.25')
  await expect(contextEdges.first()).toHaveCSS('opacity', '0.25')
  expect(await page.locator('.g-node-body').count()).toBe(laidOutNodeCount)
  expect(lineConeRequests).toBe(1)
  expect(netlistRequests).toBe(1)
  await expect(viewport).toHaveAttribute('transform', stabilizedTransform ?? '')
})
