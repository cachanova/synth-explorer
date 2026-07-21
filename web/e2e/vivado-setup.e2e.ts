import { expect, test } from '@playwright/test'

test('shows complete local Vivado setup and direct connection instructions in the website', async ({ page }) => {
  await page.route('http://127.0.0.1:32123/v1/status', async (route) => {
    await route.abort('connectionrefused')
  })
  await page.goto('/')
  await page.getByLabel('Synthesis engine').selectOption('vivado')

  const dialog = page.getByRole('dialog', { name: 'Use Vivado on this computer' })
  await expect(dialog).toBeVisible()
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
