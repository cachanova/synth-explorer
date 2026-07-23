import { expect, it, vi } from 'vitest'
import type { ElkNode } from 'elkjs/lib/elk-api'
import type { LayoutInput } from '../lib/layout'
import { runElkRequest, startElkWarmup } from './elkRuntime'

const input: LayoutInput = {
  nodes: [
    {
      id: 1,
      baseWidth: 62,
      baseHeight: 46,
      controlHeight: 0,
      register: false,
      boundary: 'internal',
    },
  ],
  edges: [],
}

function result(): ElkNode {
  return {
    id: 'root',
    width: 62,
    height: 46,
    children: [{ id: '1', x: 0, y: 0, width: 62, height: 46 }],
    edges: [],
  }
}

it('runs warmup once and holds real requests until it completes', async () => {
  let finishWarmup!: (value: ElkNode) => void
  const warmup = new Promise<ElkNode>((resolve) => {
    finishWarmup = resolve
  })
  const elk = {
    layout: vi.fn()
      .mockReturnValueOnce(warmup)
      .mockResolvedValue(result()),
  }
  const ready = startElkWarmup(elk)
  const first = runElkRequest(elk, ready, {
    id: 1,
    input,
    placement: 'NETWORK_SIMPLEX',
  })
  const second = runElkRequest(elk, ready, {
    id: 2,
    input,
    placement: 'BRANDES_KOEPF',
  })

  await Promise.resolve()
  expect(elk.layout).toHaveBeenCalledTimes(1)
  finishWarmup(result())
  await expect(first).resolves.toMatchObject({ id: 1, ok: true })
  await expect(second).resolves.toMatchObject({ id: 2, ok: true })
  expect(elk.layout).toHaveBeenCalledTimes(3)
})

it('treats warmup rejection as opportunistic and still serves real work', async () => {
  const elk = {
    layout: vi.fn()
      .mockRejectedValueOnce(new Error('warmup failed'))
      .mockResolvedValueOnce(result()),
  }
  const ready = startElkWarmup(elk)

  await expect(
    runElkRequest(elk, ready, {
      id: 7,
      input,
      placement: 'NETWORK_SIMPLEX',
    }),
  ).resolves.toMatchObject({ id: 7, ok: true })
  expect(elk.layout).toHaveBeenCalledTimes(2)
})

it('returns an explicit error when the real layout fails after warmup', async () => {
  const elk = {
    layout: vi.fn()
      .mockResolvedValueOnce(result())
      .mockRejectedValueOnce(new Error('real layout failed')),
  }
  const ready = startElkWarmup(elk)

  await expect(
    runElkRequest(elk, ready, {
      id: 9,
      input,
      placement: 'NETWORK_SIMPLEX',
    }),
  ).resolves.toEqual({ id: 9, ok: false, error: 'Error: real layout failed' })
})
