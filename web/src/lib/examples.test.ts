import { describe, expect, it } from 'vitest'
import { bundledExamples } from './examples'

describe('bundled examples', () => {
  it('provides complete Verilog and VHDL variants for every design', () => {
    const { examples } = bundledExamples()

    expect(examples).toHaveLength(14)
    expect(new Set(examples.map((example) => example.name)).size).toBe(examples.length)
    for (const example of examples) {
      expect(example.variants.verilog.files.length).toBeGreaterThan(0)
      expect(example.variants.vhdl.files.length).toBeGreaterThan(0)
      expect(example.variants.verilog.files.every((file) => /\.s?vh?$/.test(file.name))).toBe(true)
      expect(example.variants.vhdl.files.every((file) => /\.vhdl?$/.test(file.name))).toBe(true)
    }
  })
})
