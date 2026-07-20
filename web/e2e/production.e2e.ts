import { expect, test, type Page } from '@playwright/test'
import { retriggerCurrentInput, waitForAnalysisReady } from './helpers'

function recordApiRequests(page: Page): string[] {
  const requests: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      requests.push(`${request.method()} ${url.pathname}`)
    }
  })
  return requests
}

async function waitForAutomaticSynthesis(
  page: Page,
  changeInput: () => Promise<void>,
) {
  const analysisPane = page.locator('.pane-right')
  await analysisPane.waitFor()
  await changeInput()
  await expect(analysisPane).not.toHaveAttribute('data-analysis-state', 'current')
  await expect(analysisPane).toHaveAttribute('data-analysis-state', 'current', {
    timeout: 120_000,
  })
}

async function startAnalysisStateRecording(page: Page) {
  await page.evaluate(() => {
    const pane = document.querySelector('.pane-right')
    if (!pane) throw new Error('analysis pane is missing')
    const states: string[] = []
    const observer = new MutationObserver(() => {
      states.push(pane.getAttribute('data-analysis-state') ?? '')
    })
    observer.observe(pane, {
      attributes: true,
      attributeFilter: ['data-analysis-state'],
    })
    Object.assign(window, {
      __synthesisStates: states,
      __synthesisObserver: observer,
    })
  })
}

async function recordedAnalysisStates(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      (window as typeof window & { __synthesisStates?: string[] })
        .__synthesisStates ?? [],
  )
}

async function stopAnalysisStateRecording(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const testWindow = window as typeof window & {
      __synthesisStates?: string[]
      __synthesisObserver?: MutationObserver
    }
    testWindow.__synthesisObserver?.disconnect()
    return testWindow.__synthesisStates ?? []
  })
}

async function cacheEntryCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('synth-explorer')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const request = database.transaction('syntheses').objectStore('syntheses').count()
    return await new Promise<number>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  })
}

test('file tabs expose roving keyboard navigation', async ({ page }) => {
  await page.goto('/')
  await page.getByTitle('Add file').click()
  await page.getByTitle('Add file').click()

  const designTab = page.getByRole('tab', { name: /design\.sv/ })
  const file1Tab = page.getByRole('tab', { name: /file1\.sv/ })
  const file2Tab = page.getByRole('tab', { name: /file2\.sv/ })
  await expect(file2Tab).toHaveAttribute('aria-selected', 'true')
  await file2Tab.focus()
  await file2Tab.press('Home')
  await expect(designTab).toBeFocused()
  await expect(designTab).toHaveAttribute('aria-selected', 'true')
  await designTab.press('End')
  await expect(file2Tab).toBeFocused()
  await file2Tab.press('ArrowLeft')
  await expect(file1Tab).toBeFocused()
  await expect(file1Tab).toHaveAttribute('aria-selected', 'true')
})

test('renames and deletes source files with in-page menus', async ({ page }) => {
  const browserDialogs: string[] = []
  page.on('dialog', async (dialog) => {
    browserDialogs.push(dialog.type())
    await dialog.dismiss()
  })
  await page.goto('/')
  await page.getByTitle('Add file').click()

  const fileTab = page.getByRole('tab', { name: /file1\.sv/ })
  await fileTab.dblclick()
  const renameMenu = page.getByRole('dialog', { name: 'Rename file1.sv' })
  await expect(renameMenu).toBeVisible()
  await renameMenu.getByLabel('Rename file1.sv').fill('control.sv')
  await renameMenu.getByRole('button', { name: 'Rename', exact: true }).click()

  const renamedTab = page.getByRole('tab', { name: /control\.sv/ })
  await expect(renamedTab).toBeVisible()
  await renamedTab.focus()
  await renamedTab.press('Delete')
  const deleteMenu = page.getByRole('dialog', { name: 'Delete control.sv' })
  await expect(deleteMenu).toBeVisible()
  await deleteMenu.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(renamedTab).toHaveCount(0)
  expect(browserDialogs).toEqual([])
})

