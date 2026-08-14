import { expect, type Locator, type Page } from '@playwright/test'

export function recordApiRequests(page: Page): string[] {
  const requests: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      requests.push(`${request.method()} ${url.pathname}`)
    }
  })
  return requests
}

export async function replaceEditorText(page: Page, text: string) {
  const editor = page.locator('.cm-content')
  await editor.click()
  await editor.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await editor.fill(text)
}

export async function editorText(target: Page | Locator): Promise<string> {
  if ('goto' in target) return target.locator('.cm-content').innerText()
  return (await target.locator('.cm-line').allTextContents()).join('\n')
}

export async function waitForAnalysisReady(page: Page) {
  await expect(page.locator('.pane-right')).toHaveAttribute('data-analysis-state', 'current', {
    timeout: 120_000,
  })
  await expect(page.locator('.graph-stage svg')).toBeAttached({ timeout: 120_000 })
  await expect(page.locator('.graph-loading-indicator')).toHaveCount(0)
}

export async function waitForAutomaticSynthesis(
  page: Page,
  changeInput: () => Promise<unknown>,
) {
  const analysisPane = page.locator('.pane-right')
  await analysisPane.waitFor()
  await changeInput()
  await expect(analysisPane).not.toHaveAttribute('data-analysis-state', 'current')
  await expect(analysisPane).toHaveAttribute('data-analysis-state', 'current', {
    timeout: 120_000,
  })
}

export async function startAnalysisStateRecording(page: Page) {
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

export async function recordedAnalysisStates(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      (window as typeof window & { __synthesisStates?: string[] })
        .__synthesisStates ?? [],
  )
}

export async function stopAnalysisStateRecording(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const testWindow = window as typeof window & {
      __synthesisStates?: string[]
      __synthesisObserver?: MutationObserver
    }
    testWindow.__synthesisObserver?.disconnect()
    return testWindow.__synthesisStates ?? []
  })
}

export async function cacheEntryCount(page: Page): Promise<number> {
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

export async function zoomSchematicToScale(
  page: Page,
  targetScale: number,
  anchor?: Locator,
) {
  const svg = page.locator('.graph-stage svg')
  const anchorBox = await anchor?.boundingBox()
  await svg.evaluate((element, options) => {
    const transform = element.querySelector(':scope > g')?.getAttribute('transform') ?? ''
    const current = Number(/scale\(([^)]+)\)/.exec(transform)?.[1])
    if (!Number.isFinite(current) || current <= 0) {
      throw new Error(`Could not read viewport scale from ${transform}`)
    }
    element.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: options.clientX,
      clientY: options.clientY,
      deltaY: -Math.log(options.targetScale / current) / 0.0016,
    }))
  }, {
    targetScale,
    clientX: anchorBox ? anchorBox.x + anchorBox.width / 2 : 0,
    clientY: anchorBox ? anchorBox.y + anchorBox.height / 2 : 0,
  })
}

// A no-op edit (type a space, delete it) marks the input changed so the
// auto-synthesis debounce re-runs the current design.
export async function retriggerCurrentInput(page: Page) {
  const editor = page.locator('.cm-content')
  await editor.click()
  await editor.press('Control+End')
  await editor.type(' ')
  await editor.press('Backspace')
}
