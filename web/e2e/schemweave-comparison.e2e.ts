import { expect, test } from '@playwright/test'

const comparisonURL = process.env.PLAYWRIGHT_BASE_URL
test.skip(
  !comparisonURL || comparisonURL === 'http://127.0.0.1:4173',
  'runs only against the explicit local SchemWeave comparison server',
)

test('priority encoder carries and renders every live boundary bundle', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const layoutRequests: unknown[] = []
    const analysisResponses: unknown[] = []
    Object.defineProperty(window, '__schemWeaveLayoutRequests', {
      value: layoutRequests,
    })
    Object.defineProperty(window, '__analysisResponses', {
      value: analysisResponses,
    })
    const NativeWorker = window.Worker
    window.Worker = class extends NativeWorker {
      private readonly comparisonWorker: boolean

      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        this.comparisonWorker = String(url).includes('schemweave')
        if (String(url).includes('analysis.worker')) {
          this.addEventListener('message', (event) => {
            analysisResponses.push(structuredClone(event.data))
          })
        }
      }

      override postMessage(
        message: unknown,
        transfer?: Transferable[],
      ): void {
        if (this.comparisonWorker) {
          layoutRequests.push(structuredClone(message))
        }
        if (transfer) super.postMessage(message, transfer)
        else super.postMessage(message)
      }
    }
  })

  await page.goto('/?layout=schemweave')
  await page.getByLabel('Bundled example').selectOption('priority_encoder_case')
  await expect(page.locator('.pane-right')).toHaveAttribute(
    'data-analysis-state',
    'current',
  )
  await page.getByRole('tab', { name: 'Schematic', exact: true }).click()

  await expect.poll(() => page.evaluate(() => {
    const responses = (
      window as unknown as {
        __analysisResponses: Array<{
          result?: {
            nodes?: Array<{
              id: number
              member_count?: number
              boundary_members?: unknown[]
            }>
            edges?: Array<{
              source_boundary_members?: unknown[]
              target_boundary_members?: unknown[]
            }>
          }
        }>
      }
    ).__analysisResponses
    return responses.flatMap((response) => {
      if (!response.result?.nodes || !response.result.edges) return []
      const nodes = response.result.nodes
        .filter((node) => node.boundary_members?.length)
        .map((node) => ({
          id: node.id,
          width: node.member_count,
          members: node.boundary_members?.length,
        }))
      const sourceEdges = response.result.edges.filter(
        (edge) => edge.source_boundary_members?.length,
      ).length
      const targetEdges = response.result.edges.filter(
        (edge) => edge.target_boundary_members?.length,
      ).length
      return nodes.length > 0 ? [{ nodes, sourceEdges, targetEdges }] : []
    }).at(-1)
  })).toEqual({
    nodes: [
      { id: 218, width: 5, members: 5 },
      { id: 219, width: 32, members: 32 },
      { id: 220, width: 32, members: 32 },
    ],
    sourceEdges: 72,
    targetEdges: 37,
  })

  await expect.poll(() => page.evaluate(() => {
    const messages = (
      window as unknown as {
        __schemWeaveLayoutRequests: Array<{
          request?: {
            constraints?: {
              boundary_bundles?: Array<{
                id: number
                width: number
                members: unknown[]
              }>
            }
          }
        }>
      }
    ).__schemWeaveLayoutRequests
    return messages.at(-1)?.request?.constraints?.boundary_bundles?.map(
      (bundle) => ({
        id: bundle.id,
        width: bundle.width,
        members: bundle.members.length,
      }),
    )
  })).toEqual([
    { id: 0, width: 32, members: 72 },
    { id: 1, width: 5, members: 5 },
    { id: 2, width: 32, members: 32 },
  ])

  const bundles = page.locator('[data-boundary-bundle-id]')
  await expect(bundles).toHaveCount(3)
  await expect(
    page.locator('[data-boundary-bundle-id="0"] .g-bus-label'),
  ).toHaveText('32')
  await expect(
    page.locator('[data-boundary-bundle-id="2"] .g-bus-label'),
  ).toHaveText('32')
  await expect(page.locator('.graph-error')).toHaveCount(0)
})

