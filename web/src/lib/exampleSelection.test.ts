import { describe, expect, it } from 'vitest'
import {
  NO_EXAMPLE_SELECTION,
  parseStoredExampleSelection,
} from './exampleSelection'

describe('stored example selection', () => {
  it('restores the language and example the toolbar last showed', () => {
    expect(
      parseStoredExampleSelection({ language: 'vhdl', name: 'fifo' }),
    ).toEqual({ language: 'vhdl', name: 'fifo' })
  })

  it('starts on Verilog with no example chosen', () => {
    expect(NO_EXAMPLE_SELECTION).toEqual({ language: 'verilog', name: '' })
    expect(parseStoredExampleSelection(null)).toEqual(NO_EXAMPLE_SELECTION)
    expect(parseStoredExampleSelection({ language: 'vhdl' })).toEqual(
      NO_EXAMPLE_SELECTION,
    )
  })

  it('rejects a language the example set does not define', () => {
    expect(
      parseStoredExampleSelection({ language: 'chisel', name: 'fifo' }),
    ).toEqual(NO_EXAMPLE_SELECTION)
  })
})
