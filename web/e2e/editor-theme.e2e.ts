import { expect, test, type Locator } from '@playwright/test'

async function computedColor(locator: Locator, cssVariable: string) {
  return locator.evaluate((element, variable) => {
    const probe = document.createElement('span')
    probe.style.color = `var(${variable})`
    document.body.append(probe)
    const result = {
      actual: getComputedStyle(element).color,
      expected: getComputedStyle(probe).color,
    }
    probe.remove()
    return result
  }, cssVariable)
}

async function computedBackground(locator: Locator, cssVariable: string) {
  return locator.evaluate((element, variable) => {
    const probe = document.createElement('span')
    probe.style.backgroundColor = `var(${variable})`
    document.body.append(probe)
    const result = {
      actual: getComputedStyle(element).backgroundColor,
      expected: getComputedStyle(probe).backgroundColor,
    }
    probe.remove()
    return result
  }, cssVariable)
}

test('keeps editor chrome and syntax on the selected color theme', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('se-palette', 'tidepool')
    localStorage.setItem('se-mode', 'dark')
  })
  await page.goto('/')

  const root = page.locator('html')
  const editor = page.locator('.cm-editor')
  const keyword = page.locator('.cm-line span', { hasText: 'module' }).first()

  await expect(root).toHaveAttribute('data-palette', 'tidepool')
  await expect(editor).toBeVisible()
  await expect(keyword).toBeVisible()
  const tidepoolChrome = await computedBackground(editor, '--bg')
  const tidepoolKeyword = await computedColor(keyword, '--seq')
  expect(tidepoolChrome.actual).toBe(tidepoolChrome.expected)
  expect(tidepoolKeyword.actual).toBe(tidepoolKeyword.expected)

  await page.getByRole('button', { name: 'Theme settings' }).click()
  await page.getByRole('radio', { name: /Gruvbox/ }).click()
  await expect(root).toHaveAttribute('data-palette', 'gruvbox')

  const gruvboxChrome = await computedBackground(editor, '--bg')
  const gruvboxKeyword = await computedColor(keyword, '--seq')
  expect(gruvboxChrome.actual).toBe(gruvboxChrome.expected)
  expect(gruvboxKeyword.actual).toBe(gruvboxKeyword.expected)
  expect(gruvboxChrome.actual).not.toBe(tidepoolChrome.actual)
  expect(gruvboxKeyword.actual).not.toBe(tidepoolKeyword.actual)
})
