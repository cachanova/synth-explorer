import { expect, test, type Page } from '@playwright/test'

const structuralNetlist = [
  '`timescale 1 ps / 1 ps',
  'module top (',
  '  input wire clk,',
  '  input wire rst,',
  '  input wire [7:0] a,',
  '  input wire [7:0] b,',
  '  input wire sel,',
  '  output wire [7:0] q',
  ');',
  "  LUT2 #(.INIT(4'h8)) q0_lut (.I0(a[0]), .I1(b[0]), .O(q[0]));",
  '  assign q[7:1] = a[7:1];',
  'endmodule',
  '',
].join('\n')

async function replaceEditorText(page: Page, text: string) {
  const editor = page.locator('.cm-content')
  await editor.click()
  await editor.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await editor.fill(text)
}

test('connects to loopback Vivado and analyzes its returned netlist in browser workers', async ({ page }) => {
  let synthesisRequest: Record<string, unknown> | null = null
  await page.route('http://127.0.0.1:32123/v1/status', async (route) => {
    expect(route.request().headers()['x-synth-explorer-token']).toBeUndefined()
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        protocol_version: 2,
        bridge_version: '0.2.0-test',
        vivado_version: 'Vivado v2026.1',
        parts: [{ name: 'xc7a35tcpg236-1', family: 'artix7', speed: '-1' }],
      }),
    })
  })
  await page.route('http://127.0.0.1:32123/v1/synthesize', async (route) => {
    expect(route.request().headers()['x-synth-explorer-token']).toBeUndefined()
    synthesisRequest = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        top: 'top',
        target: 'xc7a35tcpg236-1',
        netlist: structuralNetlist,
        timing: {
          data_path_delay_ns: 4.016,
          logic_delay_ns: 3.216,
          net_delay_ns: 0.8,
          logic_levels: 2,
          startpoint: 'q_reg[0]/C',
          endpoint: 'q[0]',
          corner: 'Slow',
          delay_type: 'max',
          report: 'Timing Report\n\nData Path Delay:        4.016ns',
        },
        log: 'fake Vivado synthesis complete',
      }),
    })
  })

  await page.goto('/')
  await page.getByLabel('Top module/entity').fill('top')
  await page.getByLabel('Synthesis tool').selectOption('vivado')

  await expect(page.getByLabel('Synthesis tool')).toHaveValue('vivado')
  await page.getByRole('button', { name: 'Synthesize' }).click()
  await page.getByRole('tab', { name: 'Overview' }).click()

  const overview = page.getByRole('tabpanel', { name: 'Overview' })
  await expect(overview.getByText('Vivado', { exact: true })).toBeVisible()
  await expect(overview.getByText('xc7a35tcpg236-1', { exact: true })).toBeVisible()
  await expect(overview.getByText('Xilinx', { exact: true })).toBeVisible()
  await expect(overview.getByText('Vivado timing report', { exact: true })).toBeVisible()
  await expect(overview.getByText('4.02 ns', { exact: true })).toBeVisible()
  await expect(overview.getByText('Delay profile', { exact: true })).toHaveCount(0)
  await expect.poll(() => synthesisRequest).not.toBeNull()
  expect(synthesisRequest).toMatchObject({
    top: 'top',
    target: 'xc7a35tcpg236-1',
  })
})

test('marks Vivado disconnected when the bridge disappears during synthesis', async ({ page }) => {
  let synthesisRequests = 0
  await page.route('http://127.0.0.1:32123/v1/status', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        protocol_version: 2,
        bridge_version: '0.2.0-test',
        vivado_version: 'Vivado v2026.1',
        parts: [{ name: 'xc7a35tcpg236-1', family: 'artix7', speed: '-1' }],
      }),
    })
  })
  await page.route('http://127.0.0.1:32123/v1/synthesize', async (route) => {
    synthesisRequests += 1
    await route.abort('failed')
  })

  await page.goto('/')
  await replaceEditorText(page, [
    'module top(',
    '  input wire a,',
    '  output wire q',
    ');',
    '  assign q = a;',
    'endmodule',
    '',
  ].join('\n'))
  await page.getByLabel('Top module/entity').fill('top')
  await page.getByLabel('Synthesis tool').selectOption('vivado')

  await expect(page.getByLabel('Synthesis tool')).toHaveValue('vivado')
  await page.getByRole('button', { name: 'Synthesize' }).click()

  await expect.poll(() => synthesisRequests).toBe(1)
  await expect(page.locator('.error-strip')).toContainText('Could not reach the local Vivado bridge')
  await expect(page.getByLabel('Synthesis tool')).toHaveValue('yosys')
  await expect(page.getByRole('button', { name: 'Connected' })).toHaveCount(0)
})
