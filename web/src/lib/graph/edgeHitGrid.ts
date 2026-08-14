import type { Point } from './elkGraph'

export const EDGE_HIT_CELL_SIZE = 160

export interface EdgeHitCandidate {
  index: number
  points: Point[]
}

interface EdgeHitSegment<T extends EdgeHitCandidate> {
  id: number
  edge: T
  from: Point
  to: Point
}

export interface EdgeHitIndex<T extends EdgeHitCandidate> {
  cells: Map<string, EdgeHitSegment<T>[]>
}

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

export function buildEdgeHitIndex<T extends EdgeHitCandidate>(
  edges: T[],
): EdgeHitIndex<T> {
  const cells = new Map<string, EdgeHitSegment<T>[]>()
  let segmentId = 0
  for (const edge of edges) {
    for (let pointIndex = 1; pointIndex < edge.points.length; pointIndex += 1) {
      const from = edge.points[pointIndex - 1]
      const to = edge.points[pointIndex]
      if (from.x === to.x && from.y === to.y) continue
      const segment: EdgeHitSegment<T> = { id: segmentId, edge, from, to }
      segmentId += 1
      for (const key of edgeHitCellKeys(from, to)) {
        const existing = cells.get(key)
        if (existing) existing.push(segment)
        else cells.set(key, [segment])
      }
    }
  }
  return { cells }
}

export function pointSegmentDistanceSquared(
  point: Point,
  from: Point,
  to: Point,
): number {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) {
    const px = point.x - from.x
    const py = point.y - from.y
    return px * px + py * py
  }
  const projection = Math.max(
    0,
    Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared),
  )
  const closestX = from.x + projection * dx
  const closestY = from.y + projection * dy
  const px = point.x - closestX
  const py = point.y - closestY
  return px * px + py * py
}

export function hitTestEdge<T extends EdgeHitCandidate>(
  index: EdgeHitIndex<T>,
  point: Point,
  tolerance: number,
): T | null {
  const minCellX = Math.floor((point.x - tolerance) / EDGE_HIT_CELL_SIZE)
  const maxCellX = Math.floor((point.x + tolerance) / EDGE_HIT_CELL_SIZE)
  const minCellY = Math.floor((point.y - tolerance) / EDGE_HIT_CELL_SIZE)
  const maxCellY = Math.floor((point.y + tolerance) / EDGE_HIT_CELL_SIZE)
  const visitedSegments = new Set<number>()
  const toleranceSquared = tolerance * tolerance
  let best: { edge: T; distanceSquared: number } | null = null
  for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
    for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
      for (const segment of index.cells.get(edgeHitCellKey(cellX, cellY)) ?? []) {
        if (visitedSegments.has(segment.id)) continue
        visitedSegments.add(segment.id)
        const distanceSquared = pointSegmentDistanceSquared(
          point,
          segment.from,
          segment.to,
        )
        if (distanceSquared > toleranceSquared) continue
        if (
          !best ||
          distanceSquared < best.distanceSquared ||
          (distanceSquared === best.distanceSquared && segment.edge.index > best.edge.index)
        ) {
          best = { edge: segment.edge, distanceSquared }
        }
      }
    }
  }
  return best?.edge ?? null
}
