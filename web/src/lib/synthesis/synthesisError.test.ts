import { describe, expect, it } from 'vitest'
import { LocalSynthesisError, isResourceFailure } from './synthesisError'

describe('isResourceFailure', () => {
  it('treats synthesis timeouts and resource exhaustion as resource failures', () => {
    expect(isResourceFailure(new LocalSynthesisError('yosys timed out', '', 'timeout'))).toBe(true)
    expect(isResourceFailure(new LocalSynthesisError('yosys failed', 'std::bad_alloc'))).toBe(true)
    expect(
      isResourceFailure(new LocalSynthesisError('yosys failed', 'Out of memory in pass')),
    ).toBe(true)
  })

  it('never treats an engine load failure as a resource failure', () => {
    // A network error mentioning a timeout or memory must not trigger the
    // abstract-memory retry, which would cache a degraded synthesis.
    expect(
      isResourceFailure(
        new LocalSynthesisError('failed to load Yosys: The request timed out.', '', 'load'),
      ),
    ).toBe(false)
    expect(
      isResourceFailure(new LocalSynthesisError('failed to load Yosys: out of memory', '', 'load')),
    ).toBe(false)
  })

  it('leaves ordinary synthesis failures and foreign errors alone', () => {
    expect(isResourceFailure(new LocalSynthesisError('yosys failed', 'syntax error'))).toBe(false)
    expect(isResourceFailure(new Error('timed out'))).toBe(false)
  })
})
