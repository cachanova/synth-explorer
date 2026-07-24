import { expect, test, type Page } from '@playwright/test'
import { waitForAnalysisReady } from './helpers'

const SOURCE = `module top(input clk, input sel, input [3:0] a, b, output reg [3:0] q);
  wire [3:0] sum = a + b;
  always @(posedge clk)
    if (sel) q <= sum;
    else q <= b;
endmodule`

function recordExternalRequests(page: Page, appOrigin: string): string[] {
  const requests: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (
      url.origin !== appOrigin ||
      url.pathname === '/api' ||
      url.pathname.startsWith('/api/')
    ) {
      requests.push(`${request.method()} ${request.url()}`)
    }
  })
  return requests
}

async function replaceEditorText(page: Page, text: string) {
  const editor = page.locator('.cm-content')
  await editor.click()
  await editor.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await editor.fill(text)
}

test('highlights exact and contributing source tiers for a schematic register', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(240_000)
  const externalRequests = recordExternalRequests(
    page,
    new URL(baseURL ?? 'http://127.0.0.1:4173').origin,
  )

  await page.goto('/')
  await waitForAnalysisReady(page)

  const analysisPane = page.locator('.pane-right')
  await replaceEditorText(page, SOURCE)
  await page.getByLabel('Platform').selectOption('lut4')
  await expect(analysisPane).not.toHaveAttribute('data-analysis-state', 'current')
  await waitForAnalysisReady(page)

  await page.getByRole('tab', { name: 'Schematic', exact: true }).click()
  const registerNode = page.locator('.g-node-body.g-symbol-reg').first()
  await expect(registerNode).toBeVisible()
  await registerNode.click()
  await expect(registerNode).toHaveClass(/selected/)

  const exactLines = page.locator('.cm-line.cm-src-hl')
  const exactDecorations = page.locator('.cm-src-hl, .cm-src-range-hl')
  const contributingDecorations = page.locator(
    '.cm-src-hl-contributing, .cm-src-range-hl-contributing',
  )
  await expect
    .poll(() => exactDecorations.count(), { timeout: 30_000 })
    .toBeGreaterThan(0)
  await expect
    .poll(() => contributingDecorations.count(), { timeout: 30_000 })
    .toBeGreaterThan(0)
  await expect(
    exactLines.filter({ hasText: 'if (sel) q <= sum;' }),
  ).toHaveCount(1)
  await expect(
    exactLines.filter({ hasText: 'else q <= b;' }),
  ).toHaveCount(1)
  await expect(page.locator('.cm-line.cm-activeLine.cm-src-hl')).toContainText(
    'q <=',
  )
  await expect(page.locator('.cm-line.cm-activeLine.cm-src-hl')).toBeVisible()

  await page.locator('.cm-content').press('Escape')
  await expect(registerNode).not.toHaveClass(/selected/)
  await expect(exactDecorations).toHaveCount(0)
  await expect(contributingDecorations).toHaveCount(0)
  expect(externalRequests).toEqual([])
})
