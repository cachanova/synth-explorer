import { expect, test } from '@playwright/test'

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

test('connects to loopback Vivado and analyzes its returned netlist in browser workers', async ({ page }) => {
  let synthesisRequest: Record<string, unknown> | null = null
  await page.route('http://127.0.0.1:32123/v1/status', async (route) => {
    expect(route.request().headers()['x-synth-explorer-token']).toBeUndefined()
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        protocol_version: 1,
        bridge_version: '0.1.0-test',
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
        log: 'fake Vivado synthesis complete',
      }),
    })
  })

  await page.goto('/')
  await page.getByLabel('Top module/entity').fill('top')
  await page.getByLabel('Synthesis engine').selectOption('vivado')

  await expect(page.getByLabel('Synthesis engine')).toHaveValue('vivado')
  await page.getByRole('button', { name: 'Synthesize' }).click()
  await page.getByRole('tab', { name: 'Overview' }).click()

  const overview = page.getByRole('tabpanel', { name: 'Overview' })
  await expect(overview.getByText('Vivado', { exact: true })).toBeVisible()
  await expect(overview.getByText('xc7a35tcpg236-1', { exact: true })).toBeVisible()
  await expect(overview.getByText('Xilinx', { exact: true })).toBeVisible()
  await expect.poll(() => synthesisRequest).not.toBeNull()
  expect(synthesisRequest).toMatchObject({
    top: 'top',
    target: 'xc7a35tcpg236-1',
  })
})
