import { expect, test, type Locator } from '@playwright/test'
import {
  recordApiRequests,
  recordedAnalysisStates,
  startAnalysisStateRecording,
  stopAnalysisStateRecording,
  waitForAnalysisReady,
  waitForAutomaticSynthesis,
  zoomSchematicToScale,
} from './helpers'

test('renders and resizes the browser-produced graph without resetting user zoom', async ({ page }) => {
  await page.addInitScript(() => {
    const workerURLs: string[] = []
    const elkRequests: unknown[] = []
    const NativeWorker = Worker
    const InstrumentedWorker = new Proxy(NativeWorker, {
      construct(target, args, newTarget) {
        const url = String(args[0])
        workerURLs.push(url)
        const worker = Reflect.construct(target, args, newTarget)
        if (url.includes('elk.worker')) {
          const nativePostMessage = worker.postMessage.bind(worker)
          worker.postMessage = (...postArgs: Parameters<Worker['postMessage']>) => {
            elkRequests.push(postArgs[0])
            nativePostMessage(...postArgs)
          }
        }
        return worker
      },
    })
    Object.defineProperty(window, 'Worker', {
      configurable: true,
      value: InstrumentedWorker,
    })
    Object.assign(window, { __workerURLs: workerURLs, __elkRequests: elkRequests })
  })
  await page.setViewportSize({ width: 1280, height: 720 })
  const apiRequests = recordApiRequests(page)
  await page.goto('/')
  // Keep the graph mounted but inactive so this test distinguishes mount-time
  // prewarm from the first real Schematic layout.
  await page.getByRole('tab', { name: 'Overview', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as typeof window & { __workerURLs?: string[] }).__workerURLs?.filter(
            (url) => url.includes('elk.worker'),
          ).length ?? 0,
      ),
    )
    .toBe(1)
  expect(
    await page.evaluate(
      () => (window as typeof window & { __elkRequests?: unknown[] }).__elkRequests ?? [],
    ),
  ).toEqual([])
  await waitForAutomaticSynthesis(page, async () => {
    await page.getByLabel('Bundled example').selectOption('reg_mux')
  })
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as typeof window & { __workerURLs?: string[] }).__workerURLs?.filter(
            (url) => url.includes('elk.worker'),
          ).length ?? 0,
      ),
    )
    .toBe(1)
  expect(
    await page.evaluate(
      () => (window as typeof window & { __elkRequests?: unknown[] }).__elkRequests ?? [],
    ),
  ).toEqual([])
  await page.getByRole('tab', { name: 'Schematic', exact: true }).click()

  const stage = page.locator('.graph-stage')
  const svg = stage.locator('svg')
  const viewport = svg.locator(':scope > g').first()
  await expect(svg).toBeVisible()
  await expect(page.locator('.g-node-body').first()).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(() => {
        const requests =
          (window as typeof window & { __elkRequests?: unknown[] }).__elkRequests ?? []
        const latest = requests.at(-1) as
          | { input?: { nodes?: unknown[]; edges?: unknown[] } }
          | undefined
        if (!latest?.input?.nodes || !latest.input.edges) return null
        return { nodes: latest.input.nodes.length, edges: latest.input.edges.length }
      }),
    )
    .not.toBeNull()
  const exactCounts = await page.evaluate(() => {
    const requests =
      (window as typeof window & { __elkRequests?: unknown[] }).__elkRequests ?? []
    const latest = requests.at(-1) as {
      input: { nodes: unknown[]; edges: unknown[] }
    }
    return { nodes: latest.input.nodes.length, edges: latest.input.edges.length }
  })
  await expect(page.locator('.g-node-body')).toHaveCount(exactCounts.nodes)
  await expect
    .poll(() =>
      page.locator('.g-edge').evaluateAll((paths) =>
        paths.reduce((count, path) => count + Number(path.getAttribute('data-edge-count')), 0),
      ),
    )
    .toBe(exactCounts.edges)
  await expect
    .poll(() =>
      page.locator('.g-edge-arrows').evaluateAll((paths) =>
        paths.reduce((count, path) => count + Number(path.getAttribute('data-arrow-count')), 0),
      ),
    )
    .toBe(exactCounts.edges)

  const initialLayoutRequests = await page.evaluate(
    () => (window as typeof window & { __elkRequests?: unknown[] }).__elkRequests?.length ?? 0,
  )
  await page.getByLabel('group vectors').uncheck()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as typeof window & { __elkRequests?: unknown[] }).__elkRequests?.length ?? 0,
      ),
    )
    .toBe(initialLayoutRequests + 1)
  await expect(page.locator('.g-node-body')).not.toHaveCount(exactCounts.nodes)
  const ungroupedLayoutRequests = initialLayoutRequests + 1

  await page.getByLabel('group vectors').check()
  await expect(page.locator('.g-node-body')).toHaveCount(exactCounts.nodes)
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as typeof window & { __elkRequests?: unknown[] }).__elkRequests?.length ?? 0,
      ),
    )
    .toBe(ungroupedLayoutRequests)
  await expect(page.locator('.g-edge-wrap')).toHaveCount(0)
  const accessibility = await page.context().newCDPSession(page)
  const { nodes: accessibilityNodes } = await accessibility.send(
    'Accessibility.getFullAXTree',
  )
  expect(
    accessibilityNodes
      .filter((node) => node.role?.value === 'image')
      .map((node) => node.name?.value)
      .filter((name) => typeof name === 'string' && name.includes('schematic connection')),
  ).toEqual([
    `${exactCounts.edges} schematic connections. Inspect nodes for accessible fanin and fanout details.`,
  ])
  expect(
    accessibilityNodes.filter(
      (node) =>
        node.role?.value === 'graphics-symbol' &&
        typeof node.name?.value === 'string' &&
        node.name.value.includes('→'),
    ),
  ).toHaveLength(0)
  await accessibility.detach()
  await expect(page.getByLabel('Focus')).toBeChecked()
  await expect(page.getByLabel('Focus')).toBeEnabled()

  const rovingNode = page.locator('.g-node-body[tabindex="0"]')
  await expect(rovingNode).toHaveCount(1)
  const orderedNodeIds = await page.locator('.g-node-body').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-graph-node-id')),
  )
  const initialNode = await rovingNode.getAttribute('data-graph-node-id')
  await rovingNode.focus()
  await rovingNode.press('ArrowRight')
  await expect
    .poll(() => page.locator('.g-node-body[tabindex="0"]').getAttribute('data-graph-node-id'))
    .not.toBe(initialNode)
  await page.locator('.g-node-body[tabindex="0"]').press('End')
  await expect(page.locator('.g-node-body[tabindex="0"]')).toHaveAttribute(
    'data-graph-node-id',
    orderedNodeIds.at(-1) ?? '',
  )
  await page.locator('.g-node-body[tabindex="0"]').press('Home')
  await expect(page.locator('.g-node-body[tabindex="0"]')).toHaveAttribute(
    'data-graph-node-id',
    orderedNodeIds[0] ?? '',
  )

  const transientPinNode = page.locator(
    '.g-node-body:not(.g-symbol-port-in):not(.g-symbol-port-out):not(.g-symbol-reg):not(.g-symbol-latch)',
  ).first()
  const expectedNodeTitle = await transientPinNode.getAttribute('data-node-tooltip')
  expect(expectedNodeTitle).not.toBeNull()
  await transientPinNode.hover()
  await expect(page.getByRole('tooltip')).toHaveText(expectedNodeTitle ?? '')
  await expect(page.locator('.g-pin-overlay')).toHaveCount(1)
  await transientPinNode.focus()
  await page.mouse.move(0, 0)
  await expect(page.locator('.g-pin-overlay')).toHaveCount(1)
  await svg.focus()
  await expect(page.locator('.g-pin-overlay')).toHaveCount(0)
  const selectedWires = page.locator('.g-selected-edge-layer .g-edge.hl')
  await transientPinNode.focus()
  await transientPinNode.press('Enter')
  await expect(transientPinNode).toHaveClass(/selected/)
  await expect.poll(() => selectedWires.count()).toBeGreaterThan(0)
  await transientPinNode.press('Escape')
  await expect(transientPinNode).not.toHaveClass(/selected/)
  await expect(selectedWires).toHaveCount(0)
  await transientPinNode.press(' ')
  await expect(transientPinNode).toHaveClass(/selected/)
  await expect.poll(() => selectedWires.count()).toBeGreaterThan(0)
  await transientPinNode.press('Escape')
  await expect(transientPinNode).not.toHaveClass(/selected/)
  await expect(selectedWires).toHaveCount(0)
  const selectionLayoutRequests = await page.evaluate(
    () => (window as typeof window & { __elkRequests?: unknown[] }).__elkRequests?.length ?? 0,
  )
  const nodeTransformsBeforeSelection = await page.locator('.g-node-body').evaluateAll(
    (nodes) => nodes.map((node) => node.getAttribute('transform')),
  )
  await transientPinNode.click()
  await expect(transientPinNode).toHaveClass(/selected/)
  await expect.poll(() => selectedWires.count()).toBeGreaterThan(0)
  expect(
    await page.evaluate(
      () => (window as typeof window & { __elkRequests?: unknown[] }).__elkRequests?.length ?? 0,
    ),
  ).toBe(selectionLayoutRequests)
  expect(
    await page.locator('.g-node-body').evaluateAll(
      (nodes) => nodes.map((node) => node.getAttribute('transform')),
    ),
  ).toEqual(nodeTransformsBeforeSelection)
  const tooltipEdge = page.locator('.g-edge').first()
  const expectedEdgeTitle = await tooltipEdge.getAttribute('data-first-edge-title')
  expect(expectedEdgeTitle).not.toBeNull()
  const edgePoint = await tooltipEdge.evaluate((path) => {
    const geometry = path as SVGPathElement
    const point = geometry.getPointAtLength(Math.min(2, geometry.getTotalLength()))
    const matrix = geometry.getScreenCTM()
    if (!matrix) throw new Error('edge path has no screen transform')
    const screen = new DOMPoint(point.x, point.y).matrixTransform(matrix)
    return { x: screen.x, y: screen.y }
  })
  await page.mouse.move(edgePoint.x, edgePoint.y)
  await expect(page.getByRole('tooltip')).toHaveText(expectedEdgeTitle ?? '')
  const beforeKeyboardPan = await viewport.getAttribute('transform')
  await svg.focus()
  await svg.press('ArrowRight')
  await expect.poll(() => viewport.getAttribute('transform')).not.toBe(beforeKeyboardPan)
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  const movedEdgePoint = await tooltipEdge.evaluate((path) => {
    const geometry = path as SVGPathElement
    const point = geometry.getPointAtLength(Math.min(2, geometry.getTotalLength()))
    const matrix = geometry.getScreenCTM()
    if (!matrix) throw new Error('edge path has no screen transform')
    const screen = new DOMPoint(point.x, point.y).matrixTransform(matrix)
    return { x: screen.x, y: screen.y }
  })
  await page.mouse.move(movedEdgePoint.x, movedEdgePoint.y)
  await expect(page.getByRole('tooltip')).toHaveText(expectedEdgeTitle ?? '')
  await tooltipEdge.dispatchEvent('click')
  await expect(transientPinNode).toHaveClass(/selected/)
  await svg.dispatchEvent('wheel', { deltaY: 1 })
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  await svg.dispatchEvent('click')
  await expect(transientPinNode).not.toHaveClass(/selected/)
  await expect(selectedWires).toHaveCount(0)
  await page.mouse.move(0, 0)
  await svg.focus()
  await expect(page.locator('.g-pin-overlay')).toHaveCount(0)

  const beforePan = await viewport.getAttribute('transform')
  const panOrigin = await transientPinNode.boundingBox()
  expect(panOrigin).not.toBeNull()
  await page.mouse.move(
    (panOrigin?.x ?? 0) + (panOrigin?.width ?? 0) / 2,
    (panOrigin?.y ?? 0) + (panOrigin?.height ?? 0) / 2,
  )
  await page.mouse.down()
  await page.mouse.move(
    (panOrigin?.x ?? 0) + (panOrigin?.width ?? 0) / 2 + 24,
    (panOrigin?.y ?? 0) + (panOrigin?.height ?? 0) / 2 + 18,
  )
  await page.mouse.up()
  await expect.poll(() => viewport.getAttribute('transform')).not.toBe(beforePan)
  await expect(page.locator('.g-node-body.selected')).toHaveCount(0)

  const beforeZoom = await viewport.getAttribute('transform')
  await page.getByTitle('Zoom in').click()
  await expect.poll(() => viewport.getAttribute('transform')).not.toBe(beforeZoom)
  for (let step = 0; step < 6; step += 1) await svg.press('Shift+ArrowLeft')
  await page.waitForTimeout(200)
  const userTransform = await viewport.getAttribute('transform')

  const initialWidth = (await stage.boundingBox())?.width ?? 0
  await page.setViewportSize({ width: 1050, height: 680 })
  await expect.poll(async () => (await stage.boundingBox())?.width ?? 0).toBeLessThan(initialWidth - 100)
  await expect.poll(() => viewport.getAttribute('transform')).toBe(userTransform)
  await expect
    .poll(async () => {
      const [stageBox, svgBox] = await Promise.all([stage.boundingBox(), svg.boundingBox()])
      return Math.abs((stageBox?.width ?? 0) - (svgBox?.width ?? 0))
    })
    .toBeLessThan(1)
  await page.setViewportSize({ width: 1600, height: 680 })
  await expect.poll(async () => (await stage.boundingBox())?.width ?? 0).toBeGreaterThan(initialWidth + 100)
  await expect.poll(() => viewport.getAttribute('transform')).toBe(userTransform)
  await expect.poll(() => page.evaluate(() => {
    const stage = document.querySelector('.graph-stage')
    const viewport = document.querySelector('.g-viewport')
    if (!(stage instanceof HTMLElement) || !(viewport instanceof SVGGElement)) return null
    const stageRect = stage.getBoundingClientRect()
    const expected = viewport.dataset.detailLevel === 'overview'
      ? []
      : [...viewport.querySelectorAll<SVGGElement>('.g-node-body')]
          .filter((node) => {
            const rect = node.getBoundingClientRect()
            return (
              rect.right >= stageRect.left - 96 &&
              rect.left <= stageRect.right + 96 &&
              rect.bottom >= stageRect.top - 96 &&
              rect.top <= stageRect.bottom + 96
            )
          })
          .map((node) => node.dataset.graphNodeId)
          .sort()
    const actual = [...viewport.querySelectorAll<SVGGElement>('[data-node-detail-id]')]
      .map((node) => node.dataset.nodeDetailId)
      .sort()
    return JSON.stringify(actual) === JSON.stringify(expected)
  })).toBe(true)

  await svg.dispatchEvent('wheel', { deltaY: -5000 })
  await expect.poll(() => viewport.getAttribute('data-detail-level')).toBe('full')
  await svg.dispatchEvent('wheel', { deltaY: 1300 })
  await expect.poll(() => viewport.getAttribute('data-detail-level')).toBe('compact')
  await svg.dispatchEvent('wheel', { deltaY: 300 })
  await expect.poll(() => viewport.getAttribute('data-detail-level')).toBe('overview')
  await expect(page.locator('.g-node-details')).toHaveCount(0)
  await expect(page.locator('.g-node-body .g-overview-label')).not.toHaveCount(0)
  await expect(page.locator('.g-node-body .g-overview-label').first()).toBeVisible()
  const labelNode = page.locator('.g-node-body.g-symbol-reg, .g-node-body.g-symbol-latch').first()
  const labelNodeId = await labelNode.getAttribute('data-graph-node-id')
  expect(labelNodeId).not.toBeNull()
  const labelDetails = page.locator(
    `.g-node-details[data-node-detail-id="${labelNodeId}"]`,
  )
  const nodeLabel = labelDetails.locator('.g-node-label').first()
  await labelNode.focus()
  await expect(labelDetails).toHaveClass(/force-full/)
  await expect(nodeLabel).toBeVisible()
  await svg.focus()
  await expect(labelDetails).toHaveCount(0)

  const detailedNode = labelNode
  const symbolDetail = labelDetails.locator('.g-symbol-detail').first()
  await detailedNode.dispatchEvent('click')
  await expect(detailedNode).toHaveClass(/selected/)
  await svg.focus()
  await expect(labelDetails).toHaveClass(/force-full/)
  await expect(symbolDetail).toBeVisible()
  await svg.dispatchEvent('click')
  await expect(labelDetails).toHaveCount(0)

  // Overview keeps its tier inside the 0.35-0.45 hysteresis band. Restoring
  // richer detail at 0.5 waits until the viewport has been idle for 160 ms.
  await zoomSchematicToScale(page, 0.42)
  expect(await viewport.getAttribute('data-detail-level')).toBe('overview')
  await zoomSchematicToScale(page, 0.5)
  expect(await viewport.getAttribute('data-detail-level')).toBe('overview')
  await expect.poll(() => viewport.getAttribute('data-detail-level')).toBe('compact')
  await expect(page.locator('.g-node-details')).not.toHaveCount(0)
  await expect(page.locator('.g-node-details .g-reg-pins')).toHaveCount(0)
  await expect(page.locator('.g-node-details .g-control-labels')).toHaveCount(0)

  // Compact likewise remains stable inside the 0.65-0.80 band, then restores
  // full detail only after the richer transition has been idle.
  await zoomSchematicToScale(page, 0.72)
  expect(await viewport.getAttribute('data-detail-level')).toBe('compact')
  await zoomSchematicToScale(page, 0.85)
  expect(await viewport.getAttribute('data-detail-level')).toBe('compact')
  await expect.poll(() => viewport.getAttribute('data-detail-level')).toBe('full')
  await svg.press('0')
  await expect.poll(() => viewport.getAttribute('data-detail-level')).toBe('full')
  await expect(page.locator('.g-node-details .g-node-label').first()).toBeVisible()
  expect(await page.locator('.g-node-details .g-reg-name').first().evaluate((name) => {
    const details = name.closest<SVGGElement>('[data-node-detail-id]')
    const nodeId = details?.dataset.nodeDetailId
    const outline = document.querySelector<SVGGraphicsElement>(
      `.g-node-body[data-graph-node-id="${nodeId}"] .g-symbol-outline`,
    )
    if (!outline) throw new Error('register outline is missing')
    const nameBox = (name as SVGGraphicsElement).getBBox()
    const outlineBox = outline.getBBox()
    return {
      clearsLeftPins: nameBox.x >= outlineBox.x + 26,
      clearsRightPins:
        nameBox.x + nameBox.width <= outlineBox.x + outlineBox.width - 26,
    }
  })).toEqual({ clearsLeftPins: true, clearsRightPins: true })

  // Leaving the tab cancels the pending restore; returning must reschedule it
  // against the preserved user transform rather than stranding overview LOD.
  await zoomSchematicToScale(page, 0.3)
  expect(await viewport.getAttribute('data-detail-level')).toBe('overview')
  await zoomSchematicToScale(page, 0.85)
  expect(await viewport.getAttribute('data-detail-level')).toBe('overview')
  await page.getByRole('tab', { name: 'Overview', exact: true }).click()
  await page.getByRole('tab', { name: 'Schematic', exact: true }).click()
  await expect.poll(() => viewport.getAttribute('data-detail-level')).toBe('full')

  await zoomSchematicToScale(page, 0.3)
  await expect.poll(() => viewport.getAttribute('data-detail-level')).toBe('overview')
  const controlNode = page.locator('.g-node-body.g-symbol-reg, .g-node-body.g-symbol-latch').first()
  await controlNode.focus()
  await controlNode.press('Enter')
  const controlLabel = page.locator('.g-control-label.clickable').first()
  await expect(controlLabel).toBeVisible()
  const beforeControlNodeCount = await page.locator('.g-node-body').count()
  await controlLabel.click()
  await expect.poll(() => page.locator('.g-node-body').count()).not.toBe(beforeControlNodeCount)
  await expect(page.locator('.g-node-body.selected')).toHaveCount(0)
  await expect(viewport).toHaveAttribute('data-detail-level', 'overview')
  await expect(page.locator('.g-node-details')).toHaveCount(0)
  expect(apiRequests).toEqual([])
})

