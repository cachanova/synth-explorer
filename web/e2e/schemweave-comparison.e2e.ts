import { expect, test } from '@playwright/test'

const comparisonURL = 'http://127.0.0.1:5178'
test.skip(
  process.env.PLAYWRIGHT_BASE_URL !== comparisonURL,
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
