import { afterEach, expect, it, vi } from 'vitest'
import { createLayoutWorker } from './layoutWorkerFactory'

class FakeWorker {
  static instances: FakeWorker[] = []
  readonly url: string
  readonly options: WorkerOptions | undefined

  constructor(url: string | URL, options?: WorkerOptions) {
    this.url = String(url)
    this.options = options
    FakeWorker.instances.push(this)
  }
}

afterEach(() => {
  FakeWorker.instances.length = 0
  vi.unstubAllGlobals()
})

it.each([
  ['elk', 'elk.worker.ts'],
  ['schemweave', 'schemweave.worker.ts'],
] as const)('constructs the %s module worker', (engine, entrypoint) => {
  vi.stubGlobal('Worker', FakeWorker)

  expect(createLayoutWorker(engine)).toBe(FakeWorker.instances[0])
  expect(FakeWorker.instances[0]).toMatchObject({
    url: expect.stringContaining(entrypoint),
    options: { type: 'module' },
  })
})
