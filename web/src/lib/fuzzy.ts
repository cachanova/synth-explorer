// Lightweight subsequence fuzzy matching + filtering.

/**
 * Returns a score >= 0 if all chars of `query` appear in `text` in order
 * (case-insensitive), or -1 if no match. Higher is better. Contiguous runs
 * and matches at word boundaries / start score higher.
 */
export function fuzzyScore(query: string, text: string): number {
  if (!query) return 0
  const q = query.toLowerCase()
  const t = text.toLowerCase()

  let score = 0
  let ti = 0
  let prevMatch = -2
  let consecutive = 0

  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]
    let found = -1
    for (let j = ti; j < t.length; j++) {
      if (t[j] === ch) {
        found = j
        break
      }
    }
    if (found === -1) return -1

    // base point for a match
    score += 1
    // contiguity bonus
    if (found === prevMatch + 1) {
      consecutive += 1
      score += consecutive * 2
    } else {
      consecutive = 0
    }
    // word-boundary / start bonus
    if (found === 0) {
      score += 3
    } else {
      const before = t[found - 1]
      if (before === '_' || before === '[' || before === '.' || before === '$') {
        score += 2
      }
    }
    prevMatch = found
    ti = found + 1
  }

  // prefer shorter targets when scores otherwise tie
  score -= Math.min(t.length, 40) * 0.02
  return score
}

export function fuzzyMatch(query: string, text: string): boolean {
  return fuzzyScore(query, text) >= 0
}

/** Filter + rank items by a fuzzy query against a derived key string. */
export function fuzzyFilter<T>(
  items: T[],
  query: string,
  key: (item: T) => string,
): T[] {
  if (!query.trim()) return items
  const scored: { item: T; score: number; idx: number }[] = []
  items.forEach((item, idx) => {
    const s = fuzzyScore(query.trim(), key(item))
    if (s >= 0) scored.push({ item, score: s, idx })
  })
  scored.sort((a, b) => (b.score - a.score) || (a.idx - b.idx))
  return scored.map((s) => s.item)
}
