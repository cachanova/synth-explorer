import type { TimingPath } from '../../types'

export type PathSortKey = 'depth' | 'delay'
type SortDirection = 'asc' | 'desc'

export interface PathSortState {
  key: PathSortKey
  direction: SortDirection
}

export function nextPathSort(
  current: PathSortState | null,
  key: PathSortKey,
): PathSortState {
  if (current?.key !== key) return { key, direction: 'desc' }
  return {
    key,
    direction: current.direction === 'desc' ? 'asc' : 'desc',
  }
}

export function sortPaths(
  paths: readonly TimingPath[],
  sort: PathSortState,
): TimingPath[] {
  const direction = sort.direction === 'asc' ? 1 : -1
  return [...paths].sort((left, right) => {
    if (sort.key === 'depth') return direction * (left.depth - right.depth)
    if (left.estimated_delay_ns == null) {
      return right.estimated_delay_ns == null ? 0 : 1
    }
    if (right.estimated_delay_ns == null) return -1
    return direction * (left.estimated_delay_ns - right.estimated_delay_ns)
  })
}

export function sortDirectionArrow(direction: SortDirection): string {
  return direction === 'desc' ? ' ▾' : ' ▴'
}

export function sortDirectionLabel(
  direction: SortDirection,
): 'ascending' | 'descending' {
  return direction === 'asc' ? 'ascending' : 'descending'
}
