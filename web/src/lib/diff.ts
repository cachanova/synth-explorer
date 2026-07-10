// Diffing of cells-by-type maps for the Compare tab.

export interface CellTypeDelta {
  type: string
  a: number // count in A
  b: number // count in B
  delta: number // b - a
}

export interface CellsByTypeDiff {
  added: CellTypeDelta[] // present in B, absent in A
  removed: CellTypeDelta[] // present in A, absent in B
  changed: CellTypeDelta[] // present in both, different count
  unchanged: CellTypeDelta[] // present in both, same count
}

/**
 * Diff two cells_by_type maps. Rows sorted by absolute delta desc, then type.
 */
export function diffCellsByType(
  a: Record<string, number>,
  b: Record<string, number>,
): CellsByTypeDiff {
  const types = new Set<string>([...Object.keys(a), ...Object.keys(b)])
  const added: CellTypeDelta[] = []
  const removed: CellTypeDelta[] = []
  const changed: CellTypeDelta[] = []
  const unchanged: CellTypeDelta[] = []

  for (const type of types) {
    const av = a[type] ?? 0
    const bv = b[type] ?? 0
    const row: CellTypeDelta = { type, a: av, b: bv, delta: bv - av }
    if (av === 0 && bv > 0) added.push(row)
    else if (bv === 0 && av > 0) removed.push(row)
    else if (av !== bv) changed.push(row)
    else unchanged.push(row)
  }

  const byMagnitude = (x: CellTypeDelta, y: CellTypeDelta) =>
    Math.abs(y.delta) - Math.abs(x.delta) || x.type.localeCompare(y.type)
  const byType = (x: CellTypeDelta, y: CellTypeDelta) => x.type.localeCompare(y.type)

  added.sort(byMagnitude)
  removed.sort(byMagnitude)
  changed.sort(byMagnitude)
  unchanged.sort(byType)

  return { added, removed, changed, unchanged }
}

/** Total number of cells that changed type-count in either direction. */
export function totalCellDelta(diff: CellsByTypeDiff): number {
  let sum = 0
  for (const row of [...diff.added, ...diff.removed, ...diff.changed]) {
    sum += Math.abs(row.delta)
  }
  return sum
}
