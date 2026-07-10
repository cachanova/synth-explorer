import { describe, expect, it } from 'vitest'
import {
  analysisNeedsRefresh,
  normalizeSourceSelection,
  queuedSynthesisForRequest,
  retainQueuedSynthesis,
  synthesisInput,
} from './lib/liveAnalysis'

describe('synthesis input identity', () => {
  it('changes for every value sent to synthesis', () => {
    const base = synthesisInput(
      [{ name: 'top.sv', content: 'module top; endmodule' }],
      'top',
      'gates',
      '',
    )

    expect(
      synthesisInput(
        [{ name: 'top.sv', content: 'module top; wire x; endmodule' }],
        'top',
        'gates',
        '',
      ).key,
    ).not.toBe(base.key)
    expect(
      synthesisInput(base.request.files, 'other', 'gates', '').key,
    ).not.toBe(base.key)
    expect(
      synthesisInput(base.request.files, 'top', 'lut6', '').key,
    ).not.toBe(base.key)
    expect(
      synthesisInput(base.request.files, 'top', 'gates', '-flatten').key,
    ).not.toBe(base.key)
  })

  it('uses the normalized request as the identity', () => {
    const files = [{ name: 'top.sv', content: 'module top; endmodule' }]
    expect(synthesisInput(files, '  top  ', 'gates', '  -flatten ').key).toBe(
      synthesisInput(files, 'top', 'gates', '-flatten').key,
    )
  })
})

describe('source selection normalization', () => {
  it('supports forward and backward multiline selections', () => {
    expect(normalizeSourceSelection('top.sv', 18, 12)).toEqual({
      file: 'top.sv',
      startLine: 12,
      endLine: 18,
    })
  })

  it('never emits a line below one', () => {
    expect(normalizeSourceSelection('top.sv', 0, -4)).toEqual({
      file: 'top.sv',
      startLine: 1,
      endLine: 1,
    })
  })
})

describe('latest-only synthesis queue', () => {
  const input = (content: string) =>
    synthesisInput([{ name: 'top.sv', content }], 'top', 'gates', '')

  it('replaces the bounded slot with the latest requested input', () => {
    const running = input('A')
    const newest = input('C')

    expect(queuedSynthesisForRequest(running.key, newest)).toBe(newest)
  })

  it('discards a queued edit when the current input reverts to the running input', () => {
    const running = input('A')
    const obsolete = input('B')

    expect(retainQueuedSynthesis(obsolete, running.key)).toBeNull()
    expect(queuedSynthesisForRequest(running.key, running)).toBeNull()
  })

  it('discards a queued input when a newer edit is still inside the idle window', () => {
    const queued = input('B')
    const current = input('C')

    expect(retainQueuedSynthesis(queued, current.key)).toBeNull()
    expect(retainQueuedSynthesis(current, current.key)).toBe(current)
  })

  it('refreshes when an obsolete request is running even if the last design matches', () => {
    const current = input('A')
    const obsoleteRunning = input('B')

    expect(
      analysisNeedsRefresh(current.key, current.key, obsoleteRunning.key),
    ).toBe(true)
    expect(analysisNeedsRefresh(current.key, current.key, current.key)).toBe(false)
  })
})
