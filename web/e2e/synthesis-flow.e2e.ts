import { expect, test } from '@playwright/test'
import {
  recordApiRequests,
  recordedAnalysisStates,
  startAnalysisStateRecording,
  stopAnalysisStateRecording,
  waitForAnalysisReady,
} from './helpers'

test('supports persistent manual synthesis and a configurable delay', async ({ page }) => {
  const apiRequests = recordApiRequests(page)
  await page.goto('/')
  await waitForAnalysisReady(page)

  await startAnalysisStateRecording(page)

  await page.getByRole('button', { name: 'Settings' }).click()
  const automatic = page.getByRole('checkbox', {
    name: 'Synthesize automatically',
  })
  await expect(automatic).toBeChecked()
  const delay = page.getByLabel('Automatic synthesis delay')
  await expect(delay).toHaveValue('250')
  await delay.focus()
  for (let step = 0; step < 5; step += 1) await delay.press('ArrowRight')
  await expect(page.locator('.settings-delay-value')).toHaveText('0.5 s')
  await page.waitForTimeout(750)
  expect(await stopAnalysisStateRecording(page)).not.toContain('refreshing')

  await automatic.uncheck()
  await page.getByRole('button', { name: 'Settings' }).click()
  const synthesize = page.getByRole('button', { name: 'Synthesize', exact: true })
  await expect(synthesize).toBeVisible()

  await page.getByLabel('Bundled example').selectOption('reg_mux')
  await page.waitForTimeout(750)
  await expect(page.locator('.pane-right')).toHaveAttribute(
    'data-analysis-state',
    'stale',
  )

  await synthesize.click()
  await waitForAnalysisReady(page)

  await page.getByRole('button', { name: 'Settings' }).click()
  await automatic.check()
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(synthesize).toHaveCount(0)

  await startAnalysisStateRecording(page)
  await page.getByLabel('Bundled example').selectOption('counter')
  await page.waitForTimeout(250)
  await expect(page.locator('.pane-right')).toHaveAttribute(
    'data-analysis-state',
    'stale',
  )
  await expect
    .poll(() => recordedAnalysisStates(page), { timeout: 500 })
    .toContain('refreshing')
  await stopAnalysisStateRecording(page)
  await expect(page.locator('.pane-right')).toHaveAttribute(
    'data-analysis-state',
    'current',
    { timeout: 120_000 },
  )

  await page.getByRole('button', { name: 'Settings' }).click()
  await automatic.uncheck()
  await page.reload()
  await expect(synthesize).toBeVisible()
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(
    page.getByRole('checkbox', { name: 'Synthesize automatically' }),
  ).not.toBeChecked()
  await expect(page.getByLabel('Automatic synthesis delay')).toHaveValue('500')
  expect(apiRequests).toEqual([])
})

test('keeps synthesis failures compact until the full log is requested', async ({ page }) => {
  const apiRequests = recordApiRequests(page)
  await page.goto('/')
  await waitForAnalysisReady(page)

  const editor = page.locator('.cm-content')
  await editor.click()
  await editor.press('Control+A')
  await page.keyboard.insertText('module broken(')

  await expect(page.getByText(/analysis is stale/i)).toHaveCount(0)
  const banner = page.locator('.error-strip')
  await expect(banner).toBeVisible({ timeout: 120_000 })
  const details = banner.locator('details')
  await expect(banner.locator('.synth-icon')).toBeVisible()
  await expect(banner.locator('.error-location')).toHaveText('design.sv:1')
  await expect(editor.locator('.cm-lintRange-error')).toBeVisible()
  await expect(banner.locator('.bub')).toHaveCount(0)
  await expect(details).not.toHaveAttribute('open', '')
  await expect(banner.locator('pre')).toBeHidden()
  await expect
    .poll(async () => Math.round((await banner.boundingBox())?.height ?? 0))
    .toBeLessThanOrEqual(32)

  await startAnalysisStateRecording(page)
  await page.getByRole('button', { name: 'Settings' }).click()
  const delay = page.getByLabel('Automatic synthesis delay')
  await delay.focus()
  await delay.press('ArrowRight')
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.waitForTimeout(500)
  expect(await stopAnalysisStateRecording(page)).not.toContain('refreshing')

  await banner.locator('summary').click()
  await expect(details).toHaveAttribute('open', '')
  await expect(banner.locator('pre')).toBeVisible()
  await expect(banner.locator('pre')).not.toBeEmpty()

  await editor.fill(
    "module top(output logic y); assign y = 1'b0; endmodule",
  )
  await page.waitForTimeout(0)
  expect(await banner.count()).toBe(0)
  expect(await editor.locator('.cm-lintRange-error').count()).toBe(0)
  await waitForAnalysisReady(page)
  expect(apiRequests).toEqual([])
})