test('allows Focus to be enabled without a source or cone selection', async ({ page }) => {
  await page.goto('/')
  await waitForAutomaticSynthesis(page, () =>
    page.getByLabel('Bundled example').selectOption('reg_mux'),
  )
  await page.getByRole('tab', { name: 'Schematic', exact: true }).click()

  const focus = page.getByLabel('Focus')
  await expect(focus).toBeEnabled()
  await focus.uncheck()
  await page.keyboard.press('Escape')
  await expect(page.locator('.graph-toolbar .mono')).toHaveCount(0)

  await expect(focus).toBeEnabled()
  await focus.check()
  await expect(focus).toBeChecked()
})

test('group toggles reveal on component hover and re-render through ELK', async ({ page }) => {
  await page.addInitScript(() => {
    const requests: unknown[] = []
    const originalPostMessage = Worker.prototype.postMessage
    Object.defineProperty(Worker.prototype, 'postMessage', {
      configurable: true,
      value: function (...args: unknown[]) {
        const request = args[0]
        if (
          request != null &&
          typeof request === 'object' &&
          'input' in request
        ) {
          requests.push(request)
        }
        return Reflect.apply(originalPostMessage, this, args)
      },
    })
    ;(window as typeof window & { __elkLayoutRequests?: unknown[] })
      .__elkLayoutRequests = requests
  })
  await page.goto('/')
  await waitForAutomaticSynthesis(page, async () => {
    await page.getByLabel('Bundled example').selectOption('fifo_pipe')
    await page.getByLabel('Platform').selectOption('gates')
  })
  await page.getByRole('tab', { name: 'Schematic', exact: true }).click()

  const groupedValid = page.locator(
    '.g-node-body.g-symbol-reg[data-member-count="3"]'
      + '[data-node-tooltip*="with_stages.valid"]',
  )
  await expect(groupedValid).toHaveCount(1)
  const groupId = await groupedValid.getAttribute('data-graph-node-id')
  expect(groupId).not.toBeNull()
  const groupedTransform = await groupedValid.getAttribute('transform')
  const groupToggle = page.locator(
    `[data-group-action="expand"][data-group-id="${groupId}"]`,
  )
  await expect(groupToggle).toHaveCSS('opacity', '0')
  await groupedValid.hover()
  await expect.poll(async () =>
    Number.parseFloat(await groupToggle.evaluate((node) =>
      getComputedStyle(node).opacity
    )),
  ).toBeCloseTo(0.84)
  const initialLayoutRequests = await page.evaluate(() =>
    (window as typeof window & { __elkLayoutRequests?: unknown[] })
      .__elkLayoutRequests?.length ?? 0,
  )

  await groupToggle.click()
  const expandedMembers = page.locator(
    `[data-expanded-group-member="${groupId}"]`,
  )
  await expect(expandedMembers).toHaveCount(3)
  await expect.poll(async () => {
    const centers = await expandedMembers.evaluateAll((members) =>
      members.map((member) => {
        const outline = member.querySelector<SVGGraphicsElement>('.g-symbol-outline')
        if (!outline) throw new Error('expanded member outline is missing')
        const box = outline.getBoundingClientRect()
        return box.left + box.width / 2
      }),
    )
    return Math.max(...centers) - Math.min(...centers)
  }).toBeLessThanOrEqual(1)
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { __elkLayoutRequests?: unknown[] })
      .__elkLayoutRequests?.length ?? 0,
  )).toBeGreaterThan(initialLayoutRequests)
  await expect(page.locator('.g-expanded-group-boundary')).toHaveCount(1)
  const themeTextFill = await page.evaluate(() => {
    const probe = document.createElementNS('http://www.w3.org/2000/svg', 'text')
    probe.style.fill = 'var(--text)'
    document.body.append(probe)
    const fill = getComputedStyle(probe).fill
    probe.remove()
    return fill
  })
  await expect(page.locator('.g-expanded-group-label')).toHaveCSS(
    'fill',
    themeTextFill,
  )
  await expect.poll(() => page.evaluate((expandedGroupId) => {
    const requests = (
      window as typeof window & {
        __elkLayoutRequests?: Array<{
          input?: { groups?: Array<{ id: number; members: number[] }> }
        }>
      }
    ).__elkLayoutRequests ?? []
    return requests.at(-1)?.input?.groups?.some(
      (group) =>
        String(group.id) === expandedGroupId &&
        group.members.length === 3,
    ) ?? false
  }, groupId)).toBe(true)
  const groupContainment = await page.evaluate((expandedGroupId) => {
    const boundary = document.querySelector<SVGRectElement>(
      '.g-expanded-group-boundary',
    )?.getBoundingClientRect()
    if (!boundary) return { membersInside: false, overlappingOutsiders: ['missing frame'] }
    const epsilon = 1
    const membersInside = [
      ...document.querySelectorAll<SVGGElement>(
        `[data-expanded-group-member="${expandedGroupId}"]`,
      ),
    ].every((member) => {
      const box = member.getBoundingClientRect()
      return (
        box.left >= boundary.left - epsilon &&
        box.right <= boundary.right + epsilon &&
        box.top >= boundary.top - epsilon &&
        box.bottom <= boundary.bottom + epsilon
      )
    })
    const overlappingOutsiders = [
      ...document.querySelectorAll<SVGGElement>(
        `.g-node-body:not([data-expanded-group-member="${expandedGroupId}"])`,
      ),
    ].flatMap((node) => {
      const box = node.getBoundingClientRect()
      const overlaps = (
        box.left < boundary.right &&
        box.right > boundary.left &&
        box.top < boundary.bottom &&
        box.bottom > boundary.top
      )
      return overlaps ? [node.dataset.nodeTooltip ?? node.dataset.graphNodeId ?? '?'] : []
    })
    return { membersInside, overlappingOutsiders }
  }, groupId)
  expect(groupContainment).toEqual({
    membersInside: true,
    overlappingOutsiders: [],
  })
  await expect.poll(() => page.evaluate((expandedGroupId) => {
    const members = [...document.querySelectorAll<SVGGElement>(
      `[data-expanded-group-member="${expandedGroupId}"]`,
    )].flatMap((node) => {
      const outline = node.querySelector<SVGGraphicsElement>('.g-symbol-outline')
      const matrix = node.transform.baseVal.consolidate()?.matrix
      if (!outline || !matrix) return []
      const box = outline.getBBox()
      return [{
        left: matrix.e + box.x,
        top: matrix.f + box.y,
        right: matrix.e + box.x + box.width,
        bottom: matrix.f + box.y + box.height,
      }]
    })
    const segmentCrossesMember = (
      start: { x: number; y: number },
      end: { x: number; y: number },
    ) => members.some((member) => {
      if (start.x === end.x) {
        return (
          start.x > member.left &&
          start.x < member.right &&
          Math.max(start.y, end.y) > member.top &&
          Math.min(start.y, end.y) < member.bottom
        )
      }
      if (start.y === end.y) {
        return (
          start.y > member.top &&
          start.y < member.bottom &&
          Math.max(start.x, end.x) > member.left &&
          Math.min(start.x, end.x) < member.right
        )
      }
      return true
    })
    const crossings: string[] = []
    for (const path of document.querySelectorAll<SVGPathElement>('.g-edge')) {
      const pathData = path.getAttribute('d') ?? ''
      const tokens = pathData.match(
        /[ML]|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi,
      ) ?? []
      let previous: { x: number; y: number } | null = null
      for (let index = 0; index < tokens.length;) {
        const command = tokens[index++]
        const point = {
          x: Number(tokens[index++]),
          y: Number(tokens[index++]),
        }
        if (command === 'M') {
          previous = point
          continue
        }
        if (previous && segmentCrossesMember(previous, point)) {
          crossings.push(pathData)
          break
        }
        previous = point
      }
    }
    return crossings
  }, groupId)).toEqual([])
  const collapseToggles = page.locator(
    `[data-group-action="collapse"][data-group-id="${groupId}"]`,
  )
  await expect(collapseToggles).toHaveCount(1)

  await expect(collapseToggles.first()).toHaveCSS('opacity', '0')
  const emptyFramePoint = await page.evaluate((expandedGroupId) => {
    const boundary = document.querySelector<SVGRectElement>(
      `[data-expanded-group-id="${expandedGroupId}"] .g-expanded-group-boundary`,
    )?.getBoundingClientRect()
    if (!boundary) throw new Error('expanded group boundary is missing')
    const members = [
      ...document.querySelectorAll<SVGGElement>(
        `[data-expanded-group-member="${expandedGroupId}"]`,
      ),
    ].map((member) => member.getBoundingClientRect())
    const stepX = Math.max(3, boundary.width / 24)
    const stepY = Math.max(3, boundary.height / 24)
    for (let y = boundary.top + 3; y < boundary.bottom - 3; y += stepY) {
      for (let x = boundary.left + 3; x < boundary.right - 3; x += stepX) {
        const overlapsMember = members.some((member) =>
          x >= member.left &&
          x <= member.right &&
          y >= member.top &&
          y <= member.bottom
        )
        if (!overlapsMember) return { x, y }
      }
    }
    throw new Error('expanded group has no empty hover point')
  }, groupId)
  await page.mouse.move(emptyFramePoint.x, emptyFramePoint.y)
  await expect.poll(async () =>
    Number.parseFloat(await collapseToggles.first().evaluate((node) =>
      getComputedStyle(node).opacity
    )),
  ).toBeCloseTo(0.84)
  await page.mouse.move(5, 5)
  await expect(collapseToggles.first()).toHaveCSS('opacity', '0')
  await expandedMembers.first().hover()
  await expect.poll(async () =>
    Number.parseFloat(await collapseToggles.first().evaluate((node) =>
      getComputedStyle(node).opacity
    )),
  ).toBeCloseTo(0.84)
  await collapseToggles.first().click()
  await expect(groupedValid).toHaveAttribute('transform', groupedTransform ?? '')
})