for (const example of [
  'priority_encoder_case',
  'priority_encoder_for',
  'priority_encoder_carry',
]) {
  test(`${example} keeps strict LUT4 boundary cohorts`, async ({ page }) => {
    await page.addInitScript(() => {
      const requests: unknown[] = []
      const responses: unknown[] = []
      Object.defineProperty(window, '__strictSchemRequests', {
        value: requests,
      })
      Object.defineProperty(window, '__strictSchemResponses', {
        value: responses,
      })
      const NativeWorker = window.Worker
      window.Worker = class extends NativeWorker {
        private readonly comparisonWorker: boolean

        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options)
          this.comparisonWorker = String(url).includes('schemweave')
          if (this.comparisonWorker) {
            this.addEventListener('message', (event) => {
              responses.push(structuredClone(event.data))
            })
          }
        }

        override postMessage(
          message: unknown,
          transfer?: Transferable[],
        ): void {
          if (this.comparisonWorker) requests.push(structuredClone(message))
          if (transfer) super.postMessage(message, transfer)
          else super.postMessage(message)
        }
      }
    })

    await page.goto('/?layout=schemweave')
    await page.getByLabel('Bundled example').selectOption(example)
    await page.getByLabel('Platform').selectOption('lut4')
    await page.getByRole('tab', { name: 'Schematic', exact: true }).click()

    await expect.poll(() => page.evaluate(() => {
      const state = window as unknown as {
        __strictSchemRequests: Array<{ id?: number }>
        __strictSchemResponses: Array<{ id?: number; ok?: boolean }>
      }
      const request = state.__strictSchemRequests.at(-1)
      const response = state.__strictSchemResponses.at(-1)
      return {
        settled:
          request?.id != null &&
          response?.id != null &&
          request.id === response.id,
        ok: response?.ok,
      }
    })).toEqual({
      settled: true,
      ok: true,
    })

    const strict = await page.evaluate(() => {
      const state = window as unknown as {
        __strictSchemRequests: Array<{
          id: number
          request?: {
            graph?: { edges?: unknown[] }
            constraints?: {
              boundary_bundles?: Array<{
                id: number
                width: number
                members: unknown[]
              }>
            }
          }
        }>
        __strictSchemResponses: Array<{
          id: number
          ok: boolean
          fallback?: string
          result?: {
            boundary_bundles?: Array<{
              id: number
              width: number
              members: unknown[]
            }>
          }
        }>
      }
      const request = state.__strictSchemRequests.at(-1)!
      const response = state.__strictSchemResponses.at(-1)!
      return {
        sameRequest: request.id === response.id,
        requestEdges: request.request?.graph?.edges?.length ?? 0,
        requested: request.request?.constraints?.boundary_bundles?.map(
          (bundle) => ({
            id: bundle.id,
            width: bundle.width,
            members: bundle.members.length,
          }),
        ),
        responseOk: response.ok,
        fallback: response.fallback ?? null,
        returned: response.result?.boundary_bundles?.map((bundle) => ({
          id: bundle.id,
          width: bundle.width,
          members: bundle.members.length,
        })),
      }
    })

    expect(strict.sameRequest).toBe(true)
    expect(strict.requestEdges).toBeGreaterThan(0)
    expect(strict.requested).toHaveLength(3)
    expect(strict.responseOk).toBe(true)
    expect(strict.fallback).toBeNull()
    expect(strict.returned).toEqual(strict.requested)
    await expect(page.locator('.graph-error')).toHaveCount(0)
  })
}

