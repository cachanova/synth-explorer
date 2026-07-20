import { expect, test } from '@playwright/test'

test('shows complete local Vivado setup and pairing instructions in the website', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Synthesis engine').selectOption('vivado')

  const dialog = page.getByRole('dialog', { name: 'Use Vivado on this computer' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Install Vivado locally')
  await expect(dialog).toContainText('Download and start the bridge')
  await expect(dialog).toContainText('Pair this tab')
  await expect(dialog.getByText('./synth-explorer-vivado-bridge', { exact: false })).toBeVisible()
  await expect(dialog.getByLabel('Pairing code')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Connect local Vivado' })).toBeVisible()
})