test('auto-synthesizes an edited design locally after the debounce', async ({ page }) => {
  const apiRequests = recordApiRequests(page)
  await page.goto('/')

  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(
    page.getByRole('checkbox', { name: 'Synthesize automatically' }),
  ).toBeChecked()
  await expect(page.getByLabel('Automatic synthesis delay')).toHaveValue('250')
  await expect(page.locator('.settings-delay-value')).toHaveText('0.25 s')
  await page.getByRole('button', { name: 'Settings' }).click()

  await waitForAutomaticSynthesis(page, () =>
    page.getByLabel('Bundled example').selectOption('reg_mux'),
  )
  await page.getByRole('tab', { name: 'Overview', exact: true }).click()

  await expect(page.getByText('Structural logic depth', { exact: true })).toBeVisible()
  expect(await cacheEntryCount(page)).toBeGreaterThanOrEqual(1)
  await expect(page.getByRole('button', { name: 'Synthesize', exact: true })).toHaveCount(0)
  expect(apiRequests).toEqual([])
})

test('supports persistent manual synthesis and a configurable delay', async ({ page }) => {
  const apiRequests = recordApiRequests(page)
  await page.goto('/')
  await waitForAnalysisReady(page)

  await startAnalysisStateRecording(page)

  await page.getByRole('button', { name: 'Settings' }).click()
  const automatic = page.getByRole('checkbox', {
    name: 'Synthesize automatically',
  })
  await expect(automatic).toBeChecked()
  const delay = page.getByLabel('Automatic synthesis delay')
  await expect(delay).toHaveValue('250')
  await delay.focus()
  for (let step = 0; step < 5; step += 1) await delay.press('ArrowRight')
  await expect(page.locator('.settings-delay-value')).toHaveText('0.5 s')
  await page.waitForTimeout(750)
  expect(await stopAnalysisStateRecording(page)).not.toContain('refreshing')

  await automatic.uncheck()
  await page.getByRole('button', { name: 'Settings' }).click()
  const synthesize = page.getByRole('button', { name: 'Synthesize', exact: true })
  await expect(synthesize).toBeVisible()

  await page.getByLabel('Bundled example').selectOption('reg_mux')
  await page.waitForTimeout(750)
  await expect(page.locator('.pane-right')).toHaveAttribute(
    'data-analysis-state',
    'stale',
  )

  await synthesize.click()
  await waitForAnalysisReady(page)

  await page.getByRole('button', { name: 'Settings' }).click()
  await automatic.check()
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(synthesize).toHaveCount(0)

  await startAnalysisStateRecording(page)
  await page.getByLabel('Bundled example').selectOption('counter')
  await page.waitForTimeout(250)
  await expect(page.locator('.pane-right')).toHaveAttribute(
    'data-analysis-state',
    'stale',
  )
  await expect
    .poll(() => recordedAnalysisStates(page), { timeout: 500 })
    .toContain('refreshing')
  await stopAnalysisStateRecording(page)
  await expect(page.locator('.pane-right')).toHaveAttribute(
    'data-analysis-state',
    'current',
    { timeout: 120_000 },
  )

  await page.getByRole('button', { name: 'Settings' }).click()
  await automatic.uncheck()
  await page.reload()
  await expect(synthesize).toBeVisible()
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(
    page.getByRole('checkbox', { name: 'Synthesize automatically' }),
  ).not.toBeChecked()
  await expect(page.getByLabel('Automatic synthesis delay')).toHaveValue('500')
  expect(apiRequests).toEqual([])
})