test('source selections and Focus use the in-browser Rust analysis worker', async ({ page }) => {
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
    ;(window as typeof window & { __workerRequests?: unknown[] }).__workerRequests = requests
  })
  const apiRequests = recordApiRequests(page)
  const workerCounts = () =>
    page.evaluate(() => {
      const requests =
        (window as typeof window & { __workerRequests?: unknown[] }).__workerRequests ?? []
      const records = requests.filter(
        (request): request is Record<string, unknown> =>
          request != null && typeof request === 'object' && !Array.isArray(request),
      )
      return {
        source: records.filter(
          (request) => request.kind === 'query' && request.method === 'source',
        ).length,
        netlist: records.filter(
          (request) => request.kind === 'query' && request.method === 'netlist',
        ).length,
        layout: records.filter(
          (request) => 'input' in request && 'placement' in request,
        ).length,
      }
    })
  await page.goto('/')
  await waitForAutomaticSynthesis(page, async () => {
    await page.getByLabel('Bundled example').selectOption('handshake_controller')
  })
  await page.getByRole('tab', { name: 'Schematic', exact: true }).click()
  const editor = page.locator('.cm-content')

  const focus = page.getByLabel('Focus')
  await expect(focus).toBeChecked()
  await expect(focus).toBeEnabled()
  await focus.uncheck()
  await expect(focus).not.toBeChecked()
  await expect(focus).toBeEnabled()
  const fullNodes = page.locator('.g-node-body')
  await expect(fullNodes.first()).toBeVisible()
  const fullNodeIds = await fullNodes.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-graph-node-id')),
  )
  const fullNodeTransforms = await fullNodes.evaluateAll((nodes) =>
    nodes.map((node) => [
      node.getAttribute('data-graph-node-id'),
      node.getAttribute('transform'),
    ]),
  )
  expect(fullNodeIds.length).toBeGreaterThan(0)

  const sourceQueriesBeforeInput = (await workerCounts()).source
  await page.locator('.cm-line', { hasText: /input\s+logic\s+start,/ }).click()
  await editor.press('Home')
  for (let press = 0; press < 13; press += 1) await editor.press('ArrowRight')
  await editor.press('Shift+ArrowRight')
  await expect.poll(async () => (await workerCounts()).source).toBeGreaterThan(
    sourceQueriesBeforeInput,
  )
  await expect
    .poll(() =>
      page.evaluate(() => {
        const requests =
          (window as typeof window & { __workerRequests?: unknown[] }).__workerRequests ?? []
        const sourceQueries = requests.filter(
          (request): request is Record<string, unknown> =>
            request != null &&
            typeof request === 'object' &&
            !Array.isArray(request) &&
            'kind' in request &&
            'method' in request &&
            request.kind === 'query' &&
            request.method === 'source',
        )
        const payload = sourceQueries.at(-1)?.payload as Record<string, unknown> | undefined
        return [payload?.start_column, payload?.end_column]
      }),
    )
    .toEqual([18, 18])
  await expect(focus).toBeEnabled({ timeout: 15_000 })
  const workerContract = await page.evaluate(() => {
    const requests =
      (window as typeof window & { __workerRequests?: unknown[] }).__workerRequests ?? []
    const records = requests.filter(
      (request): request is Record<string, unknown> =>
        request != null && typeof request === 'object' && !Array.isArray(request),
    )
    const sourceQueries = records.filter(
      (request) => request.kind === 'query' && request.method === 'source',
    )
    return {
      snapshotRequests: records.filter((request) =>
        Object.prototype.hasOwnProperty.call(request, 'snapshot'),
      ).length,
      sourceQueries: sourceQueries.length,
      sourcePayloadKeys: Object.keys(
        (sourceQueries.at(-1)?.payload as Record<string, unknown> | undefined) ?? {},
      ).sort(),
    }
  })
  expect(workerContract.snapshotRequests).toBe(0)
  expect(workerContract.sourceQueries).toBeGreaterThan(0)
  expect(workerContract.sourcePayloadKeys).toEqual([
    'end_column',
    'end_line',
    'file',
    'group_memories',
    'group_vectors',
    'hide_const',
    'hide_control',
    'max_nodes',
    'start_column',
    'start_line',
  ])
  await expect(focus).not.toBeChecked()
  await expect(page.locator('.g-node-body')).toHaveCount(fullNodeIds.length)
  await expect
    .poll(() => page.locator('.g-node-body.hl, .g-edge.hl').count())
    .toBeGreaterThan(0)
  const directNodeIds = await page.locator('.g-node-body.hl').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-graph-node-id')).sort(),
  )
  const contextualLogic = page.locator(
    '.g-node-body[data-relevant="1"]:not(.hl):not(.g-symbol-port-in):not(.g-symbol-port-out):not(.g-symbol-const)',
  )
  await expect.poll(() => contextualLogic.count()).toBeGreaterThan(0)
  const contextualLogicIds = await contextualLogic.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-graph-node-id')).sort(),
  )
  const dimmedNodes = page.locator('.g-node-body[data-relevant="0"]')
  await expect.poll(() => dimmedNodes.count()).toBeGreaterThan(0)
  await expect(dimmedNodes.first()).toHaveCSS('opacity', '0.25')
  // Detail layers are viewport/LOD-virtualized; node shells are the stable
  // relevance-opacity contract at every zoom level.
  const dimmedEdges = page.locator('.g-edge[data-relevant="0"]')
  await expect.poll(() => dimmedEdges.count()).toBeGreaterThan(0)
  expect(
    await page.locator('.graph-stage-wrap').evaluate((stage) => {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.classList.add('g-edge', 'control')
      path.dataset.relevant = '0'
      const arrows = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      arrows.classList.add('g-edge-arrows', 'control')
      arrows.dataset.relevant = '0'
      svg.append(path, arrows)
      stage.append(svg)
      const opacity = {
        path: getComputedStyle(path).opacity,
        arrows: getComputedStyle(arrows).opacity,
      }
      svg.remove()
      return opacity
    }),
  ).toEqual({ path: '0.1625', arrows: '0.1625' })

  await focus.check()
  await expect(focus).toBeChecked()
  await expect.poll(() => page.locator('.g-node-body').count()).toBeLessThan(fullNodeIds.length)
  await expect
    .poll(() =>
      page.locator('.g-node-body.hl').evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('data-graph-node-id')).sort(),
      ),
    )
    .toEqual(directNodeIds)
  await expect
    .poll(() =>
      page.locator(
        '.g-node-body[data-relevant="1"]:not(.hl):not(.g-symbol-port-in):not(.g-symbol-port-out):not(.g-symbol-const)',
      ).evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('data-graph-node-id')).sort(),
      ),
    )
    .toEqual(contextualLogicIds)
  await expect(page.locator('.g-node-body[data-relevant="0"]')).toHaveCount(0)
  await expect(dimmedEdges).toHaveCount(0)
  const focusedNodeCount = await page.locator('.g-node-body').count()
  const expandableBoundary = page.locator(
    '.g-node-body[data-boundary="true"][data-graph-node-id="44"]',
  )
  await expect(expandableBoundary).toBeVisible()
  await expandableBoundary.focus()
  await expandableBoundary.press('Shift+Enter')
  await expect.poll(() => page.locator('.g-node-body').count()).toBeGreaterThan(focusedNodeCount)

  await page.evaluate(() => {
    const requests =
      (window as typeof window & { __workerRequests?: unknown[] }).__workerRequests ?? []
    requests.length = 0
  })
  await expandableBoundary.dispatchEvent('dblclick')
  await expect
    .poll(() =>
      page.evaluate(() => {
        const requests =
          (window as typeof window & { __workerRequests?: unknown[] }).__workerRequests ?? []
        return requests.filter(
          (request) =>
            request != null &&
            typeof request === 'object' &&
            !Array.isArray(request) &&
            (request as Record<string, unknown>).kind === 'query' &&
            (request as Record<string, unknown>).method === 'cone',
        ).length
      }),
    )
    .toBe(2)

  await focus.uncheck()
  await expect(page.locator('.g-node-body')).toHaveCount(fullNodeIds.length)
  const fullViewportTransform = await page
    .locator('.g-viewport')
    .getAttribute('transform')
  const workerCountsBeforeDeclaration = await workerCounts()
  const selectTrailingIdentifier = async (
    line: ReturnType<typeof page.locator>,
    identifierLength: number,
  ) => {
    await line.click()
    await editor.press('End')
    for (let offset = 0; offset <= identifierLength; offset += 1) {
      await editor.press('ArrowLeft')
    }
    for (let offset = 0; offset < identifierLength; offset += 1) {
      await editor.press('Shift+ArrowRight')
    }
  }
  await selectTrailingIdentifier(
    page.locator('.cm-line', { hasText: 'logic [COUNT_WIDTH-1:0] wait_count;' }),
    'wait_count'.length,
  )
  await expect.poll(() => page.locator('.g-node-body.g-symbol-reg.hl').count()).toBeGreaterThan(0)
  await expect
    .poll(() =>
      page.locator('.g-edge.hl').evaluateAll((edges) =>
        edges.some((edge) =>
          (edge.getAttribute('data-first-edge-title') ?? '').includes('wait_count'),
        ),
      ),
    )
    .toBe(true)
  const waitCountDirectNodeIds = await page.locator('.g-node-body.hl').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-graph-node-id')).sort(),
  )
  await expect
    .poll(() =>
      page.locator('.g-node-body[data-relevant="1"]:not(.hl)').count(),
    )
    .toBeGreaterThan(0)
  expect(
    await fullNodes.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-graph-node-id')),
    ),
  ).toEqual(fullNodeIds)
  expect(
    await fullNodes.evaluateAll((nodes) =>
      nodes.map((node) => [
        node.getAttribute('data-graph-node-id'),
        node.getAttribute('transform'),
      ]),
    ),
  ).toEqual(fullNodeTransforms)
  await expect(page.locator('.g-viewport')).toHaveAttribute(
    'transform',
    fullViewportTransform ?? '',
  )
  await expect.poll(workerCounts).toMatchObject({
    netlist: workerCountsBeforeDeclaration.netlist,
    layout: workerCountsBeforeDeclaration.layout,
  })

  const sourceQueriesBeforeState = (await workerCounts()).source
  await selectTrailingIdentifier(
    page.locator('.cm-line', { hasText: 'state_t state;' }),
    'state'.length,
  )
  await expect.poll(async () => (await workerCounts()).source).toBeGreaterThan(
    sourceQueriesBeforeState,
  )
  await expect
    .poll(() =>
      page.locator('.g-node-body.hl').evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('data-graph-node-id')).sort(),
      ),
    )
    .not.toEqual(waitCountDirectNodeIds)
  await expect.poll(() => page.locator('.g-node-body.g-symbol-reg.hl').count()).toBeGreaterThan(0)
  const declarationDirectNodeIds = await page
    .locator('.g-node-body.hl')
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-graph-node-id')).sort(),
    )
  await focus.check()
  await expect.poll(() => page.locator('.g-node-body').count()).toBeLessThan(fullNodeIds.length)
  await expect
    .poll(() =>
      page.locator('.g-node-body.hl').evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('data-graph-node-id')).sort(),
      ),
    )
    .toEqual(declarationDirectNodeIds)
  const sourceQueriesBeforeReverse = (await workerCounts()).source
  await page
    .locator(`.g-node-body[data-graph-node-id="${declarationDirectNodeIds[0]}"]`)
    .click()
  // Selecting a register highlights the statements that assign it (the
  // exact tier), not its declaration line.
  await expect(
    page.locator('.cm-line.cm-src-hl', { hasText: 'state <= next_state;' }),
  ).toBeVisible()
  await expect(
    page.locator('.cm-line.cm-src-hl', { hasText: 'state_t state;' }),
  ).toHaveCount(0)
  await expect.poll(async () => (await workerCounts()).source).toBe(sourceQueriesBeforeReverse)
  await focus.uncheck()
  await expect(page.locator('.g-node-body')).toHaveCount(fullNodeIds.length)

  await page.locator('.cm-line', { hasText: "request_valid = 1'b1;" }).click()
  await expect.poll(() => page.locator('.g-node-body.hl').count()).toBeGreaterThan(0)
  expect(
    await fullNodes.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-graph-node-id')),
    ),
  ).toEqual(fullNodeIds)

  await page.evaluate(() => {
    const requests =
      (window as typeof window & { __workerRequests?: unknown[] }).__workerRequests ?? []
    requests.length = 0
  })
  await page.getByLabel('hide const').uncheck()
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const requests =
          (window as typeof window & { __workerRequests?: unknown[] }).__workerRequests ?? []
        const methods = requests
          .filter(
            (request): request is Record<string, unknown> =>
              request != null &&
              typeof request === 'object' &&
              !Array.isArray(request) &&
              'kind' in request &&
              'method' in request &&
              request.kind === 'query' &&
              (request.method === 'source' || request.method === 'netlist'),
          )
          .map((request) => request.method)
        return {
          source: methods.includes('source'),
          netlist: methods.includes('netlist'),
        }
      }),
    )
    .toEqual({ source: true, netlist: true })
  const refreshMethods = await page.evaluate(() => {
    const requests =
      (window as typeof window & { __workerRequests?: unknown[] }).__workerRequests ?? []
    return requests
      .filter(
        (request): request is Record<string, unknown> =>
          request != null &&
          typeof request === 'object' &&
          !Array.isArray(request) &&
          'kind' in request &&
          'method' in request &&
          request.kind === 'query' &&
          (request.method === 'source' || request.method === 'netlist'),
      )
      .map((request) => request.method)
  })
  expect(refreshMethods.indexOf('source')).toBeLessThan(refreshMethods.indexOf('netlist'))

  await page.locator('.cm-content').press('Escape')
  await expect(focus).toBeEnabled()
  await expect(page.locator('.g-node-body.hl')).toHaveCount(0)
  await expect(page.locator('.g-edge.hl')).toHaveCount(0)
  await expect(page.locator('.cm-line.cm-src-hl')).toHaveCount(0)
  expect(apiRequests).toEqual([])
})