test('group expansion uses Rust in place and collapse restores without layout', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const requests: unknown[] = []
    const responses: unknown[] = []
    Object.defineProperty(window, '__schemExpansionRequests', {
      value: requests,
    })
    Object.defineProperty(window, '__schemExpansionResponses', {
      value: responses,
    })
    const NativeWorker = window.Worker
    window.Worker = class extends NativeWorker {
      private readonly comparisonWorker: boolean

      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        this.comparisonWorker = String(url).includes('schemweave')
        if (this.comparisonWorker) {
          this.addEventListener('message', (event) => {
            responses.push(structuredClone(event.data))
          })
        }
      }

      override postMessage(
        message: unknown,
        transfer?: Transferable[],
      ): void {
        if (this.comparisonWorker) requests.push(structuredClone(message))
        if (transfer) super.postMessage(message, transfer)
        else super.postMessage(message)
      }
    }
  })

  await page.goto('/?layout=schemweave')
  await page.getByLabel('Bundled example').selectOption('fifo_pipe')
  await page.getByLabel('Platform').selectOption('gates')
  await expect(page.locator('.pane-right')).toHaveAttribute(
    'data-analysis-state',
    'current',
  )
  await page.getByRole('tab', { name: 'Schematic', exact: true }).click()

  const grouped = page.locator(
    '.g-node-body.g-symbol-reg[data-member-count="3"]' +
      '[data-node-tooltip*="with_stages.valid"]',
  )
  await expect(grouped).toHaveCount(1)
  const groupId = await grouped.getAttribute('data-graph-node-id')
  expect(groupId).not.toBeNull()
  const compactTransform = await grouped.getAttribute('transform')
  const toggle = page.locator(
    `[data-group-action="expand"][data-group-id="${groupId}"]`,
  )

  await toggle.click()
  const members = page.locator(`[data-expanded-group-member="${groupId}"]`)
  await expect(members).toHaveCount(3)
  await expect.poll(() => page.evaluate(() => {
    const state = window as unknown as {
      __schemExpansionRequests: Array<{ id: number; kind?: string }>
      __schemExpansionResponses: Array<{
        id: number
        ok: boolean
        result?: { status?: string; reason?: string }
      }>
    }
    const request = state.__schemExpansionRequests
      .findLast((entry) => entry.kind === 'expand')
    const response = request
      ? state.__schemExpansionResponses.findLast(
          (entry) => entry.id === request.id,
        )
      : undefined
    return {
      requested: request != null,
      ok: response?.ok,
      status: response?.result?.status,
      reason: response?.result?.reason ?? null,
    }
  })).toEqual({
    requested: true,
    ok: true,
    status: 'layout',
    reason: null,
  })
  await expect.poll(async () => {
    return members.evaluateAll((nodes) =>
      nodes.map((node) => {
        const box = node.getBoundingClientRect()
        return {
          id: Number(node.getAttribute('data-graph-node-id')),
          center: box.left + box.width / 2,
        }
      })
        .sort((left, right) => left.center - right.center)
        .map(({ id }) => id),
    )
  }).toEqual([83, 82, 81])
  const groupBoundary = page.locator('.g-expanded-group-boundary')
  await expect(groupBoundary).toHaveCount(1)
  const [paneBox, groupBox] = await Promise.all([
    page.locator('.pane-right').boundingBox(),
    groupBoundary.boundingBox(),
  ])
  expect(paneBox).not.toBeNull()
  expect(groupBox).not.toBeNull()
  expect(groupBox!.x).toBeGreaterThanOrEqual(paneBox!.x)
  expect(groupBox!.x + groupBox!.width)
    .toBeLessThanOrEqual(paneBox!.x + paneBox!.width)
  await expect(page.locator('.graph-error')).toHaveCount(0)

  const requestCount = await page.evaluate(() =>
    (window as unknown as { __schemExpansionRequests: unknown[] })
      .__schemExpansionRequests.length
  )
  await page.locator(
    `[data-group-action="collapse"][data-group-id="${groupId}"]`,
  ).first().click()
  await expect(grouped).toHaveAttribute('transform', compactTransform ?? '')
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __schemExpansionRequests: unknown[] })
      .__schemExpansionRequests.length
  )).toBe(requestCount)
})