test('sorts every reported path without changing the result set', async ({ page }) => {
  await page.goto('/')
  await waitForAutomaticSynthesis(page, async () => {
    await page.getByLabel('Bundled example').selectOption('round_robin_arbiter')
    await page.getByLabel('Mode').selectOption('xilinx')
  })
  await page.getByRole('tab', { name: 'Paths', exact: true }).click()

  const title = page.getByText(/^Longest logical path variants \(\d+\)$/)
  await expect(title).toBeVisible()
  const initialTitle = await title.textContent()
  const depthHeader = page.getByRole('columnheader', { name: /^Depth/ })
  const delayHeader = page.getByRole('columnheader', { name: /^Est\. delay/ })
  const rows = page.locator('.virtual-grid-row tr.clickable')
  const visiblePathKeys = () =>
    rows.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-path-key')).sort(),
    )
  const visibleDepths = () =>
    rows.locator('td:nth-child(2)').evaluateAll((cells) =>
      cells.map((cell) => Number.parseInt(cell.textContent ?? '', 10)),
    )
  const visibleDelays = () =>
    rows.locator('td:nth-child(3)').evaluateAll((cells) =>
      cells.map((cell) => Number.parseFloat(cell.textContent ?? '')),
    )

  const reportedCount = Number.parseInt(initialTitle?.match(/\((\d+)\)/)?.[1] ?? '', 10)
  const initialKeys = await visiblePathKeys()
  expect(initialKeys).toHaveLength(reportedCount)
  for (const column of [1, 2, 3]) {
    const header = page.getByRole('columnheader').nth(column - 1)
    const cell = rows.locator(`td:nth-child(${column})`).first()
    expect(await header.evaluate((element) => getComputedStyle(element).textAlign)).toBe('right')
    expect(await cell.evaluate((element) => getComputedStyle(element).textAlign)).toBe('right')
    const headerBox = await header.boundingBox()
    const cellBox = await cell.boundingBox()
    expect(Math.abs((headerBox?.x ?? 0) - (cellBox?.x ?? 0))).toBeLessThanOrEqual(1)
    expect(Math.abs((headerBox?.width ?? 0) - (cellBox?.width ?? 0))).toBeLessThanOrEqual(1)
  }

  await depthHeader.click()
  await expect(depthHeader).toHaveAttribute('aria-sort', 'descending')
  await expect(title).toHaveText(initialTitle ?? '')
  expect(await visiblePathKeys()).toEqual(initialKeys)
  const depthDescending = await visibleDepths()
  expect(depthDescending).toEqual([...depthDescending].sort((left, right) => right - left))

  await depthHeader.click()
  await expect(depthHeader).toHaveAttribute('aria-sort', 'ascending')
  expect(await visiblePathKeys()).toEqual(initialKeys)
  const depthAscending = await visibleDepths()
  expect(depthAscending).toEqual([...depthAscending].sort((left, right) => left - right))

  await delayHeader.click()
  await expect(delayHeader).toHaveAttribute('aria-sort', 'descending')
  await expect(title).toHaveText(initialTitle ?? '')
  expect(await visiblePathKeys()).toEqual(initialKeys)
  const descending = await visibleDelays()
  expect(descending).toEqual([...descending].sort((left, right) => right - left))

  await delayHeader.click()
  await expect(delayHeader).toHaveAttribute('aria-sort', 'ascending')
  await expect(title).toHaveText(initialTitle ?? '')
  expect(await visiblePathKeys()).toEqual(initialKeys)
  const ascending = await visibleDelays()
  expect(ascending).toEqual([...ascending].sort((left, right) => left - right))
})

test('coalesces a typing burst into one synthesis of the newest input', async ({ page }) => {
  const apiRequests = recordApiRequests(page)
  await page.goto('/')
  await waitForAnalysisReady(page)
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('synth-explorer')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const transaction = database.transaction('syntheses', 'readwrite')
    transaction.objectStore('syntheses').clear()
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  })

  await waitForAutomaticSynthesis(page, async () => {
    const editor = page.locator('.cm-content')
    await editor.click()
    await editor.press('Control+End')
    await editor.type('\n// burst')
    await page.waitForTimeout(100)
    await editor.type('-one')
    await page.waitForTimeout(100)
    await editor.type('-result')
  })

  expect(await cacheEntryCount(page)).toBe(1)
  expect(apiRequests).toEqual([])
})

