import { describe, expect, it } from 'vitest'
import {
  designSrcSpans,
  parseSrc,
  parseSrcFragment,
  spansSummary,
  srcLabel,
} from './src'

describe('parseSrcFragment', () => {
  it('parses a full range', () => {
    expect(parseSrcFragment('design.sv:12.16-12.21')).toEqual({
      file: 'design.sv',
      startLine: 12,
      startCol: 16,
      endLine: 12,
      endCol: 21,
    })
  })

  it('parses a multi-line range', () => {
    expect(parseSrcFragment('a.sv:3.1-5.9')).toEqual({
      file: 'a.sv',
      startLine: 3,
      startCol: 1,
      endLine: 5,
      endCol: 9,
    })
  })

  it('parses a single point with column', () => {
    expect(parseSrcFragment('x.v:7.4')).toEqual({
      file: 'x.v',
      startLine: 7,
      startCol: 4,
      endLine: 7,
      endCol: 4,
    })
  })

  it('parses a bare line', () => {
    expect(parseSrcFragment('x.v:7')).toEqual({
      file: 'x.v',
      startLine: 7,
      startCol: 1,
      endLine: 7,
      endCol: 1,
    })
  })

  it('returns null for garbage', () => {
    expect(parseSrcFragment('')).toBeNull()
    expect(parseSrcFragment('nocolon')).toBeNull()
    expect(parseSrcFragment('file:')).toBeNull()
  })
})

describe('parseSrc', () => {
  it('splits on pipe and keeps valid fragments', () => {
    const spans = parseSrc('a.sv:1.1-1.5|b.sv:9.2-9.8')
    expect(spans).toHaveLength(2)
    expect(spans[0].file).toBe('a.sv')
    expect(spans[1].file).toBe('b.sv')
  })

  it('drops unparseable fragments', () => {
    const spans = parseSrc('a.sv:1.1-1.5|garbage')
    expect(spans).toHaveLength(1)
  })

  it('handles empty/undefined', () => {
    expect(parseSrc(undefined)).toEqual([])
    expect(parseSrc(null)).toEqual([])
    expect(parseSrc('')).toEqual([])
  })
})

describe('srcLabel / spansSummary', () => {
  it('labels single line', () => {
    const [s] = parseSrc('design.sv:12.16-12.21')
    expect(srcLabel(s)).toBe('design.sv:12')
  })

  it('labels multi line', () => {
    const [s] = parseSrc('design.sv:12.1-15.4')
    expect(srcLabel(s)).toBe('design.sv:12-15')
  })

  it('summarizes multiple with +N', () => {
    expect(spansSummary(parseSrc('a.sv:1.1-1.5|b.sv:9.2-9.8'))).toBe('a.sv:1 +1')
  })

  it('summarizes single', () => {
    expect(spansSummary(parseSrc('a.sv:1.1-1.5'))).toBe('a.sv:1')
  })

  it('returns null for empty', () => {
    expect(spansSummary([])).toBeNull()
  })
})

describe('designSrcSpans', () => {
  const files = [{ name: 'top.sv' }, { name: 'util.sv' }]

  it('keeps spans from design files only', () => {
    const spans = designSrcSpans('top.sv:12.1-14.9|util.sv:3.1-3.5', files)
    expect(spans.map((s) => s.file)).toEqual(['top.sv', 'util.sv'])
  })

  it('drops yosys techmap library paths', () => {
    const spans = designSrcSpans(
      'top.sv:20.5-25.8|/opt/yosys/bin/../share/yosys/xilinx/ff_map.v:68.1-68.9',
      files,
    )
    expect(spans.map((s) => s.file)).toEqual(['top.sv'])
  })

  it('returns empty when only library paths contribute', () => {
    expect(
      designSrcSpans('/opt/yosys/share/yosys/xilinx/lut_map.v:51.1-53.4', files),
    ).toEqual([])
  })
})
