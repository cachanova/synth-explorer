import { expect, test, type Page } from '@playwright/test'
import {
  recordApiRequests,
  waitForAutomaticSynthesis,
  zoomSchematicToScale,
} from './helpers'

async function setInferredFifoDepth(page: Page, depth: 16 | 64 | 128 | 512) {
  const editor = page.locator('.cm-content')
  await expect(editor).toContainText('parameter int unsigned DEPTH = 16')
  if (depth === 16) return
  await editor.click()
  await editor.press('Control+Home')
  await editor.press('ArrowDown')
  await editor.press('ArrowDown')
  await editor.press('End')
  await editor.press('ArrowLeft')
  await editor.press('Backspace')
  await editor.press('Backspace')
  await editor.pressSequentially(String(depth))
}

test('stacks mapped primitives from one inferred memory when memories are grouped', async ({ page }) => {
  const apiRequests = recordApiRequests(page)
  await page.goto('/')
  await waitForAutomaticSynthesis(page, async () => {
    await page.getByLabel('Bundled example').selectOption('inferred_fifo')
    await setInferredFifoDepth(page, 128)
    await page.getByLabel('Platform').selectOption('xilinx')
  })

  await page.getByRole('tab', { name: 'Schematic', exact: true }).click()
  const groupedMemory = page.locator(
    '.g-node-body.g-symbol-memory[data-member-count]',
  )
  await expect(groupedMemory).toHaveCount(1)
  await expect(groupedMemory).toHaveAttribute(
    'data-node-tooltip',
    'RAM64M — memory [128×16]',
  )
  const groupedReadRegister = page.locator(
    '.g-node-body.g-symbol-reg[data-member-count="7"][data-node-tooltip*="rdreg[0].q"]',
  )
  await expect(groupedReadRegister).toHaveCount(1)
  const groupedCount = page.locator(
    '.g-node-body.g-symbol-port-out[data-member-count="8"][data-node-tooltip="count[7:0]"]',
  )
  await expect(groupedCount).toHaveCount(1)
  const memberCount = Number(await groupedMemory.getAttribute('data-member-count'))
  expect(memberCount).toBeGreaterThan(1)
  const groupedId = await groupedMemory.getAttribute('data-graph-node-id')
  expect(groupedId).not.toBeNull()
  await expect(groupedMemory).toHaveAttribute('role', 'button')

  const countGroupId = await groupedCount.getAttribute('data-graph-node-id')
  expect(countGroupId).not.toBeNull()
  await expect(page.locator(
    `[data-group-action="expand"][data-group-id="${countGroupId}"]`,
  )).toHaveCount(0)
  const registerGroupId = await groupedReadRegister.getAttribute('data-graph-node-id')
  expect(registerGroupId).not.toBeNull()
  const viewport = page.locator('.g-viewport')
  const groupedRegisterTransform = await groupedReadRegister.getAttribute('transform')
  await groupedReadRegister.hover()
  await page.locator(
    `[data-group-action="expand"][data-group-id="${registerGroupId}"]`,
  ).click()
  const registerMembers = page.locator(
    `[data-expanded-group-member="${registerGroupId}"]`,
  )
  await expect(registerMembers).toHaveCount(7)
  await expect(page.locator('.g-expanded-group-boundary')).toHaveCount(1)
  const collapseRegisters = page.locator(
    `[data-group-action="collapse"][data-group-id="${registerGroupId}"]`,
  )
  await expect(collapseRegisters).toHaveCount(1)
  await registerMembers.first().hover()
  await collapseRegisters.first().click()
  await expect(groupedReadRegister).toHaveCount(1)
  await expect(groupedReadRegister).toHaveAttribute(
    'transform',
    groupedRegisterTransform ?? '',
  )

  await zoomSchematicToScale(page, 0.5, groupedMemory)
  await expect.poll(() => viewport.getAttribute('data-detail-level')).toBe('compact')
  const compactDetails = page.locator(`[data-node-detail-id="${groupedId}"]`)
  await expect(compactDetails.locator('.g-node-label')).toHaveText('RAM64M')
  await expect(compactDetails.locator('.g-node-label')).toBeVisible()
  await expect(compactDetails.locator('.g-node-name.g-memory-group-detail')).toHaveText(
    'memory [128×16]',
  )
  await expect(compactDetails.locator('.g-node-name.g-memory-group-detail')).toBeVisible()
  await expect(compactDetails.locator('.g-group-badge.g-memory-group-detail')).toHaveText(
    `×${memberCount}`,
  )
  await expect(compactDetails.locator('.g-group-badge.g-memory-group-detail')).toBeVisible()
  await expect(page.locator(
    `[data-graph-node-id="${groupedId}"] .g-node-label:visible, `
      + `[data-node-detail-id="${groupedId}"] .g-node-label:visible`,
  )).toHaveCount(1)

  await zoomSchematicToScale(page, 0.3)
  await expect.poll(() => viewport.getAttribute('data-detail-level')).toBe('overview')
  await expect(compactDetails).toHaveCount(0)
  const overviewDetails = groupedMemory.locator('.g-memory-overview-details')
  await expect(overviewDetails.locator('.g-node-label')).toHaveText('RAM64M')
  await expect(overviewDetails.locator('.g-node-label')).toBeVisible()
  await expect(overviewDetails.locator('.g-node-name')).toHaveText('memory [128×16]')
  await expect(overviewDetails.locator('.g-node-name')).toBeVisible()
  await expect(overviewDetails.locator('.g-group-badge')).toHaveText(`×${memberCount}`)
  await expect(overviewDetails.locator('.g-group-badge')).toBeVisible()

  const schematic = page.locator('.graph-stage svg')
  const visibleGroupedLabels = page.locator(
    `[data-graph-node-id="${groupedId}"] .g-node-label:visible, `
      + `[data-node-detail-id="${groupedId}"] .g-node-label:visible`,
  )
  await groupedMemory.focus()
  await expect(overviewDetails).not.toBeVisible()
  await expect(visibleGroupedLabels).toHaveCount(1)
  await groupedMemory.press('Enter')
  await schematic.focus()
  await expect(groupedMemory).toHaveClass(/selected/)
  await expect(overviewDetails).not.toBeVisible()
  await expect(visibleGroupedLabels).toHaveCount(1)
  await schematic.dispatchEvent('click')
  await expect(groupedMemory).not.toHaveClass(/selected/)
  await expect(overviewDetails).toBeVisible()

  await zoomSchematicToScale(page, 0.85)
  await expect.poll(() => viewport.getAttribute('data-detail-level')).toBe('full')
  await groupedMemory.focus()
  await groupedMemory.press('Enter')
  await expect(
    page.locator(`[data-node-detail-id="${groupedId}"] .g-group-badge`),
  ).toHaveText(`×${memberCount}`)
  await expect(
    page.locator(`[data-node-stack-id="${groupedId}"] .g-symbol-stack`),
  ).toHaveCount(memberCount >= 4 ? 2 : 1)

  await page.getByLabel('group memories').uncheck()
  await expect(page.locator(`[data-node-detail-id="${groupedId}"]`)).toHaveCount(0)
  await expect(page.locator('.node-card')).toHaveCount(0)
  await expect(page.locator('.g-node-body.g-symbol-memory')).toHaveCount(memberCount)
  await expect(
    page.locator('.g-node-body.g-symbol-memory[data-member-count]'),
  ).toHaveCount(0)
  await page.getByLabel('group memories').check()
  await expect(groupedMemory).toHaveCount(1)
  await groupedMemory.focus()
  await groupedMemory.press('Enter')

  await page.getByRole('button', { name: 'Fanin cone' }).click()
  await page.getByLabel('Focus').check()
  await expect(page.locator('.graph-banner .msg.err')).toHaveCount(0)

  await page.getByLabel('group memories').uncheck()
  await expect(page.locator('.g-node-body.g-symbol-memory')).toHaveCount(memberCount)
  await expect(
    page.locator('.g-node-body.g-symbol-memory[data-member-count]'),
  ).toHaveCount(0)
  await expect(page.locator('.graph-banner .msg.err')).toHaveCount(0)

  await page.getByLabel('group memories').check()
  await expect(groupedMemory).toHaveCount(1)
  expect(apiRequests).toEqual([])
})

