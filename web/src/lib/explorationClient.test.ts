import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExplorationWorkerRequest, ExplorationWorkerResponse } from '../workers/exploration.worker'
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
  })

  afterEach(() => {
    resetExploration()
    vi.unstubAllGlobals()
  })

  it('replaces stale design initialization without reusing its worker', async () => {
    const first = initializeExploration('first/design')
    const firstWorker = FakeWorker.instances[0]
    expect(firstWorker.messages[0]).toMatchObject({
      kind: 'initialize',
      designId: 'first/design',
    })

    const second = initializeExploration('second/design')
    const secondWorker = FakeWorker.instances[1]
    expect(firstWorker.terminated).toBe(true)
    await expect(first).rejects.toThrow('exploration worker reset')
    expect(secondWorker.messages[0]).toMatchObject({
      kind: 'initialize',
      designId: 'second/design',
    })

    const request = secondWorker.messages[0]
    secondWorker.reply({ id: request.id, ok: true, result: null })
    await expect(second).resolves.toBeUndefined()
  })
})