test('a FIFO source line selects the same logic from Home through End', async ({ page }) => {
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
    ;(window as typeof window & { __workerRequests?: unknown[] }).__workerRequests = requests
  })
  await page.goto('/')
  await waitForAutomaticSynthesis(page, async () => {
    await page.getByLabel('Bundled example').selectOption('inferred_fifo')
    await page.getByLabel('Platform').selectOption('xilinx')
  })
  await page.getByRole('tab', { name: 'Schematic', exact: true }).click()
  const editor = page.locator('.cm-content')
  const line = page.locator('.cm-line', {
    hasText: 'assign pop = pop_valid && pop_ready;',
  })
  const lineLength = (await line.textContent())?.length ?? 0
  expect(lineLength).toBeGreaterThan(0)
  const firstContentColumn = ((await line.textContent()) ?? '').search(/\S/) + 1

  const snapshotAt = async (key: 'Home' | 'End') => {
    await editor.press('Control+Home')
    await expect.poll(() => page.evaluate(() => {
      const requests =
        (window as typeof window & { __workerRequests?: unknown[] }).__workerRequests ?? []
      const sourceQueries = requests.filter(
        (request): request is Record<string, unknown> =>
          request != null &&
          typeof request === 'object' &&
          !Array.isArray(request) &&
          'kind' in request &&
          'method' in request &&
          request.kind === 'query' &&
          request.method === 'source',
      )
      return (sourceQueries.at(-1)?.payload as Record<string, unknown> | undefined)
        ?.start_line
    })).toBe(1)
    await page.evaluate(() => {
      const requests =
        (window as typeof window & { __workerRequests?: unknown[] }).__workerRequests ?? []
      requests.length = 0
    })
    await line.click()
    await editor.press(key)
    await expect.poll(() => page.evaluate(() => {
      const requests =
        (window as typeof window & { __workerRequests?: unknown[] }).__workerRequests ?? []
      const sourceQueries = requests.filter(
        (request): request is Record<string, unknown> => request != null &&
          typeof request === 'object' &&
          !Array.isArray(request) &&
          'kind' in request &&
          'method' in request &&
          request.kind === 'query' &&
          request.method === 'source',
      )
      const payload = sourceQueries.at(-1)?.payload as Record<string, unknown> | undefined
      return [payload?.start_line, payload?.start_column]
    })).toEqual([27, key === 'Home' ? firstContentColumn : lineLength + 1])
    await expect(page.locator('.graph-stage-wrap')).toHaveAttribute('data-focus', 'on')
    await expect(page.locator('.g-node-body').first()).toBeVisible()
    return {
      payload: await page.evaluate(() => {
        const requests =
          (window as typeof window & { __workerRequests?: unknown[] }).__workerRequests ?? []
        const sourceQueries = requests.filter(
          (request): request is Record<string, unknown> =>
            request != null &&
            typeof request === 'object' &&
            !Array.isArray(request) &&
            'kind' in request &&
            'method' in request &&
            request.kind === 'query' &&
            request.method === 'source',
        )
        return sourceQueries.at(-1)?.payload
      }),
      nodes: await page.locator('.g-node-body').evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('data-graph-node-id')).sort(),
      ),
      highlighted: await page.locator('.g-node-body.hl').evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('data-graph-node-id')).sort(),
      ),
      highlightedEdges: await page.locator('.g-edge.hl').evaluateAll((edges) =>
        edges.map((edge) => edge.getAttribute('data-first-edge-title') ?? '').sort(),
      ),
      edges: await page.locator('.g-edge').evaluateAll((edges) =>
        edges.map((edge) => edge.getAttribute('data-first-edge-title') ?? '').sort(),
      ),
    }
  }

  const home = await snapshotAt('Home')
  const end = await snapshotAt('End')
  expect(home.payload).toMatchObject({
    fallback_start_column: 1,
    fallback_end_column: lineLength,
  })
  expect(end.payload).toMatchObject({
    fallback_start_column: 1,
    fallback_end_column: lineLength,
  })
  expect(end.nodes).toEqual(home.nodes)
  expect(end.highlighted).toEqual(home.highlighted)
  expect(end.highlightedEdges).toEqual(home.highlightedEdges)
  expect(end.edges).toEqual(home.edges)
})

