import { expect, test } from '@playwright/test'
import {
  cacheEntryCount,
  recordApiRequests,
  waitForAnalysisReady,
  waitForAutomaticSynthesis,
} from './helpers'

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
    await page.getByLabel('Platform').selectOption('xilinx')
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

