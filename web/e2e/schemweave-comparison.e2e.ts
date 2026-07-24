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
    const layoutResponses: unknown[] = []
    const analysisResponses: unknown[] = []
    Object.defineProperty(window, '__schemWeaveLayoutRequests', {
      value: layoutRequests,
    })
    Object.defineProperty(window, '__schemWeaveLayoutResponses', {
      value: layoutResponses,
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
        if (this.comparisonWorker) {
          this.addEventListener('message', (event) => {
            layoutResponses.push(structuredClone(event.data))
          })
        }
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
        __schemWeaveLayoutResponses: Array<{
          result?: {
            geometry?: {
              boundaryBundles?: Array<{
                id: number
                width: number
                ownerIndexes: unknown[]
              }>
            }
          }
        }>
      }
    ).__schemWeaveLayoutResponses
    return messages.at(-1)?.result?.geometry?.boundaryBundles?.map(
      (bundle) => ({
        id: bundle.id,
        width: bundle.width,
        members: bundle.ownerIndexes.length,
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

for (const [example, expectedBundles] of [
  [
    'priority_encoder_case',
    [
      { id: 0, width: 32, members: 105 },
      { id: 1, width: 5, members: 5 },
      { id: 2, width: 32, members: 32 },
    ],
  ],
  [
    'priority_encoder_for',
    [
      { id: 0, width: 32, members: 98 },
      { id: 1, width: 5, members: 5 },
      { id: 2, width: 32, members: 32 },
    ],
  ],
  [
    'priority_encoder_carry',
    [
      { id: 0, width: 32, members: 106 },
      { id: 1, width: 5, members: 5 },
      { id: 2, width: 32, members: 32 },
    ],
  ],
] as const) {
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
          input?: {
            nodes?: Array<{
              boundaryWidth?: number
              boundaryMembers?: unknown[]
            }>
            edges?: unknown[]
          }
        }>
        __strictSchemResponses: Array<{
          id: number
          ok: boolean
          result?: {
            status?: string
            degraded?: boolean
            geometry?: {
              boundaryBundles?: Array<{
                id: number
                width: number
                ownerIndexes: unknown[]
              }>
            }
          }
        }>
      }
      const request = state.__strictSchemRequests.at(-1)!
      const response = state.__strictSchemResponses.at(-1)!
      return {
        sameRequest: request.id === response.id,
        requestEdges: request.input?.edges?.length ?? 0,
        requestedWidths: request.input?.nodes
          ?.filter((node) => node.boundaryMembers?.length)
          .map((node) => node.boundaryWidth)
          .sort((left, right) => (left ?? 0) - (right ?? 0)),
        responseOk: response.ok,
        fallback: response.result?.degraded ? 'boundary-bundles-omitted' : null,
        returned: response.result?.geometry?.boundaryBundles?.map((bundle) => ({
          id: bundle.id,
          width: bundle.width,
          members: bundle.ownerIndexes.length,
        })),
      }
    })
    expect(strict.sameRequest).toBe(true)
    expect(strict.requestEdges).toBeGreaterThan(0)
    expect(strict.requestedWidths).toHaveLength(3)
    expect(strict.responseOk).toBe(true)
    expect(strict.fallback).toBeNull()
    expect(strict.returned).toEqual(expectedBundles)
    expect(strict.returned?.map((bundle) => bundle.width).sort(
      (left, right) => left - right,
    )).toEqual(strict.requestedWidths)
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