test('cancels obsolete Yosys work and commits only the newest edit', async ({ page }) => {
  const apiRequests = recordApiRequests(page)
  await page.goto('/')
  await waitForAnalysisReady(page)

  await waitForAutomaticSynthesis(page, async () => {
    await page.getByLabel('Bundled example').selectOption('handshake_controller')
    await page.getByLabel('Mode').selectOption('xilinx')
    await page.getByRole('tab', { name: 'Schematic', exact: true }).click()
    const graphLoader = page.locator('.graph-loading-indicator')
    await expect(graphLoader).toHaveCount(1)
    await expect(graphLoader.getByRole('status', { name: 'Loading schematic' })).toBeVisible()
    await expect(page.getByText(/refreshing analysis|Loading schematic…/)).toHaveCount(0)
    await expect
      .poll(async () => {
        const box = await graphLoader.boundingBox()
        return Math.round(box?.height ?? 0)
      })
      .toBeGreaterThanOrEqual(32)
    expect(
      await graphLoader.evaluate((element) => getComputedStyle(element).backgroundColor),
    ).toBe('rgba(0, 0, 0, 0)')
    const editor = page.locator('.cm-content')
    await editor.click()
    await editor.press('Control+End')
    await editor.type('\n// newest input')
  })

  const xilinxEntries = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('synth-explorer')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const read = database.transaction('syntheses').objectStore('syntheses').getAll()
    const records = await new Promise<Array<{ input: { mode: string } }>>(
      (resolve, reject) => {
        read.onsuccess = () => resolve(read.result)
        read.onerror = () => reject(read.error)
      },
    )
    return records.filter((record) => record.input.mode === 'xilinx').length
  })
  expect(xilinxEntries).toBe(1)
  expect(apiRequests).toEqual([])
})

test('synthesizes and analyzes locally, then reuses the per-browser cache', async ({ page }) => {
  const apiRequests = recordApiRequests(page)
  await page.goto('/')

  await expect(page.getByText('Synth Explorer', { exact: true })).toBeVisible()
  const flags = page.getByLabel('Synthesis flags')
  await waitForAutomaticSynthesis(page, async () => {
    await page.getByLabel('Bundled example').selectOption('reg_mux')
    await page.getByLabel('Mode').selectOption('xilinx')
  })
  await expect(flags).toHaveValue('-narrowcarry 8 -nowidelut -noiopad')

  await page.getByRole('tab', { name: 'Overview', exact: true }).click()
  await expect(page.locator('.card').filter({ hasText: 'Cells' }).locator('.v')).toHaveText(/^\d+$/)
  expect(await cacheEntryCount(page)).toBeGreaterThanOrEqual(1)

  const started = Date.now()
  await waitForAutomaticSynthesis(page, () => retriggerCurrentInput(page))
  // Cache reuse still reinitializes analysis in a worker. Keep this well below
  // cold synthesis without making the assertion depend on sub-second CI load.
  expect(Date.now() - started).toBeLessThan(2_000)

  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('synth-explorer')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const transaction = database.transaction('syntheses', 'readwrite')
    const store = transaction.objectStore('syntheses')
    const read = store.getAll()
    const records = await new Promise<Array<{
      input: { mode: string }
      output: { netlistJson: string }
    }>>(
      (resolve, reject) => {
        read.onsuccess = () => resolve(read.result)
        read.onerror = () => reject(read.error)
      },
    )
    const xilinx = records.find((record) => record.input.mode === 'xilinx')
    if (!xilinx) throw new Error('xilinx cache entry is missing')
    xilinx.output.netlistJson = '{'
    store.put(xilinx)
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  })
  await waitForAutomaticSynthesis(page, () => retriggerCurrentInput(page))
  const repaired = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('synth-explorer')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const read = database.transaction('syntheses').objectStore('syntheses').getAll()
    const records = await new Promise<Array<{
      input: { mode: string }
      output: { netlistJson: string }
    }>>(
      (resolve, reject) => {
        read.onsuccess = () => resolve(read.result)
        read.onerror = () => reject(read.error)
      },
    )
    const xilinx = records.find((record) => record.input.mode === 'xilinx')
    if (!xilinx) throw new Error('xilinx cache entry is missing')
    JSON.parse(xilinx.output.netlistJson)
    return records.length
  })
  expect(repaired).toBeGreaterThanOrEqual(1)

  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Clear synthesis cache' }).click()
  await expect(page.getByRole('status')).toHaveText('Cleared from this browser.')
  expect(await cacheEntryCount(page)).toBe(0)
  expect(apiRequests).toEqual([])
})

