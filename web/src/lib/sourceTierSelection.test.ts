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

    select([17])
    expect(commits).toEqual([null])
    expect(fetchSourceTiers).toHaveBeenCalledWith([17])
    await Promise.resolve()
    expect(commits).toEqual([
      null,
      { nodeIds: [17], response: response(4) },
    ])
  })

  it('ignores an older response after the selection changes', async () => {
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

    select([1])
    select([2])
    first.resolve(response(1))
    await Promise.resolve()
    expect(commits).toEqual([null, null])

    second.resolve(response(2))
    await Promise.resolve()
    expect(commits.at(-1)).toEqual({
      nodeIds: [2],
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

    select([9])
    select([])
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

    select([3])
    pending.reject(new Error('not wired'))
    await Promise.resolve()
    await Promise.resolve()

    expect(commits).toEqual([null, null])
  })
})