test('an evicted worker session rebuilds the compact base and preserves expansion', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const requests: unknown[] = []
    const responses: unknown[] = []
    Object.defineProperty(window, '__evictedSessionRequests', {
      value: requests,
    })
    Object.defineProperty(window, '__evictedSessionResponses', {
      value: responses,
    })
    const NativeWorker = window.Worker
    window.Worker = class extends NativeWorker {
      private readonly comparisonWorker: boolean
      private invalidated = false

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
        const request = message as {
          kind?: string
          session?: { sessionEpoch: string; sessionId: number }
        }
        const outgoing =
          this.comparisonWorker &&
            request.kind === 'expand' &&
            request.session &&
            !this.invalidated
            ? {
                ...request,
                session: {
                  ...request.session,
                  sessionId: Number.MAX_SAFE_INTEGER,
                },
              }
            : message
        if (outgoing !== message) this.invalidated = true
        if (this.comparisonWorker) requests.push(structuredClone(outgoing))
        if (transfer) super.postMessage(outgoing, transfer)
        else super.postMessage(outgoing)
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
  await page.locator(
    `[data-group-action="expand"][data-group-id="${groupId}"]`,
  ).click()

  await expect(
    page.locator(`[data-expanded-group-member="${groupId}"]`),
  ).toHaveCount(3)
  await expect.poll(() => page.evaluate(() => {
    const state = window as unknown as {
      __evictedSessionRequests: Array<{ id: number; kind?: string }>
      __evictedSessionResponses: Array<{
        id: number
        result?: { status?: string; reason?: string }
      }>
    }
    const requests = state.__evictedSessionRequests
    const expansionResponses = requests
      .filter((request) => request.kind === 'expand')
      .map((request) => state.__evictedSessionResponses.find(
        (response) => response.id === request.id,
      ))
    return {
      layouts: requests.filter((request) => request.kind === 'layout').length,
      expansions: expansionResponses.map((response) => ({
        status: response?.result?.status,
        reason: response?.result?.reason ?? null,
      })),
    }
  })).toEqual({
    layouts: 2,
    expansions: [
      { status: 'needs_full_relayout', reason: 'geometry' },
      { status: 'layout', reason: null },
    ],
  })
  await expect(page.locator('.g-expanded-group-boundary')).toHaveCount(1)
  await expect(page.locator('.graph-error')).toHaveCount(0)
})

