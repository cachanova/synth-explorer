import { expect, test, type Page } from '@playwright/test'

async function editorText(page: Page): Promise<string> {
  return page.locator('.cm-content').innerText()
}

async function replaceEditorText(page: Page, text: string) {
  const editor = page.locator('.cm-content')
  await editor.click()
  await editor.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await editor.fill(text)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(async () => {
    localStorage.removeItem('synthexplorer.confirmResetWorkspace.v1')
    localStorage.removeItem('synthexplorer.workspaceResetPending.v1')
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase('synth-explorer-workspace')
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('workspace database deletion blocked'))
    })
  })
  await page.reload()
})

test('restores source files and synthesis inputs across reloads', async ({ page }) => {
  const source = 'module restored;\n  wire saved = 1\'b1;\nendmodule'
  await replaceEditorText(page, source)
  await page.getByTitle('Add file').click()
  await replaceEditorText(page, 'module helper; endmodule')
  await page.getByLabel('Top module').fill('restored')
  await page.getByLabel('Mode').selectOption('lut4')
  await page.getByLabel('Synthesis flags').fill('-noabc')

  await page.waitForTimeout(350)
  await page.reload()

  await expect(page.getByRole('tab', { name: /^file1\.sv/ })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(page.getByLabel('Top module')).toHaveValue('restored')
  await expect(page.getByLabel('Mode')).toHaveValue('lut4')
  await expect(page.getByLabel('Synthesis flags')).toHaveValue('-noabc')
  expect(await editorText(page)).toContain('module helper; endmodule')

  await page.getByRole('tab', { name: /^design\.sv/ }).click()
  expect(await editorText(page)).toContain("wire saved = 1'b1")
})

test('warns before reset, remembers opt-out, and exposes the preference in settings', async ({ page }) => {
  await replaceEditorText(page, 'module disposable; endmodule')
  await page.getByTitle('Add file').click()

  await page.getByRole('button', { name: 'Reset editor' }).click()
  const warning = page.getByRole('alertdialog', { name: 'Reset editor?' })
  await expect(warning).toBeVisible()
  await warning.getByRole('checkbox', { name: "Don't show this warning again" }).check()
  await warning.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('tab', { name: /^file1\.sv/ })).toBeVisible()

  await page.getByRole('button', { name: 'Reset editor' }).click()
  await expect(warning).toBeVisible()
  await warning.getByRole('checkbox', { name: "Don't show this warning again" }).check()
  await warning.getByRole('button', { name: 'Reset editor' }).click()

  await page.reload()
  await expect(page.getByRole('tab', { name: /^design\.sv/ })).toHaveCount(1)
  await expect(page.getByRole('tab', { name: /^file1\.sv/ })).toHaveCount(0)
  expect(await editorText(page)).toContain('module top')
  await expect(page.getByLabel('Top module')).toHaveValue('')
  await expect(page.getByLabel('Mode')).toHaveValue('gates')

  await page.getByRole('button', { name: 'Reset editor' }).click()
  await expect(warning).toHaveCount(0)

  await page.getByRole('button', { name: 'Settings' }).click()
  const confirmationSetting = page.getByRole('checkbox', {
    name: 'Confirm before resetting editor',
  })
  await expect(confirmationSetting).not.toBeChecked()
  await confirmationSetting.check()

  await page.reload()
  await page.getByRole('button', { name: 'Reset editor' }).click()
  await expect(warning).toBeVisible()
  await warning.getByRole('button', { name: 'Cancel' }).click()
  expect(await editorText(page)).toContain('module top')
})
