import { expect, test } from '@playwright/test'

test('starts local Vivado on selection and requests a path only when discovery fails', async ({ page }) => {
  let startRequests = 0
  await page.route('**/launcher/vivado/start', async (route) => {
    startRequests += 1
    const request = route.request()
    if (startRequests === 1) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      await route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Vivado was not found or could not start',
          path_required: true,
        }),
      })
      return
    }

    expect(request.postDataJSON()).toEqual({
      vivado: '/opt/Xilinx/Vivado/2026.1/bin/vivado',
    })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        protocol_version: 2,
        bridge_version: '0.2.1-test',
        vivado_version: 'Vivado v2026.1',
        parts: [{ name: 'xc7a35tcpg236-1', family: 'artix7', speed: '-1' }],
      }),
    })
  })
  await page.route('http://127.0.0.1:32125/v1/status', (route) => route.abort())

  await page.goto('/?launcher=1')
  expect(startRequests).toBe(0)

  await page.getByLabel('Synthesis tool').selectOption('vivado')
  const dialog = page.getByRole('dialog', { name: 'Use Vivado on this computer' })
  await expect(dialog.getByRole('status', { name: 'Starting Vivado' })).toBeVisible()
  await expect(dialog).not.toContainText('Install Vivado locally')

  await expect(dialog.getByText('Vivado was not found', { exact: true })).toBeVisible()
  await dialog.getByLabel('Vivado executable path').fill('/opt/Xilinx/Vivado/2026.1/bin/vivado')
  await dialog.getByRole('button', { name: 'Start Vivado' }).click()

  await expect(dialog).toBeHidden()
  await expect(page.getByLabel('Synthesis tool')).toHaveValue('vivado')
  expect(startRequests).toBe(2)
})
