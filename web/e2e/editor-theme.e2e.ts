import { expect, test, type Locator } from '@playwright/test'
import { waitForAnalysisReady } from './helpers'

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

test('keeps light-mode schematic gates and wires distinct from the canvas', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('se-palette', 'tidepool')
    localStorage.setItem('se-mode', 'light')
  })
  await page.goto('/')
  await page.getByLabel('Bundled example').selectOption('round_robin_arbiter')
  await waitForAnalysisReady(page)
  await page.getByRole('tab', { name: 'Schematic', exact: true }).click()

  const gate = page.locator(
    '.g-node-body:is(.g-symbol-and, .g-symbol-nand, .g-symbol-or, .g-symbol-nor, .g-symbol-xor, .g-symbol-xnor, .g-symbol-not, .g-symbol-mux) .g-symbol-outline',
  ).first()
  const wire = page.locator('.g-edge:not(.control):not(.hl)').first()
  await expect(gate).toBeVisible()
  await expect(wire).toBeVisible()

  const contrast = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const context = canvas.getContext('2d')
    const stage = document.querySelector('.graph-stage')
    const gateOutline = document.querySelector(
      '.g-node-body:is(.g-symbol-and, .g-symbol-nand, .g-symbol-or, .g-symbol-nor, .g-symbol-xor, .g-symbol-xnor, .g-symbol-not, .g-symbol-mux) .g-symbol-outline',
    )
    const edge = document.querySelector('.g-edge:not(.control):not(.hl)')
    if (!context || !stage || !gateOutline || !edge) {
      throw new Error('schematic contrast fixtures are missing')
    }

    const rgb = (color: string) => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)]
    }
    const luminance = (color: string) => {
      const [red, green, blue] = rgb(color).map((channel) => {
        const value = channel / 255
        return value <= 0.04045
          ? value / 12.92
          : ((value + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * red + 0.7152 * green + 0.0722 * blue
    }
    const ratio = (foreground: string, background: string) => {
      const foregroundLuminance = luminance(foreground)
      const backgroundLuminance = luminance(background)
      return (
        (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
        (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
      )
    }

    const canvasColor = getComputedStyle(stage).backgroundColor
    return {
      gate: ratio(getComputedStyle(gateOutline).stroke, canvasColor),
      wire: ratio(getComputedStyle(edge).stroke, canvasColor),
    }
  })

  expect(contrast.gate).toBeGreaterThanOrEqual(3)
  expect(contrast.wire).toBeGreaterThanOrEqual(3)
})

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

  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('radio', { name: /Gruvbox/ }).click()
  await expect(root).toHaveAttribute('data-palette', 'gruvbox')

  const gruvboxChrome = await computedBackground(editor, '--bg')
  const gruvboxKeyword = await computedColor(keyword, '--seq')
  expect(gruvboxChrome.actual).toBe(gruvboxChrome.expected)
  expect(gruvboxKeyword.actual).toBe(gruvboxKeyword.expected)
  expect(gruvboxChrome.actual).not.toBe(tidepoolChrome.actual)
  expect(gruvboxKeyword.actual).not.toBe(tidepoolKeyword.actual)

  await page.getByRole('radio', { name: 'Light', exact: true }).click()
  await expect(root).toHaveAttribute('data-theme', 'light')

  const lightChrome = await computedBackground(editor, '--bg')
  const lightKeyword = await computedColor(keyword, '--seq')
  expect(lightChrome.actual).toBe(lightChrome.expected)
  expect(lightKeyword.actual).toBe(lightKeyword.expected)
  expect(lightChrome.actual).not.toBe(gruvboxChrome.actual)
  expect(lightKeyword.actual).not.toBe(gruvboxKeyword.actual)
})
