import { expect, test } from '@playwright/test'

test('file tabs expose roving keyboard navigation', async ({ page }) => {
  await page.goto('/')
  await page.getByTitle('Add file').click()
  await page.getByTitle('Add file').click()

  const designTab = page.getByRole('tab', { name: /design\.sv/ })
  const file1Tab = page.getByRole('tab', { name: /file1\.sv/ })
  const file2Tab = page.getByRole('tab', { name: /file2\.sv/ })
  await expect(file2Tab).toHaveAttribute('aria-selected', 'true')
  await file2Tab.focus()
  await file2Tab.press('Home')
  await expect(designTab).toBeFocused()
  await expect(designTab).toHaveAttribute('aria-selected', 'true')
  await designTab.press('End')
  await expect(file2Tab).toBeFocused()
  await file2Tab.press('ArrowLeft')
  await expect(file1Tab).toBeFocused()
  await expect(file1Tab).toHaveAttribute('aria-selected', 'true')
})

test('renames and deletes source files with in-page menus', async ({ page }) => {
  const browserDialogs: string[] = []
  page.on('dialog', async (dialog) => {
    browserDialogs.push(dialog.type())
    await dialog.dismiss()
  })
  await page.goto('/')
  await page.getByTitle('Add file').click()

  const fileTab = page.getByRole('tab', { name: /file1\.sv/ })
  await fileTab.dblclick()
  const renameMenu = page.getByRole('dialog', { name: 'Rename file1.sv' })
  await expect(renameMenu).toBeVisible()
  await renameMenu.getByLabel('Rename file1.sv').fill('control.sv')
  await renameMenu.getByRole('button', { name: 'Rename', exact: true }).click()

  const renamedTab = page.getByRole('tab', { name: /control\.sv/ })
  await expect(renamedTab).toBeVisible()
  await renamedTab.focus()
  await renamedTab.press('Delete')
  const deleteMenu = page.getByRole('dialog', { name: 'Delete control.sv' })
  await expect(deleteMenu).toBeVisible()
  await deleteMenu.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(renamedTab).toHaveCount(0)
  expect(browserDialogs).toEqual([])
})

