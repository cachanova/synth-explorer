import { describe, expect, it, vi } from 'vitest'
import { createSourceTierSelectionController } from './sourceTierSelection'
import type { SourceTiersResponse } from './sourceTiers'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

const response = (line: number): SourceTiersResponse => ({
  exact: [{ file: 'top.sv', start_line: line, end_line: line }],
  contributing: [],
  approximate: false,
  truncated: false,
})

describe('selected schematic node source-tier wiring', () => {
  it('clears the old tiers and fetches the selected node ids', async () => {
    const commits: unknown[] = []
    const fetchSourceTiers = vi.fn().mockResolvedValue(response(4))
    const select = createSourceTierSelectionController(
      (value) => commits.push(value),
      fetchSourceTiers,
    )

    select({ kind: 'nodes', nodeIds: [17] })
    expect(commits).toEqual([null])
    expect(fetchSourceTiers).toHaveBeenCalledWith({
      kind: 'nodes',
      nodeIds: [17],
    })
    await Promise.resolve()
    expect(commits).toEqual([
      null,
      {
        target: { kind: 'nodes', nodeIds: [17] },
        response: response(4),
      },
    ])
  })

  it('replaces a node lookup with a net lookup and ignores the older response', async () => {
    const first = deferred<SourceTiersResponse>()
    const second = deferred<SourceTiersResponse>()
    const fetchSourceTiers = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const commits: unknown[] = []
    const select = createSourceTierSelectionController(
      (value) => commits.push(value),
      fetchSourceTiers,
    )

    select({ kind: 'nodes', nodeIds: [1] })
    select({ kind: 'nets', names: ['gated'] })
    first.resolve(response(1))
    await Promise.resolve()
    expect(commits).toEqual([null, null])

    second.resolve(response(2))
    await Promise.resolve()
    expect(commits.at(-1)).toEqual({
      target: { kind: 'nets', names: ['gated'] },
      response: response(2),
    })
  })

  it('clears on deselection and invalidates the in-flight response', async () => {
    const pending = deferred<SourceTiersResponse>()
    const commits: unknown[] = []
    const select = createSourceTierSelectionController(
      (value) => commits.push(value),
      vi.fn().mockReturnValue(pending.promise),
    )

    select({ kind: 'nets', names: ['sum'] })
    select({ kind: 'nets', names: [] })
    pending.resolve(response(9))
    await Promise.resolve()

    expect(commits).toEqual([null, null])
  })

  it('leaves tiers cleared when the lookup fails', async () => {
    const pending = deferred<SourceTiersResponse>()
    const commits: unknown[] = []
    const select = createSourceTierSelectionController(
      (value) => commits.push(value),
      vi.fn().mockReturnValue(pending.promise),
    )

    select({ kind: 'nodes', nodeIds: [3] })
    pending.reject(new Error('not wired'))
    await Promise.resolve()
    await Promise.resolve()

    expect(commits).toEqual([null, null])
  })
})
