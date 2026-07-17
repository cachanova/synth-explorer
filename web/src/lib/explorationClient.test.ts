import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExplorationWorkerRequest, ExplorationWorkerResponse } from '../workers/exploration.worker'

const { localExploration } = vi.hoisted(() => ({ localExploration: vi.fn() }))
vi.mock('./localEngine', () => ({ localExploration }))

import { initializeExploration, resetExploration } from './explorationClient'

class FakeWorker {
  static instances: FakeWorker[] = []

  onmessage: ((event: MessageEvent<ExplorationWorkerResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  messages: ExplorationWorkerRequest[] = []
  terminated = false

  constructor() {
    FakeWorker.instances.push(this)
  }

  postMessage(message: ExplorationWorkerRequest) {
    this.messages.push(message)
  }

  terminate() {
    this.terminated = true
  }

  reply(response: ExplorationWorkerResponse) {
    this.onmessage?.({ data: response } as MessageEvent<ExplorationWorkerResponse>)
  }
}

describe('exploration worker lifecycle', () => {
  beforeEach(() => {
    resetExploration()
    FakeWorker.instances = []
    vi.stubGlobal('Worker', FakeWorker)
    localExploration.mockImplementation((id: string) =>
      Promise.resolve({ design_id: id } as never),
    )
  })

  afterEach(() => {
    resetExploration()
    vi.unstubAllGlobals()
  })

  it('replaces stale design initialization without reusing its worker', async () => {
    const first = initializeExploration('first/design')
    const firstWorker = FakeWorker.instances[0]
    await vi.waitFor(() => expect(firstWorker.messages).toHaveLength(1))
    expect(firstWorker.messages[0]).toMatchObject({
      kind: 'initialize',
      snapshot: { design_id: 'first/design' },
    })

    const second = initializeExploration('second/design')
    const secondWorker = FakeWorker.instances[1]
    expect(firstWorker.terminated).toBe(true)
    await expect(first).rejects.toThrow('exploration worker reset')
    await vi.waitFor(() => expect(secondWorker.messages).toHaveLength(1))
    expect(secondWorker.messages[0]).toMatchObject({
      kind: 'initialize',
      snapshot: { design_id: 'second/design' },
    })

    const request = secondWorker.messages[0]
    secondWorker.reply({ id: request.id, ok: true, result: null })
    await expect(second).resolves.toBeUndefined()
  })
})
