import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { waitForAnalysisReady } from './helpers'

declare global {
  interface Window {
    savedComputerFiles: Array<{
      scope: 'file' | 'directory'
      name: string
      content: string
    }>
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.savedComputerFiles = []

    const writable = (scope: 'file' | 'directory', name: string) => ({
      pendingContent: '',
      async write(content: string) {
        this.pendingContent = content
      },
      async close() {
        window.savedComputerFiles.push({
          scope,
          name,
          content: this.pendingContent,
        })
      },
    })

    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async (options: { suggestedName: string }) => ({
        async createWritable() {
          return writable('file', options.suggestedName)
        },
      }),
    })
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: async () => ({
        async getFileHandle(name: string, options: { create?: boolean }) {
          if (options.create !== true) throw new Error('create must be true')
          return {
            async createWritable() {
              return writable('directory', name)
            },
          }
        },
      }),
    })
  })
  await page.goto('/')
})

test('loads computer files and saves the active file or all open files', async ({
  page,
}) => {
  const design = 'module imported_top; endmodule'
  const helper = 'module imported_helper; endmodule'
  const fileChooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Load files from computer' }).click()
  const fileChooser = await fileChooserPromise
  await fileChooser.setFiles([
    { name: 'design.sv', mimeType: 'text/plain', buffer: Buffer.from(design) },
    { name: 'file1.sv', mimeType: 'text/plain', buffer: Buffer.from(helper) },
  ])

  const replacement = page.getByRole('dialog', {
    name: 'Replace existing files?',
  })
  await expect(replacement).toContainText('Replace design.sv?')
  await replacement.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('tab', { name: /^file1\.sv/ })).toHaveCount(0)
  await expect(page.locator('.cm-content')).toContainText('module top')

  const secondFileChooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Load files from computer' }).click()
  const secondFileChooser = await secondFileChooserPromise
  await secondFileChooser.setFiles([
    { name: 'design.sv', mimeType: 'text/plain', buffer: Buffer.from(design) },
    { name: 'file1.sv', mimeType: 'text/plain', buffer: Buffer.from(helper) },
  ])
  await page.getByTitle('Add file').click()
  await replacement.getByRole('button', { name: 'Replace', exact: true }).click()
  await expect(replacement).toContainText('Replace 2 existing files?')
  await expect(page.locator('.cm-content')).not.toContainText('imported_helper')
  await replacement.getByRole('button', { name: 'Replace', exact: true }).click()
  await expect(page.getByRole('tab', { name: /^design\.sv/ })).toBeVisible()
  await expect(page.getByRole('tab', { name: /^file1\.sv/ })).toBeVisible()
  await expect(page.locator('.cm-content')).toContainText('imported_top')

  await page.getByRole('tab', { name: /^file1\.sv/ }).click()
  await expect(page.locator('.cm-content')).toContainText('imported_helper')

  const editedHelper = 'module edited_helper; wire saved = 1\'b1; endmodule'
  const editor = page.locator('.cm-content')
  await editor.click()
  await editor.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await editor.fill(editedHelper)

  await page.getByRole('button', { name: 'Save file1.sv to computer' }).click()
  await expect
    .poll(() => page.evaluate(() => window.savedComputerFiles))
    .toContainEqual({ scope: 'file', name: 'file1.sv', content: editedHelper })

  await page.getByRole('button', { name: 'Save all files to computer' }).click()
  await expect
    .poll(() => page.evaluate(() => window.savedComputerFiles))
    .toEqual(
      expect.arrayContaining([
        { scope: 'directory', name: 'design.sv', content: design },
        { scope: 'directory', name: 'file1.sv', content: editedHelper },
      ]),
    )
})

test('synthesizes a design that includes an imported SystemVerilog header', async ({
  page,
}) => {
  const design = `\`include "defs.svh"
module included_header_top(output logic [\`WIDTH-1:0] value);
  assign value = \`VALUE;
endmodule`
  const header = `\`define WIDTH 4
\`define VALUE 4'ha`

  await page.locator('input[type="file"]').setInputFiles([
    { name: 'design.sv', mimeType: 'text/plain', buffer: Buffer.from(design) },
    { name: 'defs.svh', mimeType: 'text/plain', buffer: Buffer.from(header) },
  ])
  await page
    .getByRole('dialog', { name: 'Replace existing files?' })
    .getByRole('button', { name: 'Replace', exact: true })
    .click()

  await expect(page.getByRole('tab', { name: /^defs\.svh/ })).toBeVisible()
  await waitForAnalysisReady(page)
  await expect(page.getByText('Synthesis failed')).toHaveCount(0)

  await page.getByRole('tab', { name: /^defs\.svh/ }).click()
  await page.getByRole('button', { name: 'Save defs.svh to computer' }).click()
  await expect
    .poll(() => page.evaluate(() => window.savedComputerFiles))
    .toContainEqual({ scope: 'file', name: 'defs.svh', content: header })

  await page.waitForTimeout(350)
  await page.reload()
  await expect(page.getByRole('tab', { name: /^defs\.svh/ })).toBeVisible()
  await expect(page.locator('.cm-content')).toContainText('`define WIDTH 4')
  await waitForAnalysisReady(page)
})

test('downloads files when native save pickers are unavailable', async ({
  page,
}) => {
  await page.evaluate(() => {
    Reflect.deleteProperty(window, 'showSaveFilePicker')
    Reflect.deleteProperty(window, 'showDirectoryPicker')
  })

  const source = 'module downloaded; endmodule'
  await page.locator('input[type="file"]').setInputFiles({
    name: 'downloaded.sv',
    mimeType: 'text/plain',
    buffer: Buffer.from(source),
  })

  const downloadPromise = page.waitForEvent('download')
  await page
    .getByRole('button', { name: 'Save downloaded.sv to computer' })
    .click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('downloaded.sv')
  const path = await download.path()
  expect(path).not.toBeNull()
  expect(await readFile(path!, 'utf8')).toBe(source)

  const downloads = new Map<string, string>()
  page.on('download', async (item) => {
    const itemPath = await item.path()
    if (itemPath) {
      downloads.set(
        item.suggestedFilename(),
        await readFile(itemPath, 'utf8'),
      )
    }
  })
  await page.getByRole('button', { name: 'Save all files to computer' }).click()
  await expect.poll(() => downloads.size).toBe(2)
  expect(downloads.get('downloaded.sv')).toBe(source)
  expect(downloads.get('design.sv')).toContain('module top')
})