test('multiple groups preserve independent expansion state in any toggle order', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const requests: unknown[] = []
    const analysisRequests: unknown[] = []
    Object.defineProperty(window, '__multiGroupSchemRequests', {
      value: requests,
    })
    Object.defineProperty(window, '__multiGroupAnalysisRequests', {
      value: analysisRequests,
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
        const request = message as { kind?: string; method?: string }
        if (request.kind === 'query' && request.method === 'expandGroup') {
          analysisRequests.push(structuredClone(message))
        }
        if (this.comparisonWorker) requests.push(structuredClone(message))
        if (transfer) super.postMessage(message, transfer)
        else super.postMessage(message)
      }
    }
  })
  await page.goto('/?layout=schemweave')
  await page.getByLabel('Bundled example').selectOption('reg_mux')
  await page.getByLabel('Platform').selectOption('gates')
  await page.getByRole('tab', { name: 'Schematic', exact: true }).click()

  const register = page.locator(
    '.g-node-body.g-symbol-reg[data-member-count="8"]',
  )
  const mux = page.locator(
    '.g-node-body.g-symbol-mux[data-member-count="8"]',
  )
  await expect(register).toHaveCount(1)
  await expect(mux).toHaveCount(1)
  const registerId = await register.getAttribute('data-graph-node-id')
  const muxId = await mux.getAttribute('data-graph-node-id')
  expect(registerId).not.toBeNull()
  expect(muxId).not.toBeNull()

  for (const [group, id] of [
    [register, registerId],
    [mux, muxId],
  ] as const) {
    await group.hover()
    await page.locator(
      `[data-group-action="expand"][data-group-id="${id}"]`,
    ).click()
    await expect(
      page.locator(`[data-expanded-group-member="${id}"]`),
    ).toHaveCount(8)
  }
  const expansionRequestCount = () => page.evaluate(() =>
    (
      window as unknown as {
        __multiGroupSchemRequests: Array<{ kind?: string }>
      }
    ).__multiGroupSchemRequests.filter((request) => request.kind === 'expand')
      .length
  )
  const collapseRequestCount = () => page.evaluate(() =>
    (
      window as unknown as {
        __multiGroupSchemRequests: Array<{ kind?: string }>
      }
    ).__multiGroupSchemRequests.filter((request) => request.kind === 'collapse')
      .length
  )
  const analysisRequestCount = () => page.evaluate(() =>
    (
      window as unknown as {
        __multiGroupAnalysisRequests: unknown[]
      }
    ).__multiGroupAnalysisRequests.length
  )
  const muxMemberGeometry = () =>
    page.locator(`[data-expanded-group-member="${muxId}"]`)
      .evaluateAll((nodes) => nodes.map((node) => ({
        id: node.getAttribute('data-graph-node-id'),
        transform: node.getAttribute('transform'),
      })).sort((left, right) => (left.id ?? '').localeCompare(right.id ?? '')))
  expect(await expansionRequestCount()).toBe(2)
  expect(await collapseRequestCount()).toBe(0)
  expect(await analysisRequestCount()).toBe(2)
  await expect(page.locator('.g-expanded-group-boundary')).toHaveCount(2)
  await expect(page.locator('.msg.err')).toHaveCount(0)
  const muxGeometryBeforeRegisterCollapse = await muxMemberGeometry()

  const activateWithKeyboard = async (
    selector: string,
  ) => {
    await page.locator(selector).first().evaluate((control) => {
      control.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
      }))
    })
  }
  await activateWithKeyboard(
    `[data-group-action="collapse"][data-group-id="${registerId}"]`,
  )
  await expect(
    page.locator(`[data-expanded-group-member="${registerId}"]`),
  ).toHaveCount(0)
  await expect(
    page.locator(`[data-expanded-group-member="${muxId}"]`),
  ).toHaveCount(8)
  expect({
    expand: await expansionRequestCount(),
    collapse: await collapseRequestCount(),
  }).toEqual({ expand: 2, collapse: 1 })
  expect(await analysisRequestCount()).toBe(3)
  expect(await muxMemberGeometry()).toEqual(muxGeometryBeforeRegisterCollapse)
  await expect(page.locator('.g-expanded-group-boundary')).toHaveCount(1)
  await expect(page.locator('.msg.err')).toHaveCount(0)

  await activateWithKeyboard(
    `[data-group-action="expand"][data-group-id="${registerId}"]`,
  )
  await expect(
    page.locator(`[data-expanded-group-member="${registerId}"]`),
  ).toHaveCount(8)
  await expect(
    page.locator(`[data-expanded-group-member="${muxId}"]`),
  ).toHaveCount(8)
  expect(await expansionRequestCount()).toBe(2)
  expect(await collapseRequestCount()).toBe(1)
  expect(await analysisRequestCount()).toBe(3)
  await expect(page.locator('.g-expanded-group-boundary')).toHaveCount(2)
  await expect(page.locator('.msg.err')).toHaveCount(0)

  for (const id of [registerId, muxId]) {
    await activateWithKeyboard(
      `[data-group-action="collapse"][data-group-id="${id}"]`,
    )
  }
  await expect(page.locator('.g-expanded-group-boundary')).toHaveCount(0)

  for (const id of [muxId, registerId]) {
    await activateWithKeyboard(
      `[data-group-action="expand"][data-group-id="${id}"]`,
    )
    await expect(
      page.locator(`[data-expanded-group-member="${id}"]`),
    ).toHaveCount(8)
  }
  await expect(
    page.locator(`[data-expanded-group-member="${registerId}"]`),
  ).toHaveCount(8)
  await expect(
    page.locator(`[data-expanded-group-member="${muxId}"]`),
  ).toHaveCount(8)
  expect(await expansionRequestCount()).toBe(2)
  expect(await collapseRequestCount()).toBe(2)
  expect(await analysisRequestCount()).toBe(3)
  await expect(page.locator('.g-expanded-group-boundary')).toHaveCount(2)
  await expect(page.locator('.msg.err')).toHaveCount(0)
})