test('stacks parallel SRL lanes through Yosys per-lane logic', async ({ page }) => {
  const apiRequests = recordApiRequests(page)
  await page.goto('/')
  await waitForAutomaticSynthesis(page, async () => {
    await page.getByLabel('Bundled example').selectOption('srl_pipe')
    const editor = page.locator('.cm-content')
    await expect(editor).toContainText('shift_data[0] <= data_in;')
    const source = (await editor.locator('.cm-line').allTextContents()).join('\n')
    await editor.click()
    await editor.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await editor.fill(source.replace(
      'shift_data[0] <= data_in;',
      'shift_data[0] <= ~data_in;',
    ))
    await page.getByLabel('Platform').selectOption('xilinx')
  })

  await page.getByRole('tab', { name: 'Schematic', exact: true }).click()
  const groupedSrl = page.locator(
    '.g-node-body.g-symbol-memory[data-node-tooltip="SRL16E — data_out [16×8]"]',
  )
  await expect(groupedSrl).toHaveCount(1)
  await expect(groupedSrl).toHaveAttribute('data-member-count', '8')
  const groupedId = await groupedSrl.getAttribute('data-graph-node-id')
  expect(groupedId).not.toBeNull()
  await groupedSrl.focus()
  await groupedSrl.press('Enter')
  await expect(
    page.locator(`[data-node-detail-id="${groupedId}"] .g-group-badge`),
  ).toHaveText('×8')

  await page.getByLabel('group memories').uncheck()
  await expect(groupedSrl).toHaveCount(0)
  await expect(
    page.locator('.g-node-body.g-symbol-memory[data-node-tooltip^="SRL16E"]'),
  ).toHaveCount(8)

  await page.getByLabel('group memories').check()
  await expect(groupedSrl).toHaveCount(1)
  expect(apiRequests).toEqual([])
})