test('renders and resizes the browser-produced graph without resetting user zoom', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  const apiRequests = recordApiRequests(page)
  await page.goto('/')
  await waitForAutomaticSynthesis(page, () =>
    page.getByLabel('Bundled example').selectOption('reg_mux'),
  )
  await page.getByRole('tab', { name: 'Schematic', exact: true }).click()

  const stage = page.locator('.graph-stage')
  const svg = stage.locator('svg')
  const viewport = svg.locator(':scope > g').first()
  await expect(svg).toBeVisible()
  await expect(page.locator('.g-node-body').first()).toBeVisible()
  await expect(page.getByLabel('Focus')).toBeChecked()
  await expect(page.getByLabel('Focus')).toBeEnabled()

  const rovingNode = page.locator('.g-node-body[tabindex="0"]')
  await expect(rovingNode).toHaveCount(1)
  const initialNode = await rovingNode.getAttribute('data-graph-node-id')
  await rovingNode.focus()
  await rovingNode.press('ArrowRight')
  await expect
    .poll(() => page.locator('.g-node-body[tabindex="0"]').getAttribute('data-graph-node-id'))
    .not.toBe(initialNode)

  const beforeZoom = await viewport.getAttribute('transform')
  await page.getByTitle('Zoom in').click()
  await expect.poll(() => viewport.getAttribute('transform')).not.toBe(beforeZoom)
  const userTransform = await viewport.getAttribute('transform')

  const initialWidth = (await stage.boundingBox())?.width ?? 0
  await page.setViewportSize({ width: 1050, height: 680 })
  await expect.poll(async () => (await stage.boundingBox())?.width ?? 0).toBeLessThan(initialWidth - 100)
  await expect.poll(() => viewport.getAttribute('transform')).toBe(userTransform)
  await expect
    .poll(async () => {
      const [stageBox, svgBox] = await Promise.all([stage.boundingBox(), svg.boundingBox()])
      return Math.abs((stageBox?.width ?? 0) - (svgBox?.width ?? 0))
    })
    .toBeLessThan(1)
  expect(apiRequests).toEqual([])
})

