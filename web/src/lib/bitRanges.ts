/** Format a set of bit indices as descending Verilog-style ranges. */
export function formatBitRanges(bits: readonly number[]): string {
  const sorted = [...new Set(bits)].sort((a, b) => a - b)
  if (sorted.length === 0) return ''
  const ranges: Array<[number, number]> = []
  let start = sorted[0]
  let end = start
  for (const bit of sorted.slice(1)) {
    if (bit === end + 1) {
      end = bit
      continue
    }
    ranges.push([start, end])
    start = bit
    end = bit
  }
  ranges.push([start, end])
  return ranges
    .reverse()
    .map(([lo, hi]) => (lo === hi ? `[${lo}]` : `[${hi}:${lo}]`))
    .join(', ')
}