for (const regression of [
  { platform: 'ice40', primitive: 'SB_RAM40_4K', depth: 16, count: 1 },
  { platform: 'ice40', primitive: 'SB_RAM40_4K', depth: 512, count: 2 },
  { platform: 'ecp5', primitive: 'TRELLIS_DPR16X4', depth: 16, count: 4 },
  { platform: 'ecp5', primitive: 'DP16KD', depth: 512, count: 1 },
] as const) {
  test(`stacks ${regression.platform} inferred FIFO memory at depth ${regression.depth}`, async ({ page }) => {
    test.setTimeout(240_000)
    if (
      regression.depth === 16 &&
      (regression.platform === 'ice40' || regression.platform === 'ecp5')
    ) {
      await page.addInitScript(() => {
        const requests: unknown[] = []
        const originalPostMessage = Worker.prototype.postMessage
        Object.defineProperty(Worker.prototype, 'postMessage', {
          configurable: true,
          value: function (...args: unknown[]) {
            requests.push(args[0])
            return Reflect.apply(originalPostMessage, this, args)
          },
        })
        ;(window as typeof window & { __groupWorkerRequests?: unknown[] })
          .__groupWorkerRequests = requests
      })
    }
    const apiRequests = recordApiRequests(page)
    await page.goto('/')
    await waitForAutomaticSynthesis(page, async () => {
      await page.getByLabel('Bundled example').selectOption('inferred_fifo')
      await setInferredFifoDepth(page, regression.depth)
      await page.getByLabel('Platform').selectOption(regression.platform)
    })

    await page.getByRole('tab', { name: 'Schematic', exact: true }).click()
    const groupedMemory = page.locator(
      `.g-node-body.g-symbol-memory[data-node-tooltip="${regression.primitive} — memory [${regression.depth}×16]"]`,
    )
    await expect(groupedMemory).toHaveCount(1)
    await expect(groupedMemory).toHaveAttribute(
      'data-member-count',
      String(regression.count),
    )
    const groupedId = await groupedMemory.getAttribute('data-graph-node-id')
    expect(groupedId).not.toBeNull()
    await groupedMemory.focus()
    await groupedMemory.press('Enter')
    const badge = page.locator(`[data-node-detail-id="${groupedId}"] .g-group-badge`)
    if (regression.count === 1) {
      await expect(badge).toHaveCount(0)
    } else {
      await expect(badge).toHaveText(`×${regression.count}`)
    }

    if (regression.platform === 'ice40') {
      if (regression.depth < 512) {
        await expect(page.locator(
          '.g-node-body.g-symbol-reg[data-member-count="16"][data-node-tooltip*=".WDATA[15:0]"]',
        )).toHaveCount(1)
      } else {
        await expect(page.locator(
          '.g-node-body.g-symbol-reg[data-member-count="8"][data-node-tooltip*=".WDATA ×8"]',
        )).toHaveCount(2)
      }
    } else {
      await expect(page.locator(
        '.g-node-body.g-symbol-box[data-node-tooltip^="TRELLIS_DPR16X4"]',
      )).toHaveCount(0)
    }

    if (
      regression.depth === 16 &&
      (regression.platform === 'ice40' || regression.platform === 'ecp5')
    ) {
      const stationaryPort = page.locator(
        '.g-node-body[data-node-tooltip="push_ready"]',
      )
      await expect(stationaryPort).toHaveCount(1)
      await page.getByRole('button', {
        name: `Expand group memory [${regression.depth}×16]`,
      }).click()
      await expect.poll(() => page.evaluate(() =>
        ((window as typeof window & { __groupWorkerRequests?: Array<{ method?: string }> })
          .__groupWorkerRequests ?? [])
          .filter((request) => request.method === 'expandGroup').length,
      )).toBe(1)
      await expect(groupedMemory).toHaveCount(0)
      await expect(page.locator(
        `.g-node-body[data-node-tooltip^="${regression.primitive}"]`,
      )).toHaveCount(regression.count)
      await expect(page.locator('.g-expanded-group-boundary')).toHaveCount(1)
      const collapseButtons = page.getByRole('button', {
        name: `Collapse group memory [${regression.depth}×16]`,
      })
      await expect(collapseButtons).toHaveCount(1)

      await stationaryPort.focus()
      await stationaryPort.press('Enter')
      await page.getByRole('button', { name: 'Fanin cone' }).click()
      await expect(page.locator('.g-expanded-group-boundary')).toHaveCount(0)
      await expect(page.locator(
        `[data-expanded-group-member="${groupedId}"]`,
      )).toHaveCount(0)
      await page.getByLabel('Focus').uncheck()
      await expect(page.locator('.g-expanded-group-boundary')).toHaveCount(1)
      await expect(page.locator(
        `[data-expanded-group-member="${groupedId}"]`,
      )).toHaveCount(regression.count)

      await page.locator(
        `.g-node-body[data-node-tooltip^="${regression.primitive}"]`,
      ).first().hover()
      await collapseButtons.first().click()
      await expect(groupedMemory).toHaveCount(1)
    }
    expect(apiRequests).toEqual([])
  })
}

