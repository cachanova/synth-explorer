import { expect, test, type Page } from '@playwright/test'
import { retriggerCurrentInput } from './helpers'

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
  const completed = page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const status = document.querySelector<HTMLElement>('.pane-left .tag')
        if (!status) {
          reject(new Error('synthesis status is missing'))
          return
        }
        let started = status.textContent?.trim() === 'refreshing'
        const timer = window.setTimeout(() => {
          observer.disconnect()
          reject(new Error('automatic synthesis did not complete'))
        }, 120_000)
        const observer = new MutationObserver(() => {
          const text = status.textContent?.trim()
          if (text === 'refreshing') {
            started = true
            return
          }
          if (!started || text !== 'mapping live') return
          window.clearTimeout(timer)
          observer.disconnect()
          resolve()
        })
        observer.observe(status, { childList: true, subtree: true })
      }),
  )
  await changeInput()
  await completed
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

  await waitForAutomaticSynthesis(page, () =>
    page.getByLabel('Example').selectOption('reg_mux'),
  )
  await page.getByRole('tab', { name: 'Overview', exact: true }).click()

  await expect(page.getByText('Structural logic depth', { exact: true })).toBeVisible()
  expect(await cacheEntryCount(page)).toBeGreaterThanOrEqual(1)
  await expect(page.getByRole('button', { name: 'Synthesize', exact: true })).toHaveCount(0)
  expect(apiRequests).toEqual([])
})

test('coalesces a typing burst into one synthesis of the newest input', async ({ page }) => {
  const apiRequests = recordApiRequests(page)
  await page.goto('/')
  await expect(page.locator('.pane-left .tag')).toHaveText('mapping live', {
    timeout: 120_000,
  })
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
  await expect(page.locator('.pane-left .tag')).toHaveText('mapping live', {
    timeout: 120_000,
  })
  const readyIcon = page.locator('.pane-left .tag .synth-icon')
  await expect(readyIcon.locator('.bub')).toHaveCount(3)
  expect(
    await readyIcon.locator('.bub').first().evaluate((element) =>
      getComputedStyle(element).animationName,
    ),
  ).toBe('none')

  await waitForAutomaticSynthesis(page, async () => {
    await page.getByLabel('Example').selectOption('handshake_controller')
    await page.getByLabel('Mode').selectOption('xilinx')
    await expect(page.locator('.pane-left .tag')).toHaveText('refreshing')
    expect(
      await page.locator('.pane-left .tag .bubble-loader .bub').first().evaluate(
        (element) => getComputedStyle(element).animationName,
      ),
    ).toBe('se-bubble')
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
    await page.getByLabel('Example').selectOption('reg_mux')
    await page.getByLabel('Mode').selectOption('xilinx')
  })
  await expect(flags).toHaveValue('-narrowcarry 8 -nowidelut -noiopad')

  await page.getByRole('tab', { name: 'Overview', exact: true }).click()
  await expect(page.locator('.card').filter({ hasText: 'Cells' }).locator('.v')).toHaveText(/^\d+$/)
  expect(await cacheEntryCount(page)).toBeGreaterThanOrEqual(1)

  const started = Date.now()
  await waitForAutomaticSynthesis(page, () => retriggerCurrentInput(page))
  expect(Date.now() - started).toBeLessThan(1_000)

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
    page.getByLabel('Example').selectOption('reg_mux'),
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
    await page.getByLabel('Example').selectOption('handshake_controller')
    await page.getByLabel('Mode').selectOption('xilinx')
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

  await page.locator('.cm-line', { hasText: "wait_count <= wait_count + 1'b1;" }).click()
  await expect(focus).toBeEnabled()
  await expect(focus).not.toBeChecked()
  await expect(page.locator('.g-node-body')).toHaveCount(fullNodeIds.length)
  await expect.poll(() => page.locator('.g-node-body.hl').count()).toBeGreaterThan(0)

  await focus.check()
  await expect(focus).toBeChecked()
  await expect.poll(() => page.locator('.g-node-body').count()).toBeLessThan(fullNodeIds.length)
  const focusedNodeCount = await page.locator('.g-node-body').count()
  expect(focusedNodeCount).toBeGreaterThan(0)

  const boundaryNode = page.locator('.g-node-body[data-boundary="true"]').first()
  await expect(boundaryNode).toBeVisible()
  await boundaryNode.dblclick()
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

  await page.getByRole('tab', { name: 'Schematic', exact: true }).press('Escape')
  await expect(focus).toBeDisabled()
  await expect(page.locator('.g-node-body.hl')).toHaveCount(0)
  await expect(page.locator('.g-edge.hl')).toHaveCount(0)
  expect(apiRequests).toEqual([])
})

test('keeps synthesis failures compact until the full log is requested', async ({ page }) => {
  const apiRequests = recordApiRequests(page)
  await page.goto('/')
  await expect(page.locator('.pane-left .tag')).toHaveText('mapping live', {
    timeout: 120_000,
  })

  const editor = page.locator('.cm-content')
  await editor.click()
  await editor.press('Control+A')
  await page.keyboard.insertText('module broken(')

  await expect(page.locator('.pane-left .tag')).toHaveText('synthesis failed', {
    timeout: 120_000,
  })
  await expect(page.getByText(/analysis is stale/i)).toHaveCount(0)
  const banner = page.locator('.error-strip')
  const details = banner.locator('details')
  await expect(banner).toBeVisible()
  await expect(banner.locator('.synth-icon')).toBeVisible()
  await expect(banner.locator('.bub')).toHaveCount(0)
  await expect(details).not.toHaveAttribute('open', '')
  await expect(banner.locator('pre')).toBeHidden()
  await expect
    .poll(async () => Math.round((await banner.boundingBox())?.height ?? 0))
    .toBeLessThanOrEqual(32)

  await banner.locator('summary').click()
  await expect(details).toHaveAttribute('open', '')
  await expect(banner.locator('pre')).toBeVisible()
  await expect(banner.locator('pre')).not.toBeEmpty()
  expect(apiRequests).toEqual([])
})
