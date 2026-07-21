import type { Point } from './layout'

export const EDGE_HIT_CELL_SIZE = 160

export function edgeHitCellKey(x: number, y: number): string {
  return `${x}:${y}`
}

export function edgeHitCellKeys(from: Point, to: Point): string[] {
  let cellX = Math.floor(from.x / EDGE_HIT_CELL_SIZE)
  let cellY = Math.floor(from.y / EDGE_HIT_CELL_SIZE)
  const endCellX = Math.floor(to.x / EDGE_HIT_CELL_SIZE)
  const endCellY = Math.floor(to.y / EDGE_HIT_CELL_SIZE)
  const dx = to.x - from.x
  const dy = to.y - from.y
  const stepX = Math.sign(dx)
  const stepY = Math.sign(dy)
  const deltaX = dx === 0 ? Number.POSITIVE_INFINITY : EDGE_HIT_CELL_SIZE / Math.abs(dx)
  const deltaY = dy === 0 ? Number.POSITIVE_INFINITY : EDGE_HIT_CELL_SIZE / Math.abs(dy)
  const boundaryX = stepX > 0
    ? (cellX + 1) * EDGE_HIT_CELL_SIZE
    : cellX * EDGE_HIT_CELL_SIZE
  const boundaryY = stepY > 0
    ? (cellY + 1) * EDGE_HIT_CELL_SIZE
    : cellY * EDGE_HIT_CELL_SIZE
  let nextX = dx === 0
    ? Number.POSITIVE_INFINITY
    : Math.abs((boundaryX - from.x) / dx)
  let nextY = dy === 0
    ? Number.POSITIVE_INFINITY
    : Math.abs((boundaryY - from.y) / dy)
  const keys: string[] = []
  const seen = new Set<string>()
  const add = (x: number, y: number) => {
    const key = edgeHitCellKey(x, y)
    if (seen.has(key)) return
    seen.add(key)
    keys.push(key)
  }
  add(cellX, cellY)

  while (cellX !== endCellX || cellY !== endCellY) {
    const difference = nextX - nextY
    const scale = Math.max(1, Math.abs(nextX), Math.abs(nextY))
    const crossesCorner = Number.isFinite(difference) &&
      Math.abs(difference) <= Number.EPSILON * scale * 4
    if (crossesCorner) {
      const followingX = cellX + stepX
      const followingY = cellY + stepY
      // At an exact grid corner the stroke touches both side-adjacent cells as
      // well as the diagonal cell. Register the full supercover so tolerance
      // queries cannot miss the visible line on either side of the boundary.
      add(followingX, cellY)
      add(cellX, followingY)
      cellX = followingX
      cellY = followingY
      nextX += deltaX
      nextY += deltaY
    } else if (nextX < nextY) {
      cellX += stepX
      nextX += deltaX
    } else {
      cellY += stepY
      nextY += deltaY
    }
    add(cellX, cellY)
  }
  return keys
}