test('opening another group keeps the completed peer visible while prefixes reload', async ({
  page,
}) => {
  await page.addInitScript(() => {
    let expansionQueries = 0
    const gate: {
      pending: number
      releases: Array<() => void>
    } = {
      pending: 0,
      releases: [],
    }
    Object.defineProperty(window, '__groupPrefixReloadGate', {
      value: gate,
    })
    const NativeWorker = window.Worker
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
      }

      override postMessage(
        message: unknown,
        transfer?: Transferable[],
      ): void {
        const request = message as { kind?: string; method?: string }
        const send = () => {
          if (transfer) super.postMessage(message, transfer)
          else super.postMessage(message)
        }
        if (request.kind === 'query' && request.method === 'expandGroup') {
          expansionQueries += 1
          if (expansionQueries > 1) {
            gate.releases.push(send)
            gate.pending = gate.releases.length
            return
          }
        }
        send()
      }
    }
  })
  await page.goto('/?layout=schemweave')
  await page.getByLabel('Bundled example').selectOption('reg_mux')
  await page.getByLabel('Platform').selectOption('gates')
  await page.getByRole('tab', { name: 'Schematic', exact: true }).click()

  const register = page.locator(
    '.g-node-body.g-symbol-reg[data-member-count="8"]',
  )
  const mux = page.locator(
    '.g-node-body.g-symbol-mux[data-member-count="8"]',
  )
  await expect(register).toHaveCount(1)
  await expect(mux).toHaveCount(1)
  const registerId = await register.getAttribute('data-graph-node-id')
  const muxId = await mux.getAttribute('data-graph-node-id')
  expect(registerId).not.toBeNull()
  expect(muxId).not.toBeNull()

  const activateWithKeyboard = (selector: string) =>
    page.locator(selector).first().evaluate((control) => {
      control.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
      }))
    })
  expect(Number(muxId)).toBeGreaterThan(Number(registerId))
  await activateWithKeyboard(
    `[data-group-action="expand"][data-group-id="${muxId}"]`,
  )
  const muxMembers = page.locator(
    `[data-expanded-group-member="${muxId}"]`,
  )
  await expect(muxMembers).toHaveCount(8)
  await expect(page.locator('.g-expanded-group-boundary')).toHaveCount(1)

  await activateWithKeyboard(
    `[data-group-action="expand"][data-group-id="${registerId}"]`,
  )
  await expect.poll(() => page.evaluate(() =>
    (
      window as unknown as {
        __groupPrefixReloadGate: { pending: number }
      }
    ).__groupPrefixReloadGate.pending
  )).toBe(2)
  expect(await muxMembers.count()).toBe(8)
  expect(await page.locator('.g-expanded-group-boundary').count()).toBe(1)
  await page.evaluate(() => {
    const gate = (
      window as unknown as {
        __groupPrefixReloadGate: {
          pending: number
          releases: Array<() => void>
        }
      }
    ).__groupPrefixReloadGate
    const releases = gate.releases.splice(0)
    gate.pending = 0
    for (const release of releases) release()
  })

  await expect(
    page.locator(`[data-expanded-group-member="${registerId}"]`),
  ).toHaveCount(8)
  await expect(muxMembers).toHaveCount(8)
  await expect(page.locator('.g-expanded-group-boundary')).toHaveCount(2)
  await expect(page.locator('.msg.err')).toHaveCount(0)
})