test('focused register expansion keeps its grid shape and keepout', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const requests: unknown[] = []
    Object.defineProperty(window, '__focusedExpansionRequests', {
      value: requests,
    })
    const NativeWorker = window.Worker
    window.Worker = class extends NativeWorker {
      private readonly comparisonWorker: boolean

      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        this.comparisonWorker = String(url).includes('schemweave')
      }

      override postMessage(
        message: unknown,
        transfer?: Transferable[],
      ): void {
        if (this.comparisonWorker) requests.push(structuredClone(message))
        if (transfer) super.postMessage(message, transfer)
        else super.postMessage(message)
      }
    }
  })

  await page.goto('/?layout=schemweave')
  await page.getByLabel('Bundled example').selectOption('reg_mux')
  await page.getByLabel('Platform').selectOption('gates')
  await expect(page.locator('.pane-right')).toHaveAttribute(
    'data-analysis-state',
    'current',
  )
  await page.getByRole('tab', { name: 'Schematic', exact: true }).click()

  const grouped = page.locator(
    '.g-node-body.g-symbol-reg[data-member-count="8"]',
  )
  await expect(grouped).toHaveCount(1)
  const groupId = await grouped.getAttribute('data-graph-node-id')
  expect(groupId).not.toBeNull()
  await grouped.hover()
  await page.locator(
    `[data-group-action="expand"][data-group-id="${groupId}"]`,
  ).click()

  const members = page.locator(`[data-expanded-group-member="${groupId}"]`)
  await expect(members).toHaveCount(8)
  const gridShape = () => page.evaluate((expandedGroupId) => {
    const positions = [
      ...document.querySelectorAll<SVGGElement>(
        `[data-expanded-group-member="${expandedGroupId}"]`,
      ),
    ].map((node) => {
      const matrix = node.transform.baseVal.consolidate()?.matrix
      if (!matrix) throw new Error('expanded member has no transform')
      return {
        x: Math.round(matrix.e * 1_000) / 1_000,
        y: Math.round(matrix.f * 1_000) / 1_000,
      }
    })
    return {
      columns: new Set(positions.map(({ x }) => x)).size,
      rows: new Set(positions.map(({ y }) => y)).size,
    }
  }, groupId)
  const originalShape = await gridShape()
  expect(originalShape.columns).toBeGreaterThan(1)
  expect(originalShape.rows).toBeGreaterThan(1)

  const output = page.locator(
    '.g-node-body.g-symbol-port-out[data-node-tooltip="q[7:0]"]',
  )
  await expect(output).toHaveCount(1)
  await output.focus()
  await output.press('Enter')
  await page.getByRole('button', { name: 'Fanin cone' }).click()

  await expect(members).toHaveCount(8)
  await expect.poll(gridShape).toEqual(originalShape)
  await expect(page.locator('.graph-error')).toHaveCount(0)
  await expect(page.locator('.g-expanded-group-boundary')).toHaveCount(1)

  const containment = await page.evaluate((expandedGroupId) => {
    const boundary = document.querySelector<SVGRectElement>(
      '.g-expanded-group-boundary',
    )?.getBoundingClientRect()
    if (!boundary) {
      return { membersInside: false, overlappingOutsiders: ['missing frame'] }
    }
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
      return overlaps
        ? [node.dataset.nodeTooltip ?? node.dataset.graphNodeId ?? '?']
        : []
    })
    return { membersInside, overlappingOutsiders }
  }, groupId)
  expect(containment).toEqual({
    membersInside: true,
    overlappingOutsiders: [],
  })

  const expansionReferences = await page.evaluate(() =>
    (
      window as unknown as {
        __focusedExpansionRequests: Array<{
          kind?: string
          request?: { reference_height?: number }
        }>
      }
    ).__focusedExpansionRequests
      .filter((message) => message.kind === 'expand')
      .map((message) => message.request?.reference_height),
  )
  expect(expansionReferences.length).toBeGreaterThanOrEqual(2)
  expect(new Set(expansionReferences).size).toBe(1)
})
