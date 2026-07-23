import { expect, test } from '@playwright/test'

test('shows complete local Vivado setup and direct connection instructions in the website', async ({ page }) => {
  await page.route('http://127.0.0.1:32123/v1/status', async (route) => {
    await route.abort('connectionrefused')
  })
  await page.goto('/')
  await page.getByLabel('Synthesis tool').selectOption('vivado')

  const dialog = page.getByRole('dialog', { name: 'Use Vivado on this computer' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Your RTL goes directly to your local Vivado instance. Everything stays local.')
  await expect(dialog).toContainText('Install Vivado locally')
  await expect(dialog).toContainText('Start the local connector')
  await expect(dialog).toContainText('Connect this browser')
  await expect(dialog.getByRole('link', { name: 'Download for Linux x86-64' })).toBeVisible()
  await expect(dialog.getByRole('link', { name: 'Download Windows host binary' })).toBeVisible()
  await expect(dialog.getByText('curl -fsSL https://synthexplorer.dev/vivado | sh', { exact: true })).toBeVisible()
  await expect(dialog.getByLabel('Pairing code')).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Connect local Vivado' })).toBeVisible()

  await dialog.getByText('Vivado runs on another computer').click()
  await expect(dialog).toContainText('Linux, macOS, or Windows PowerShell')
  await expect(dialog).toContainText('ssh -N -L 32123:127.0.0.1:32123 user@vivado-host')
})

test('starts the built-in connector and offers a Vivado path in the downloadable launcher', async ({ page }) => {
  let launcherStartRequests = 0
  let localConnectorRequests = 0
  await page.route('**/launcher/vivado/start', async (route) => {
    launcherStartRequests += 1
    await route.fulfill({
      status: 422,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'Vivado was not found or could not start',
        path_required: true,
      }),
    })
  })
  await page.route('http://127.0.0.1:32125/v1/status', async (route) => {
    localConnectorRequests += 1
    await route.abort('connectionrefused')
  })
  await page.goto('/?launcher=1')
  await page.getByLabel('Synthesis tool').selectOption('vivado')

  await expect.poll(() => launcherStartRequests).toBe(1)
  await expect.poll(() => localConnectorRequests).toBe(1)
  const dialog = page.getByRole('dialog', { name: 'Use Vivado on this computer' })
  await expect(dialog.getByText('Vivado was not found', { exact: true })).toBeVisible()
  await expect(dialog.getByLabel('Vivado executable path')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Start Vivado' })).toBeVisible()
  await expect(dialog).not.toContainText('Start the local connector')
  await expect(dialog.getByRole('link', { name: /Download/ })).toHaveCount(0)
  await expect(dialog).not.toContainText('Vivado runs on another computer')
})

test('routes macOS launcher users to a remote Vivado host', async ({ browser }) => {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36',
  })
  const page = await context.newPage()
  await page.route('http://127.0.0.1:32125/v1/status', async (route) => {
    await route.abort('connectionrefused')
  })
  await page.goto('/?launcher=1')
  await page.getByLabel('Synthesis tool').selectOption('vivado')

  const dialog = page.getByRole('dialog', { name: 'Use Vivado on this computer' })
  await expect(dialog).toContainText('Run Vivado on a Linux or Windows host')
  await expect(dialog).toContainText('Vivado does not run natively on macOS')
  await expect(dialog.getByText(
    'ssh -N -L 32125:127.0.0.1:32123 user@vivado-host',
    { exact: true },
  )).toBeVisible()
  await expect(dialog).not.toContainText('The connector is built into this launcher')
  await context.close()
})