test('stacks DFF-mapped rows from one inferred memory in generic gates', async ({ page }) => {
  test.setTimeout(360_000)
  const apiRequests = recordApiRequests(page)
  await page.goto('/')
  await waitForAutomaticSynthesis(page, async () => {
    await page.getByLabel('Bundled example').selectOption('inferred_fifo')
    await setInferredFifoDepth(page, 128)
    await page.getByLabel('Platform').selectOption('gates')
  })

  await page.getByRole('tab', { name: 'Schematic', exact: true }).click()
  const groupedMemory = page.locator(
    '.g-node-body.g-symbol-memory[data-member-count]',
  )
  await expect(groupedMemory).toHaveCount(1)
  await expect(groupedMemory).toHaveAttribute(
    'data-node-tooltip',
    'MEM — memory [128×16]',
  )
  await expect(groupedMemory).toHaveAttribute('data-member-count', '2048')
  const groupedId = await groupedMemory.getAttribute('data-graph-node-id')
  expect(groupedId).not.toBeNull()
  await expect(groupedMemory).toHaveAttribute('role', 'button')
  await groupedMemory.focus()
  await groupedMemory.press('Enter')
  await expect(
    page.locator(`[data-node-detail-id="${groupedId}"] .g-group-badge`),
  ).toHaveText('×2048')
  const groupedDetails = page.locator(`[data-node-detail-id="${groupedId}"]`)
  await expect(groupedDetails.locator('.g-control-label')).toHaveCount(1)
  await expect(groupedDetails.locator('.g-control-label')).toContainText('CLK')
  await expect(
    groupedDetails.locator('.g-control-label', { hasText: /EN/ }),
  ).toHaveCount(0)
  expect(await groupedDetails.evaluate((node) => (node as SVGGElement).getBBox().height))
    .toBeLessThan(150)

  const expandMemory = page.getByRole('button', {
    name: 'Expand group memory [128×16]',
  })
  await expandMemory.focus()
  await expandMemory.press('Enter')
  await expect(groupedMemory).toHaveCount(0, { timeout: 180_000 })
  const expandedMembers = page.locator(`[data-expanded-group-member="${groupedId}"]`)
  await expect(expandedMembers).toHaveCount(2048, { timeout: 180_000 })
  await expect(page.locator('.g-expanded-group-boundary')).toHaveCount(1)
  const collapseMemory = page.getByRole('button', {
    name: 'Collapse group memory [128×16]',
  })
  await expect(collapseMemory).toHaveCount(1)
  await collapseMemory.first().focus()
  await collapseMemory.first().press('Enter')
  await expect(groupedMemory).toHaveCount(1)
  await expect(page.locator('.g-expanded-group-boundary')).toHaveCount(0)

  await groupedMemory.focus()
  await groupedMemory.press('Enter')
  await page.getByRole('button', { name: 'Fanin cone' }).click()
  await page.getByLabel('Focus').check()
  await expect.poll(() => page.locator('.g-node-body').count()).toBeGreaterThan(1)
  await expect(page.locator('.graph-banner .msg.err')).toHaveCount(0)

  const maxNodes = page.getByTitle('Max nodes to request')
  for (const expected of ['300', '200', '100', '50']) {
    await maxNodes.locator('button').first().click()
    await expect(maxNodes.locator('.val')).toHaveText(expected)
  }
  await page.getByLabel('group memories').uncheck()
  await expect(page.locator('.g-node-body.g-symbol-memory[data-member-count]')).toHaveCount(0)
  await expect.poll(() => page.locator('.g-node-body').count()).toBeGreaterThan(1)
  await expect.poll(() => page.locator('.g-node-body').count()).toBeLessThanOrEqual(50)
  await expect(page.locator('.graph-banner .msg', { hasText: /^truncated/ })).toBeVisible()
  await expect(page.locator('.graph-banner .msg.err')).toHaveCount(0)
  await page.getByRole('button', { name: 'Fit schematic to view' }).click()
  await expect.poll(() => page.locator('.graph-stage').evaluate((stage) => {
    const stageRect = stage.getBoundingClientRect()
    const wrapper = stage.parentElement
    const bannerRect = wrapper
      ?.querySelector<HTMLElement>('.graph-banner')
      ?.getBoundingClientRect()
    const cardRect = wrapper
      ?.querySelector<HTMLElement>('.node-card')
      ?.getBoundingClientRect()
    const shortcutRect = stage
      .querySelector<HTMLElement>('.graph-shortcuts')
      ?.getBoundingClientRect()
    const zoomRect = stage
      .querySelector<HTMLElement>('.zoom-controls')
      ?.getBoundingClientRect()
    const safeTop = bannerRect && bannerRect.height > 0
      ? bannerRect.bottom + 10
      : stageRect.top
    const safeRight = cardRect && cardRect.width > 0
      ? cardRect.left - 10
      : stageRect.right
    const safeBottom = Math.min(
      shortcutRect?.top ?? stageRect.bottom,
      zoomRect?.top ?? stageRect.bottom,
    ) - 10
    return [...stage.querySelectorAll<SVGGraphicsElement>('.g-node-body')].every((node) => {
      const rect = node.getBoundingClientRect()
      return rect.left >= stageRect.left - 1 &&
        rect.right <= safeRight + 1 &&
        rect.top >= safeTop - 1 &&
        rect.bottom <= safeBottom + 1
    })
  })).toBe(true)

  await page.getByLabel('group memories').check()
  await expect(groupedMemory).toHaveCount(1)
  await expect(groupedMemory).toHaveAttribute('data-member-count', '2048')
  expect(apiRequests).toEqual([])
})