test('source selections and Focus use the in-browser exploration worker', async ({ page }) => {
  const apiRequests = recordApiRequests(page)
  await page.goto('/')
  await waitForAutomaticSynthesis(page, async () => {
    await page.getByLabel('Bundled example').selectOption('handshake_controller')
  })
  await page.getByRole('tab', { name: 'Schematic', exact: true }).click()

  const focus = page.getByLabel('Focus')
  await expect(focus).toBeChecked()
  await expect(focus).toBeEnabled()
  await focus.uncheck()
  await expect(focus).not.toBeChecked()
  await expect(focus).toBeDisabled()
  const fullNodes = page.locator('.g-node-body')
  await expect(fullNodes.first()).toBeVisible()
  const fullNodeIds = await fullNodes.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-graph-node-id')),
  )
  expect(fullNodeIds.length).toBeGreaterThan(0)

  const editor = page.locator('.cm-content')
  await editor.click()
  await editor.press('Control+End')
  await page.locator('.cm-line', { hasText: /input\s+logic\s+start,/ }).click()
  await expect(focus).toBeEnabled()
  await expect(focus).not.toBeChecked()
  await expect(page.locator('.g-node-body')).toHaveCount(fullNodeIds.length)
  await expect.poll(() => page.locator('.g-node-body.hl').count()).toBeGreaterThan(0)
  const directNodeIds = await page.locator('.g-node-body.hl').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-graph-node-id')).sort(),
  )
  const contextualLogic = page.locator(
    '.g-node-body[data-relevant="1"]:not(.hl):not(.g-symbol-port-in):not(.g-symbol-port-out):not(.g-symbol-const)',
  )
  await expect.poll(() => contextualLogic.count()).toBeGreaterThan(0)
  const contextualLogicIds = await contextualLogic.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-graph-node-id')).sort(),
  )
  const dimmedNodes = page.locator('.g-node-body[data-relevant="0"]')
  await expect.poll(() => dimmedNodes.count()).toBeGreaterThan(0)
  await expect(dimmedNodes.first()).toHaveCSS('opacity', '0.25')

  await focus.check()
  await expect(focus).toBeChecked()
  await expect.poll(() => page.locator('.g-node-body').count()).toBeLessThan(fullNodeIds.length)
  await expect
    .poll(() =>
      page.locator('.g-node-body.hl').evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('data-graph-node-id')).sort(),
      ),
    )
    .toEqual(directNodeIds)
  await expect
    .poll(() =>
      page.locator(
        '.g-node-body[data-relevant="1"]:not(.hl):not(.g-symbol-port-in):not(.g-symbol-port-out):not(.g-symbol-const)',
      ).evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('data-graph-node-id')).sort(),
      ),
    )
    .toEqual(contextualLogicIds)
  await expect(page.locator('.g-node-body[data-relevant="0"]')).toHaveCount(0)
  const focusedNodeCount = await page.locator('.g-node-body').count()
  const expandableBoundary = page.locator(
    '.g-node-body[data-boundary="true"][data-graph-node-id="44"]',
  )
  await expect(expandableBoundary).toBeVisible()
  await expandableBoundary.focus()
  await expandableBoundary.press('Shift+Enter')
  await expect.poll(() => page.locator('.g-node-body').count()).toBeGreaterThan(focusedNodeCount)

  await focus.uncheck()
  await expect(page.locator('.g-node-body')).toHaveCount(fullNodeIds.length)
  await page.locator('.cm-line', { hasText: "request_valid = 1'b1;" }).click()
  await expect.poll(() => page.locator('.g-node-body.hl').count()).toBeGreaterThan(0)
  expect(
    await fullNodes.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-graph-node-id')),
    ),
  ).toEqual(fullNodeIds)

  await page.locator('.cm-content').press('Escape')
  await expect(focus).toBeDisabled()
  await expect(page.locator('.g-node-body.hl')).toHaveCount(0)
  await expect(page.locator('.g-edge.hl')).toHaveCount(0)
  expect(apiRequests).toEqual([])
})

test('keeps synthesis failures compact until the full log is requested', async ({ page }) => {
  const apiRequests = recordApiRequests(page)
  await page.goto('/')
  await waitForAnalysisReady(page)

  const editor = page.locator('.cm-content')
  await editor.click()
  await editor.press('Control+A')
  await page.keyboard.insertText('module broken(')

  await expect(page.getByText(/analysis is stale/i)).toHaveCount(0)
  const banner = page.locator('.error-strip')
  await expect(banner).toBeVisible({ timeout: 120_000 })
  const details = banner.locator('details')
  await expect(banner.locator('.synth-icon')).toBeVisible()
  await expect(banner.locator('.error-location')).toHaveText('design.sv:1')
  await expect(editor.locator('.cm-lintRange-error')).toBeVisible()
  await expect(banner.locator('.bub')).toHaveCount(0)
  await expect(details).not.toHaveAttribute('open', '')
  await expect(banner.locator('pre')).toBeHidden()
  await expect
    .poll(async () => Math.round((await banner.boundingBox())?.height ?? 0))
    .toBeLessThanOrEqual(32)

  await startAnalysisStateRecording(page)
  await page.getByRole('button', { name: 'Settings' }).click()
  const delay = page.getByLabel('Automatic synthesis delay')
  await delay.focus()
  await delay.press('ArrowRight')
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.waitForTimeout(500)
  expect(await stopAnalysisStateRecording(page)).not.toContain('refreshing')

  await banner.locator('summary').click()
  await expect(details).toHaveAttribute('open', '')
  await expect(banner.locator('pre')).toBeVisible()
  await expect(banner.locator('pre')).not.toBeEmpty()

  await editor.fill(
    "module top(output logic y); assign y = 1'b0; endmodule",
  )
  await page.waitForTimeout(0)
  expect(await banner.count()).toBe(0)
  expect(await editor.locator('.cm-lintRange-error').count()).toBe(0)
  await waitForAnalysisReady(page)
  expect(apiRequests).toEqual([])
})
