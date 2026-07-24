import { expect, test, type Page } from '@playwright/test'

// Live-bridge validation: requires a running synth-explorer-vivado-bridge on
// 127.0.0.1:32123 with this preview origin allowed and a real local Vivado.
// Skips (does not fail) when no bridge is reachable, so the default suite
// stays green on machines and CI runners without Vivado.

const BRIDGE_ORIGIN = 'http://127.0.0.1:32123'

const SOURCE = `module top(input clk, input sel, input [3:0] a, b, output reg [3:0] q);
  wire [3:0] sum = a + b;
  always @(posedge clk)
    if (sel) q <= sum;
    else q <= b;
endmodule`

async function bridgeAvailable(appOrigin: string): Promise<boolean> {
  try {
    const response = await fetch(`${BRIDGE_ORIGIN}/v1/status`, {
      headers: { Origin: appOrigin },
      signal: AbortSignal.timeout(2_000),
    })
    if (!response.ok) return false
    const status = (await response.json()) as { parts?: unknown[] }
    return Array.isArray(status.parts) && status.parts.length > 0
  } catch {
    return false
  }
}

async function replaceEditorText(page: Page, text: string) {
  const editor = page.locator('.cm-content')
  await editor.click()
  await editor.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await editor.fill(text)
}

test('attributes tiered source through a real local Vivado synthesis', async ({
  page,
  baseURL,
}) => {
  const appOrigin = new URL(baseURL ?? 'http://127.0.0.1:4173').origin
  test.skip(
    !(await bridgeAvailable(appOrigin)),
    'no local Vivado bridge on 127.0.0.1:32123',
  )
  // Real synth_design runs take minutes even for tiny designs.
  test.setTimeout(600_000)

  await page.goto('/')
  await replaceEditorText(page, SOURCE)
  await page.getByLabel('Top').fill('top')
  await page.getByLabel('Synthesis tool').selectOption('vivado')

  // Family/speed populate from the live parts catalog once the bridge
  // status arrives; a default target is auto-selected.
  await expect(page.getByLabel('Family')).toBeVisible()
  await expect
    .poll(async () => (await page.getByLabel('Family').locator('option').count()), {
      timeout: 30_000,
    })
    .toBeGreaterThan(0)

  await page.getByRole('button', { name: 'Synthesize' }).click()
  const analysisPane = page.locator('.pane-right')
  await expect(analysisPane).toHaveAttribute('data-analysis-state', 'current', {
    timeout: 480_000,
  })

  await page.getByRole('tab', { name: 'Overview' }).click()
  const overview = page.getByRole('tabpanel', { name: 'Overview' })
  await expect(overview.getByText('Vivado', { exact: true })).toBeVisible()

  await page.getByRole('tab', { name: 'Schematic', exact: true }).click()
  const registerNode = page.locator('.g-node-body.g-symbol-reg').first()
  await expect(registerNode).toBeVisible()
  await registerNode.click()
  await expect(registerNode).toHaveClass(/selected/)

  // Register attribution must be statement-precise on real Vivado output:
  // the renamed q_reg resolves through the dialect back to RTL `q`.
  const exactLines = page.locator('.cm-line.cm-src-hl')
  await expect
    .poll(() => exactLines.count(), { timeout: 30_000 })
    .toBeGreaterThan(0)
  await expect(
    exactLines.filter({ hasText: 'if (sel) q <= sum;' }),
  ).toHaveCount(1)
  await expect(exactLines.filter({ hasText: 'else q <= b;' })).toHaveCount(1)
  await expect(
    exactLines.filter({ hasText: 'output reg [3:0] q' }),
  ).toHaveCount(0)

  // Combinational attribution on Vivado may be a flagged superset when
  // intermediate nets were renamed: require that selecting a LUT either
  // produces decorations or the approximate/partial notice — never nothing.
  // Clicking the LUT directly replaces the register selection; no deselect
  // step, which would flip the mobile-layout workspace to the editor pane.
  const lutNode = page.locator('.g-node-body[data-node-tooltip*="LUT"]').first()
  await expect(lutNode).toBeVisible()
  await lutNode.click()
  const anyDecoration = page.locator(
    '.cm-src-hl, .cm-src-range-hl, .cm-src-hl-contributing, .cm-src-range-hl-contributing',
  )
  const notice = page.getByText(/Source highlight is (approximate|partial)/)
  await expect
    .poll(
      async () =>
        (await anyDecoration.count()) > 0 || (await notice.count()) > 0,
      { timeout: 30_000 },
    )
    .toBe(true)
})
