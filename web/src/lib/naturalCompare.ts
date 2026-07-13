// Natural-order string comparison: embedded numbers compare by value, so
// "d_in[2]" sorts before "d_in[10]".

const collator = new Intl.Collator('en', { numeric: true })

export function naturalCompare(a: string, b: string): number {
  return collator.compare(a, b)
}