test('middle collapse stays incremental and preserves peer group state', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const requests: unknown[] = []
    const responses: unknown[] = []
    Object.defineProperty(window, '__threeGroupSchemRequests', {
      value: requests,
    })
    Object.defineProperty(window, '__threeGroupSchemResponses', {
      value: responses,
    })
    const NativeWorker = window.Worker
    window.Worker = class extends NativeWorker {
      private readonly comparisonWorker: boolean

      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        const workerUrl = String(url)
        this.comparisonWorker = workerUrl.includes('schemweave')
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
        const request = message as {
          id?: number
          kind?: string
          method?: string
        }
        const send = () => {
          if (this.comparisonWorker) requests.push(structuredClone(message))
          if (transfer) super.postMessage(message, transfer)
          else super.postMessage(message)
        }
        if (
          request.kind === 'query' &&
          request.method === 'expandGroup'
        ) {
          window.setTimeout(send, 150)
          return
        }
        send()
      }
    }
  })
  await page.goto('/?layout=schemweave')
  await page.getByLabel('Bundled example').selectOption('pipe')
  await page.getByLabel('Platform').selectOption('gates')
  await page.getByRole('tab', { name: 'Schematic', exact: true }).click()

  const groups = page.locator(
    '.g-node-body.g-symbol-reg[data-member-count="16"]',
  )
  await expect(groups).toHaveCount(4)
  const targets = await groups.evaluateAll((nodes) =>
    nodes.slice(0, 3).map((node) => ({
      id: node.getAttribute('data-graph-node-id')!,
      tooltip: node.getAttribute('data-node-tooltip'),
    })),
  )
  expect(targets).toHaveLength(3)

  for (const target of targets) {
    await page.locator(
      `[data-group-action="expand"][data-group-id="${target.id}"]`,
    ).evaluate((control) => {
      control.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
      }))
    })
    await expect(
      page.locator(`[data-expanded-group-member="${target.id}"]`),
    ).toHaveCount(16)
  }
  await expect(page.locator('.g-expanded-group-boundary')).toHaveCount(3)
  for (const target of targets) {
    await expect(
      page.locator(`[data-expanded-group-member="${target.id}"]`),
    ).toHaveCount(16)
  }
  const relativeGeometry = async (id: string) => {
    const positions = await page.locator(`[data-expanded-group-member="${id}"]`)
      .evaluateAll((nodes) => nodes.map((node) => {
        const matrix = (node as SVGGElement).transform.baseVal.consolidate()?.matrix
        return {
          id: node.getAttribute('data-graph-node-id'),
          x: matrix?.e ?? 0,
          y: matrix?.f ?? 0,
        }
      }))
    const left = Math.min(...positions.map((position) => position.x))
    const top = Math.min(...positions.map((position) => position.y))
    return positions.map((position) => ({
      id: position.id,
      x: position.x - left,
      y: position.y - top,
    })).sort((first, second) =>
      (first.id ?? '').localeCompare(second.id ?? '')
    )
  }
  const gridTopology = async (id: string) => {
    const positions = await relativeGeometry(id)
    const xs = [...new Set(positions.map((position) => position.x))]
      .sort((left, right) => left - right)
    const ys = [...new Set(positions.map((position) => position.y))]
      .sort((left, right) => left - right)
    return positions.map((position) => ({
      id: position.id,
      column: xs.indexOf(position.x),
      row: ys.indexOf(position.y),
    }))
  }
  const activateWithKeyboard = (selector: string) =>
    page.locator(selector).first().evaluate((control) => {
      control.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
      }))
    })
  const requestCounts = () => page.evaluate(() => {
    const state = (
      window as unknown as {
        __threeGroupSchemRequests: Array<{ kind?: string }>
        __threeGroupSchemResponses: Array<{
          id?: number
          result?: { status?: string; reason?: string }
        }>
      }
    )
    const requests = state.__threeGroupSchemRequests
    const collapse = requests.findLast((request) => request.kind === 'collapse') as
      { id?: number } | undefined
    const collapseResponse = state.__threeGroupSchemResponses.findLast(
      (response) => response.id === collapse?.id,
    )
    return {
      layout: requests.filter((request) => request.kind === 'layout').length,
      expand: requests.filter((request) => request.kind === 'expand').length,
      collapse: requests.filter((request) => request.kind === 'collapse').length,
      collapseStatus: collapseResponse?.result?.status ?? null,
      collapseReason: collapseResponse?.result?.reason ?? null,
    }
  })

  expect(await requestCounts()).toEqual({
    layout: 1,
    expand: 3,
    collapse: 0,
    collapseStatus: null,
    collapseReason: null,
  })
  const firstShapeBefore = await gridTopology(targets[0].id)
  const thirdShapeBefore = await gridTopology(targets[2].id)
  await activateWithKeyboard(
    `[data-group-action="collapse"][data-group-id="${targets[1].id}"]`,
  )
  await page.waitForTimeout(50)
  // Keep the complete prior frame visible while the collapse is in flight.
  await expect(page.locator('.g-expanded-group-boundary')).toHaveCount(3)
  await expect(
    page.locator(`[data-expanded-group-member="${targets[1].id}"]`),
  ).toHaveCount(16)
  await expect(
    page.locator(`[data-expanded-group-member="${targets[1].id}"]`),
  ).toHaveCount(0)
  expect(await requestCounts()).toEqual({
    layout: 1,
    expand: 3,
    collapse: 1,
    collapseStatus: 'layout',
    collapseReason: null,
  })
  expect(await gridTopology(targets[0].id)).toEqual(firstShapeBefore)
  expect(await gridTopology(targets[2].id)).toEqual(thirdShapeBefore)

  await activateWithKeyboard(
    `[data-group-action="collapse"][data-group-id="${targets[0].id}"]`,
  )
  await page.waitForTimeout(50)
  await expect(page.locator('.g-expanded-group-boundary')).toHaveCount(2)
  await expect(
    page.locator(`[data-expanded-group-member="${targets[0].id}"]`),
  ).toHaveCount(16)
  await expect(
    page.locator(`[data-expanded-group-member="${targets[0].id}"]`),
  ).toHaveCount(0)
  expect(await requestCounts()).toEqual({
    layout: 1,
    expand: 3,
    collapse: 2,
    collapseStatus: 'layout',
    collapseReason: null,
  })
  expect(await gridTopology(targets[2].id)).toEqual(thirdShapeBefore)
  await expect(page.locator('.g-expanded-group-boundary')).toHaveCount(1)
  await expect(page.locator('.msg.err')).toHaveCount(0)
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