test('Round-Robin internal declaration fallback keeps Focus local', async ({ page }) => {
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
    ;(window as typeof window & { __workerRequests?: unknown[] }).__workerRequests = requests
  })
  const apiRequests = recordApiRequests(page)
  await page.goto('/')
  await waitForAutomaticSynthesis(page, async () => {
    await page.getByLabel('Bundled example').selectOption('round_robin_arbiter')
  })
  await page.getByRole('tab', { name: 'Schematic', exact: true }).click()

  const focus = page.getByLabel('Focus')
  await expect(focus).toBeEnabled()
  await focus.uncheck()
  const allNodes = page.locator('.g-node-body')
  await expect(allNodes.first()).toBeVisible()
  const fullNodeCount = await allNodes.count()
  expect(fullNodeCount).toBeGreaterThan(0)

  const editor = page.locator('.cm-content')
  const selectDeclarationColumn = async (line: Locator, column: number) => {
    await line.click()
    await editor.press('Home')
    await editor.press('Home')
    for (let press = 1; press < column; press += 1) await editor.press('ArrowRight')
    await expect
      .poll(() =>
        page.evaluate(() => {
          const requests =
            (window as typeof window & { __workerRequests?: unknown[] }).__workerRequests ?? []
          const sourceQueries = requests.filter(
            (request): request is Record<string, unknown> =>
              request != null &&
              typeof request === 'object' &&
              !Array.isArray(request) &&
              'kind' in request &&
              'method' in request &&
              request.kind === 'query' &&
              request.method === 'source',
          )
          return (sourceQueries.at(-1)?.payload as Record<string, unknown> | undefined)
            ?.start_column
        }),
      )
      .toBe(column)
    await expect
      .poll(
        async () =>
          (await page.locator('.g-node-body.hl').count()) +
          (await page.locator('.g-edge.hl').count()),
      )
      .toBeGreaterThan(0)
    return {
      nodes: await page.locator('.g-node-body.hl').evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('data-graph-node-id')).sort(),
      ),
      edges: await page.locator('.g-edge.hl').evaluateAll((edges) =>
        edges.map((edge) => edge.getAttribute('data-first-edge-title') ?? '').sort(),
      ),
    }
  }
  const expectDeclarationFallback = async (lineText: string, identifier: string) => {
    const line = page.locator('.cm-line', { hasText: lineText })
    const text = (await line.textContent()) ?? ''
    const exact = await selectDeclarationColumn(line, text.indexOf(identifier) + 1)
    const fallbackColumns = new Set([
      1,
      text.indexOf('input') + 1,
      text.indexOf('output') + 1,
      text.indexOf('logic') + 1,
      text.indexOf('[') + 1,
    ])
    fallbackColumns.delete(0)
    for (const column of fallbackColumns) {
      expect(await selectDeclarationColumn(line, column)).toEqual(exact)
    }
  }

  await expectDeclarationFallback(
    'input logic [NUM_REQUESTERS-1:0] requests,',
    'requests',
  )
  await expectDeclarationFallback(
    'output logic [NUM_REQUESTERS-1:0] grant,',
    'grant',
  )
  await expectDeclarationFallback('logic [INDEX_WIDTH-1:0] next_index;', 'next_index')
  const relevantNodes = page.locator('.g-node-body[data-relevant="1"]')
  const relevantNodeCount = await relevantNodes.count()
  expect(relevantNodeCount).toBeGreaterThan(0)
  expect(relevantNodeCount).toBeLessThanOrEqual(Math.ceil(fullNodeCount / 2))

  await focus.check()
  await expect(allNodes).toHaveCount(relevantNodeCount)
  expect(apiRequests).toEqual([])
})

