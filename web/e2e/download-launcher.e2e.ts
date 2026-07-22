import { expect, test } from '@playwright/test'

const RELEASE_DOWNLOAD =
  'https://github.com/cachanova/synth-explorer/releases/latest/download'

test('offers the Linux local application and complete run instructions', async ({
  page,
}) => {
  await page.goto('/')

  const trigger = page.getByRole('button', {
    name: 'Download local Synth Explorer',
  })
  await expect(trigger).toBeVisible()
  await expect(page.locator('.app-header > :last-child')).toHaveAttribute(
    'aria-label',
    'Download local Synth Explorer',
  )
  await trigger.click()

  const dialog = page.getByRole('dialog', {
    name: 'Run Synth Explorer locally',
  })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('link', { name: 'Download Linux x86-64' })).toHaveAttribute(
    'href',
    `${RELEASE_DOWNLOAD}/synth-explorer-local-linux-x86_64.tar.gz`,
  )
  await expect(dialog.getByRole('link', {
    name: 'Download SHA-256 checksum for Linux x86-64',
  })).toHaveAttribute(
    'href',
    `${RELEASE_DOWNLOAD}/synth-explorer-local-linux-x86_64.tar.gz.sha256`,
  )
  await expect(dialog).toContainText('./synth-explorer')
  await expect(dialog).toContainText('Chrome or Chromium is required')
  await expect(dialog).toContainText('selecting Vivado starts the built-in connector')

  await expect(page.getByRole('button', { name: 'Close download instructions' })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(
    dialog.getByRole('link', { name: 'View every download and release note' }),
  ).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Close download instructions' })).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(trigger).toBeFocused()
})

test('offers both macOS architectures and remote Vivado instructions', async ({
  browser,
}) => {
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36',
  })
  const page = await context.newPage()
  await page.goto('/')
  await page.getByRole('button', { name: 'Download local Synth Explorer' }).click()

  const dialog = page.getByRole('dialog', {
    name: 'Run Synth Explorer locally',
  })
  await expect(
    dialog.getByRole('link', { name: 'Download macOS Apple Silicon' }),
  ).toHaveAttribute(
    'href',
    `${RELEASE_DOWNLOAD}/synth-explorer-local-macos-arm64.tar.gz`,
  )
  await expect(
    dialog.getByRole('link', { name: 'Download macOS Intel' }),
  ).toHaveAttribute(
    'href',
    `${RELEASE_DOWNLOAD}/synth-explorer-local-macos-x86_64.tar.gz`,
  )
  await expect(dialog).toContainText('Apple silicon or Intel archive')
  await expect(dialog).not.toContainText('About This Mac')
  await expect(dialog).toContainText('System Settings → Privacy & Security')
  await expect(dialog).toContainText('Open Anyway')
  await expect(dialog).toContainText(
    'ssh -N -L 32125:127.0.0.1:32123 user@vivado-host',
  )
  await context.close()
})

test('does not show a download control inside the local application', async ({
  page,
}) => {
  await page.goto('/?launcher=1')
  await expect(
    page.getByRole('button', { name: 'Download local Synth Explorer' }),
  ).toHaveCount(0)
})
