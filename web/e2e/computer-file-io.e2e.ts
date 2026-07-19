import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

declare global {
  interface Window {
    savedComputerFiles: Array<{ scope: 'file' | 'directory'; name: string; content: string }>
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.savedComputerFiles = []

    const writable = (scope: 'file' | 'directory', name: string) => ({
      async write(content: string) {
        window.savedComputerFiles.push({ scope, name, content })
      },
      async close() {},
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
        async getFileHandle(name: string) {
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
  await page.locator('input[type="file"]').setInputFiles([
    { name: 'design.sv', mimeType: 'text/plain', buffer: Buffer.from(design) },
    { name: 'helper.v', mimeType: 'text/plain', buffer: Buffer.from(helper) },
  ])

  await expect(page.getByRole('tab', { name: /^design\.sv/ })).toBeVisible()
  await expect(page.getByRole('tab', { name: /^helper\.v/ })).toBeVisible()
  await expect(page.locator('.cm-content')).toContainText('imported_top')

  await page.getByRole('button', { name: 'Save design.sv to computer' }).click()
  await expect
    .poll(() => page.evaluate(() => window.savedComputerFiles))
    .toContainEqual({ scope: 'file', name: 'design.sv', content: design })

  await page.getByRole('button', { name: 'Save all files to computer' }).click()
  await expect
    .poll(() => page.evaluate(() => window.savedComputerFiles))
    .toEqual(
      expect.arrayContaining([
        { scope: 'directory', name: 'design.sv', content: design },
        { scope: 'directory', name: 'helper.v', content: helper },
      ]),
    )
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
})