test('focused output selections keep visible clock and reset wiring', async ({ page }) => {
  await page.goto('/')
  await waitForAutomaticSynthesis(page, async () => {
    await page.getByLabel('Bundled example').selectOption('round_robin_arbiter')
    await page.getByLabel('Platform').selectOption('lut6')
  })
  await page.getByRole('tab', { name: 'Schematic', exact: true }).click()
  await expect(page.locator('.g-node-body[data-node-tooltip="clk"]')).toHaveCount(0)
  await expect(page.locator('.g-node-body[data-node-tooltip="rst"]')).toHaveCount(0)

  const editor = page.locator('.cm-content')
  await page
    .locator('.cm-line', { hasText: /output logic \[NUM_REQUESTERS-1:0\]\s+grant,/ })
    .click()
  await editor.press('End')
  for (let offset = 0; offset <= 'grant'.length; offset += 1) {
    await editor.press('ArrowLeft')
  }
  for (let offset = 0; offset < 'grant'.length; offset += 1) {
    await editor.press('Shift+ArrowRight')
  }

  await expect(page.getByLabel('Focus')).toBeEnabled({ timeout: 15_000 })
  await expect(page.getByLabel('Focus')).toBeChecked()
  await expect(page.locator('.graph-stage-wrap')).toHaveAttribute('data-focus', 'on')
  await page.getByLabel('hide control').uncheck()
  await expect(page.locator('.g-node-body[data-node-tooltip="clk"]')).toBeVisible()
  await expect(page.locator('.g-node-body[data-node-tooltip="rst"]')).toBeVisible()
  await expect
    .poll(() =>
      page.locator('.g-edge.control').evaluateAll((paths) =>
        paths.reduce(
          (count, path) => count + Number(path.getAttribute('data-edge-count') ?? 0),
          0,
        ),
      ),
    )
    .toBeGreaterThanOrEqual(2)
})

