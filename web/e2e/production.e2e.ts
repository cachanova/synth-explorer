import { expect, test, type Page } from '@playwright/test'

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

async function synthesize(page: Page) {
  const ready = page.getByRole('button', { name: 'Synthesize', exact: true })
  const completed = page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const button = document.querySelector<HTMLButtonElement>(
          'button[title="Synthesize in this browser (Ctrl+Enter)"]',
        )
        if (!button) {
          reject(new Error('synthesis button is missing'))
          return
        }
        let started = false
        const timer = window.setTimeout(() => {
          observer.disconnect()
          reject(new Error('synthesis did not complete'))
        }, 120_000)
        const observer = new MutationObserver(() => {
          if (button.disabled) {
            started = true
            return
          }
          if (!started) return
          window.clearTimeout(timer)
          observer.disconnect()
          resolve()
        })
        observer.observe(button, { attributes: true, attributeFilter: ['disabled'] })
      }),
  )
  await ready.click()
  await completed
  await page.getByRole('tab', { name: 'Overview', exact: true }).click()
  await expect(page.getByText('Structural logic depth', { exact: true })).toBeVisible()
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

test('synthesizes and analyzes locally, then reuses the per-browser cache', async ({ page }) => {
  const apiRequests = recordApiRequests(page)
  await page.goto('/')

  await expect(page.getByText('Synth Explorer', { exact: true })).toBeVisible()
  await page.getByLabel('Example').selectOption('reg_mux')
  const flags = page.getByLabel('Synthesis flags')
  await page.getByLabel('Mode').selectOption('xilinx')
  await expect(flags).toHaveValue('-narrowcarry 8 -nowidelut -noiopad')

  await synthesize(page)
  await expect(page.locator('.card').filter({ hasText: 'Cells' }).locator('.v')).toHaveText(/^\d+$/)
  expect(await cacheEntryCount(page)).toBe(1)

  const started = Date.now()
  await synthesize(page)
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
    const records = await new Promise<Array<{ output: { netlistJson: string } }>>(
      (resolve, reject) => {
        read.onsuccess = () => resolve(read.result)
        read.onerror = () => reject(read.error)
      },
    )
    records[0].output.netlistJson = '{'
    store.put(records[0])
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  })
  await synthesize(page)
  const repaired = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('synth-explorer')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const read = database.transaction('syntheses').objectStore('syntheses').getAll()
    const records = await new Promise<Array<{ output: { netlistJson: string } }>>(
      (resolve, reject) => {
        read.onsuccess = () => resolve(read.result)
        read.onerror = () => reject(read.error)
      },
    )
    JSON.parse(records[0].output.netlistJson)
    return records.length
  })
  expect(repaired).toBe(1)

  await page.getByRole('button', { name: 'Theme settings' }).click()
  await page.getByRole('button', { name: 'Clear synthesis cache' }).click()
  await expect(page.getByRole('status')).toHaveText('Cleared from this browser.')
  expect(await cacheEntryCount(page)).toBe(0)
  expect(apiRequests).toEqual([])
})

test('renders and resizes the browser-produced graph without resetting user zoom', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  const apiRequests = recordApiRequests(page)
  await page.goto('/')
  await page.getByLabel('Example').selectOption('reg_mux')
  await synthesize(page)
  await page.getByRole('tab', { name: 'Schematic', exact: true }).click()

  const stage = page.locator('.graph-stage')
  const svg = stage.locator('svg')
  const viewport = svg.locator(':scope > g').first()
  await expect(svg).toBeVisible()
  await expect(page.locator('.g-node-body').first()).toBeVisible()
  await expect(page.getByLabel('Focus')).toBeDisabled()

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
  await page.getByLabel('Example').selectOption('handshake_controller')
  await page.getByLabel('Mode').selectOption('xilinx')
  await synthesize(page)
  await page.getByRole('tab', { name: 'Schematic', exact: true }).click()

  const focus = page.getByLabel('Focus')
  await expect(focus).toBeChecked()
  await expect(focus).toBeDisabled()
  const fullNodes = page.locator('.g-node-body')
  await expect(fullNodes.first()).toBeVisible()
  const fullNodeIds = await fullNodes.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-graph-node-id')),
  )
  expect(fullNodeIds.length).toBeGreaterThan(0)

  await page.locator('.cm-line', { hasText: "wait_count <= wait_count + 1'b1;" }).click()
  await expect(focus).toBeEnabled()
  await expect(focus).toBeChecked()
  await expect.poll(() => page.locator('.g-node-body').count()).toBeLessThan(fullNodeIds.length)
  expect(await page.locator('.g-node-body').count()).toBeGreaterThan(0)

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
