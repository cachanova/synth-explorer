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

test('auto-aligns CodeMirror Verilog block closing keywords', async ({
  page,
}) => {
  const editor = page.locator('.cm-content')
  const pairs = [
    ['module top;', 'endmodule'],
    ['generate', 'endgenerate'],
    ['function automatic logic f;', 'endfunction'],
    ['task run;', 'endtask'],
    ['case (sel)', 'endcase'],
    ['casex (sel)', 'endcase'],
    ['casez (sel)', 'endcase'],
    ['class packet;', 'endclass'],
    ['interface bus;', 'endinterface'],
    ['package defs;', 'endpackage'],
    ['program test;', 'endprogram'],
    ['property p;', 'endproperty'],
    ['sequence s;', 'endsequence'],
    ['covergroup cg;', 'endgroup'],
    ['checker c;', 'endchecker'],
    ['clocking cb;', 'endclocking'],
    ['config cfg;', 'endconfig'],
    ['primitive p (o, i);', 'endprimitive'],
    ['specify', 'endspecify'],
    ['table', 'endtable'],
    ['begin', 'end'],
    ['do', 'while'],
    ['fork', 'join'],
    ['fork', 'join_any'],
    ['fork', 'join_none'],
  ] as const

  for (const [opener, closer] of pairs) {
    await replaceEditorText(page, `${opener}\n  `)
    await editor.type(closer)
    expect(await lineText(editor, 1), `${opener} should align ${closer}`).toBe(
      closer,
    )
  }
})

test('provides standard close-bracket and in-editor search behavior', async ({
  page,
}) => {
  const editor = page.locator('.cm-content')
  await replaceEditorText(page, 'module top;\n  wire ready = ')
  await editor.type('(')
  expect(await lineText(editor, 1)).toBe('  wire ready = ()')

  await editor.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f')
  const search = page.locator('.cm-search')
  await expect(search).toBeVisible()
  await search
    .getByRole('textbox', { name: 'Find', exact: true })
    .pressSequentially('module')
  await expect(page.locator('.cm-searchMatch')).toHaveCount(1)
  await editor.focus()
  await editor.press('Escape')
  await expect(search).toHaveCount(0)
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

  await editor.press('v')
  const beforeVisualTab = await editorText(editor)
  await editor.press('Tab')
  expect(await editorText(editor)).toBe(beforeVisualTab)
  await editor.press('Escape')

  await editor.press('x')
  expect(await editorText(editor)).not.toBe(afterInsert)

  const beforeReplace = await editorText(editor)
  const replaceMarker = '\tvim'
  const replaceAt = beforeReplace.lastIndexOf(replaceMarker) + replaceMarker.length - 1
  expect(replaceAt).toBeGreaterThanOrEqual(replaceMarker.length - 1)
  await editor.press('R')
  await expect(page.locator('.cm-vim-panel')).toContainText('--REPLACE--')
  await editor.press('Tab')
  await editor.press('Escape')
  const afterReplace = await editorText(editor)
  expect(afterReplace).toBe(
    `${beforeReplace.slice(0, replaceAt)}\t${beforeReplace.slice(replaceAt)}`,
  )

  await page.reload()
  await expect(page.locator('.cm-vim-panel')).toContainText('--NORMAL--')
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByRole('radio', { name: 'Vim', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  )
})