test('explicit same-line selections carry column and exact-net identity', async ({ page }) => {
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
    ;(window as typeof window & { __workerRequests?: unknown[] }).__workerRequests = requests
  })
  const apiRequests = recordApiRequests(page)
  await page.goto('/')
  await waitForAnalysisReady(page)
  const top = (await page.getByLabel('Top').inputValue()) || 'top'
  const source = `module ${top}(
  input logic clk,
  input logic a,
  output logic y,
  output logic z
);
  logic first; logic second;
  always_ff @(posedge clk) begin
    first <= a; second <= ~a;
  end
  assign y = first; assign z = second;
endmodule
`
  const editor = page.locator('.cm-content')
  await waitForAutomaticSynthesis(page, async () => {
    await editor.click()
    await editor.press('Control+A')
    await page.keyboard.insertText(source)
  })
  await page.getByRole('tab', { name: 'Schematic', exact: true }).click()
  const declarationLine = page.locator('.cm-line', {
    hasText: 'logic first; logic second;',
  })
  await declarationLine.click()
  const focus = page.getByLabel('Focus')
  await expect(focus).toBeEnabled({ timeout: 15_000 })
  await focus.uncheck()
  const fullNodes = page.locator('.g-node-body')
  await expect(fullNodes.first()).toBeVisible()
  const fullNodeState = await fullNodes.evaluateAll((nodes) =>
    nodes.map((node) => [
      node.getAttribute('data-graph-node-id'),
      node.getAttribute('transform'),
    ]),
  )
  const viewportTransform = await page.locator('.g-viewport').getAttribute('transform')

  const selectText = async (
    line: Locator,
    rightPresses: number,
    selectionLength: number,
    expectedStartColumn: number,
    expectedEndColumn: number,
    requireEdge = true,
  ) => {
    await line.click()
    await editor.press('Home')
    for (let press = 0; press < rightPresses; press += 1) {
      await editor.press('ArrowRight')
    }
    for (let press = 0; press < selectionLength; press += 1) {
      await editor.press('Shift+ArrowRight')
    }
    await expect
      .poll(() =>
        page.evaluate(() => {
          const requests =
            (window as typeof window & { __workerRequests?: unknown[] }).__workerRequests ?? []
          const sourceQueries = requests.filter(
            (request): request is Record<string, unknown> =>
              request != null &&
              typeof request === 'object' &&
              !Array.isArray(request) &&
              'kind' in request &&
              'method' in request &&
              request.kind === 'query' &&
              request.method === 'source',
          )
          const payload = sourceQueries.at(-1)?.payload as Record<string, unknown> | undefined
          return [payload?.start_column, payload?.end_column]
        }),
      )
      .toEqual([expectedStartColumn, expectedEndColumn])
    await expect
      .poll(() =>
        requireEdge
          ? page.locator('.g-edge.hl').count()
          : page.locator('.g-node-body.hl').count(),
      )
      .toBeGreaterThan(0)
    return page.locator('.g-edge.hl').evaluateAll((edges) =>
      edges.map((edge) => edge.getAttribute('data-first-edge-title') ?? '').sort(),
    )
  }

  const firstEdges = await selectText(declarationLine, 6, 5, 9, 13)
  expect(firstEdges.length).toBeGreaterThan(0)
  const secondEdges = await selectText(declarationLine, 19, 6, 22, 27)
  expect(secondEdges.length).toBeGreaterThan(0)
  expect(secondEdges).not.toEqual(firstEdges)

  const proceduralLine = page.locator('.cm-line', {
    hasText: 'first <= a; second <= ~a;',
  })
  await selectText(proceduralLine, 0, 5, 5, 9, false)
  const firstProceduralNodes = await page.locator('.g-node-body.hl').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-graph-node-id')).sort(),
  )
  await selectText(proceduralLine, 12, 6, 17, 22, false)
  const secondProceduralNodes = await page.locator('.g-node-body.hl').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-graph-node-id')).sort(),
  )
  expect(secondProceduralNodes).not.toEqual(firstProceduralNodes)

  const continuousLine = page.locator('.cm-line', {
    hasText: 'assign y = first; assign z = second;',
  })
  const firstContinuousEdges = await selectText(continuousLine, 7, 1, 10, 10)
  const secondContinuousEdges = await selectText(continuousLine, 25, 1, 28, 28)
  expect(secondContinuousEdges).not.toEqual(firstContinuousEdges)
  const edgePoint = await page.locator('.g-edge.hl').first().evaluate((edge) => {
    if (!(edge instanceof SVGPathElement)) throw new Error('highlighted edge is not a path')
    const point = edge.getPointAtLength(edge.getTotalLength() / 2)
    const matrix = edge.getScreenCTM()
    if (!matrix) throw new Error('highlighted edge has no screen transform')
    const screen = point.matrixTransform(matrix)
    return { x: screen.x, y: screen.y }
  })
  await page.mouse.click(edgePoint.x, edgePoint.y + 4)
  await expect(
    page.locator('.cm-line.cm-src-hl', {
      hasText: 'logic first; logic second;',
    }),
  ).toBeVisible()
  // Tiered wire attribution highlights the net's declaration and driving
  // statement; exact-net identity means `second` ranges appear and
  // `first` ranges do not.
  await expect(
    page.locator('.cm-src-range-hl').filter({ hasText: /^second;?$/ }),
  ).toHaveCount(1)
  await expect(
    page.locator('.cm-src-range-hl').filter({ hasText: /^first;?$/ }),
  ).toHaveCount(0)
  await selectText(declarationLine, 6, 5, 9, 13)
  await expect(page.locator('.cm-line.cm-src-hl')).toHaveCount(0)
  await expect(page.locator('.cm-src-range-hl')).toHaveCount(0)
  expect(
    await fullNodes.evaluateAll((nodes) =>
      nodes.map((node) => [
        node.getAttribute('data-graph-node-id'),
        node.getAttribute('transform'),
      ]),
    ),
  ).toEqual(fullNodeState)
  await expect(page.locator('.g-viewport')).toHaveAttribute(
    'transform',
    viewportTransform ?? '',
  )
  await page.locator('.cm-content').press('Escape')
  await expect(page.locator('.cm-line.cm-src-hl')).toHaveCount(0)
  await expect(page.locator('.cm-src-range-hl')).toHaveCount(0)
  expect(apiRequests).toEqual([])
})

