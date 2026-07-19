import { expect, test, type Locator, type Page } from '@playwright/test'

async function replaceEditorText(page: Page, text: string) {
  const editor = page.locator('.cm-content')
  await editor.click()
  await editor.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await editor.fill(text)
}

async function lineText(editor: Locator, index: number): Promise<string> {
  return editor.locator('.cm-line').nth(index).evaluate((line) => line.textContent ?? '')
}

async function editorText(editor: Locator): Promise<string> {
  return (await editor.locator('.cm-line').allTextContents()).join('\n')
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    localStorage.removeItem('synthexplorer.editorKeymap.v1')
  })
  await page.reload()
})

test('inserts a literal tab at the cursor', async ({ page }) => {
  const editor = page.locator('.cm-content')
  await replaceEditorText(page, 'ab')
  await editor.press('Home')
  await editor.press('ArrowRight')
  await editor.press('Tab')

  expect(await lineText(editor, 0)).toBe('a\tb')
})

test('auto-indents begin blocks and aligns end while typing', async ({ page }) => {
  const editor = page.locator('.cm-content')
  await replaceEditorText(page, 'module top;\n  initial begin')
  await editor.press('End')
  await editor.press('Enter')
  expect(await lineText(editor, 2)).toBe('    ')

  await editor.type('wire ready;')
  await editor.press('Enter')
  expect(await lineText(editor, 3)).toBe('    ')

  await editor.type('end')
  expect(await lineText(editor, 3)).toBe('  end')
})

test('enables and remembers Vim keybindings', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('radio', { name: 'Vim', exact: true }).click()

  const editor = page.locator('.cm-content')
  await expect(page.locator('.cm-vim-panel')).toContainText('--NORMAL--')
  await editor.click()
  await editor.press('i')
  await expect(page.locator('.cm-vim-panel')).toContainText('--INSERT--')
  await editor.press('Tab')
  await editor.type('vim_')
  await editor.press('Escape')
  await expect(page.locator('.cm-vim-panel')).toContainText('--NORMAL--')
  const afterInsert = await editorText(editor)
  expect(afterInsert).toContain('\tvim_')

  await editor.press('Tab')
  expect(await editorText(editor)).toBe(afterInsert)
  await editor.press('x')
  expect(await editorText(editor)).not.toBe(afterInsert)

  await page.reload()
  await expect(page.locator('.cm-vim-panel')).toContainText('--NORMAL--')
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByRole('radio', { name: 'Vim', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  )
})
