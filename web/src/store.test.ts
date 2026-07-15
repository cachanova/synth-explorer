import { describe, expect, it } from 'vitest'
import {
  normalizeSourceSelection,
  queuedSynthesisForRequest,
  retainQueuedSynthesis,
  synthesisInput,
} from './lib/liveAnalysis'
import { buildSynthesizeRequest } from './lib/synthesize'

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
    const input = synthesisInput(files, '  top  ', 'gates', '  -flatten ')

    expect(input.request).toEqual(
      buildSynthesizeRequest(files, '  top  ', 'gates', '  -flatten '),
    )
    expect(input.key).toBe(
      synthesisInput(files, 'top', 'gates', '-flatten').key,
    )
  })

  it('keeps stable request identity separate from the cheap edit revision', () => {
    const files = [{ name: 'top.sv', content: 'module top; endmodule' }]
    const first = synthesisInput(files, 'top', 'gates', '', 2)
    const reverted = synthesisInput(files, 'top', 'gates', '', 9)

    expect(first.key).toBe(reverted.key)
    expect(first.revision).toBe(2)
    expect(reverted.revision).toBe(9)
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
  const input = (content: string, revision: number) =>
    synthesisInput([{ name: 'top.sv', content }], 'top', 'gates', '', revision)

  it('replaces the bounded slot with the latest requested input', () => {
    const running = input('A', 1)
    const newest = input('C', 3)

    expect(queuedSynthesisForRequest(running.key, newest)).toEqual(newest)
  })

  it('discards a queued edit when the current input reverts to the running input', () => {
    const running = input('A', 1)
    const obsolete = input('B', 2)
    const queued = queuedSynthesisForRequest(running.key, obsolete)

    expect(retainQueuedSynthesis(queued, running.revision)).toBeNull()
    expect(retainQueuedSynthesis(queued, obsolete.revision)).toBe(queued)
    expect(queuedSynthesisForRequest(running.key, running)).toBeNull()
  })

  it('discards a queued input after a newer edit', () => {
    const inputB = input('B', 2)
    const current = input('C', 3)
    const queued = queuedSynthesisForRequest('running', inputB)
    const currentQueue = queuedSynthesisForRequest('running', current)

    expect(retainQueuedSynthesis(queued, current.revision)).toBeNull()
    expect(retainQueuedSynthesis(currentQueue, current.revision)).toBe(currentQueue)
  })

  it('does not queue an exact revert to the running request', () => {
    const running = synthesisInput(
      [{ name: 'top.sv', content: 'A' }],
      'top',
      'gates',
      '',
      1,
    )
    const reverted = synthesisInput(
      [{ name: 'top.sv', content: 'A' }],
      'top',
      'gates',
      '',
      3,
    )

    expect(queuedSynthesisForRequest(running.key, reverted)).toBeNull()
  })
})