test('clears the schematic while source or top-level changes are pending', async ({ page }) => {
  await page.goto('/')
  await waitForAnalysisReady(page)

  const analysisPane = page.locator('.pane-right')
  const schematic = page.locator('.graph-stage svg')
  const editor = page.locator('.cm-content')

  await editor.click()
  await editor.press('Control+End')
  await editor.type('\n// changed source')
  await expect(analysisPane).not.toHaveAttribute('data-analysis-state', 'current')
  await expect(schematic).toHaveCount(0)
  await waitForAnalysisReady(page)

  await page.getByLabel('Top').fill('top')
  await expect(analysisPane).not.toHaveAttribute('data-analysis-state', 'current')
  await expect(schematic).toHaveCount(0)
  await waitForAnalysisReady(page)
})

test('clears schematic selections when synthesis changes', async ({ page }) => {
  await page.goto('/')
  await waitForAutomaticSynthesis(page, () =>
    page.getByLabel('Bundled example').selectOption('reg_mux'),
  )
  await page.getByRole('tab', { name: 'Schematic', exact: true }).click()

  const graphNodes = page.locator('.g-node-body')
  await expect(graphNodes.first()).toBeVisible()
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('checkbox', { name: 'Synthesize automatically' }).uncheck()
  await page.getByRole('button', { name: 'Settings' }).click()

  // A same-input synthesis returns the same design id. Local node state must
  // still reset, independently of any cone projection changing underneath it.
  await graphNodes.first().dispatchEvent('click')
  await expect(page.locator('.g-node-body.selected')).toHaveCount(1)
  await expect(page.locator('.node-card')).toHaveCount(1)

  const synthesize = page.getByRole('button', { name: 'Synthesize', exact: true })
  const resynthesize = async () => {
    await startAnalysisStateRecording(page)
    await synthesize.click()
    await expect.poll(() => recordedAnalysisStates(page)).toContain('refreshing')
    await expect(page.locator('.pane-right')).toHaveAttribute(
      'data-analysis-state',
      'current',
      { timeout: 120_000 },
    )
    await stopAnalysisStateRecording(page)
    await expect(page.locator('.graph-loading-indicator')).toHaveCount(0)
  }
  await resynthesize()
  await expect(page.locator('.g-node-body.selected')).toHaveCount(0)
  await expect(page.locator('.node-card')).toHaveCount(0)

  await graphNodes.first().dispatchEvent('click')
  await page.getByRole('button', { name: 'Fanin cone' }).click()
  await expect(page.locator('.graph-toolbar .mono')).toBeVisible()
  await resynthesize()
  await expect(page.locator('.graph-toolbar .mono')).toHaveCount(0)
  await expect(page.getByText('this cone belongs to the previous synthesis')).toHaveCount(0)

  const edgePoint = await page.locator('.g-edge').first().evaluate((edge) => {
    if (!(edge instanceof SVGPathElement)) throw new Error('edge is not a path')
    const point = edge.getPointAtLength(Math.min(2, edge.getTotalLength()))
    const matrix = edge.getScreenCTM()
    if (!matrix) throw new Error('edge has no screen transform')
    const screen = point.matrixTransform(matrix)
    return { x: screen.x, y: screen.y }
  })
  await page.mouse.click(edgePoint.x, edgePoint.y)
  const selectedWires = page.locator('.g-selected-edge-layer .g-edge.hl')
  await expect.poll(() => selectedWires.count()).toBeGreaterThan(0)
  await resynthesize()
  await expect(selectedWires).toHaveCount(0)
})
