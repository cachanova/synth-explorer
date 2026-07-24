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
