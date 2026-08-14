import type { LaidOutGraph } from './elkGraph'

/**
 * A new projection is a different sub-schematic, so frame exactly the cells it
 * shows. Overlap with the previous projection does not make the retained camera
 * meaningful: the new cone can sit anywhere in the old view, or extend past it.
 * Only an additive change to the same projection keeps its camera, which
 * `preserveViewportAnchor` handles.
 */
export function shouldRefitProjection(
  sameDesign: boolean,
  sameProjection: boolean,
): boolean {
  return !sameDesign || !sameProjection
}

export interface ViewportTransform {
  x: number
  y: number
  k: number
}

export interface ViewportInsets {
  top?: number
  right?: number
  bottom?: number
  left?: number
}

const MIN_VIEWPORT_SCALE = 0.08
const MAX_VIEWPORT_SCALE = 4

export function viewportTransformAttribute(transform: ViewportTransform): string {
  return `translate(${transform.x},${transform.y}) scale(${transform.k})`
}

export function panViewport(
  start: ViewportTransform,
  deltaX: number,
  deltaY: number,
): ViewportTransform {
  return { ...start, x: start.x + deltaX, y: start.y + deltaY }
}

export function zoomViewportAt(
  previous: ViewportTransform,
  anchorX: number,
  anchorY: number,
  factor: number,
): ViewportTransform {
  const scale = Math.min(
    Math.max(previous.k * factor, MIN_VIEWPORT_SCALE),
    MAX_VIEWPORT_SCALE,
  )
  const ratio = scale / previous.k
  return {
    k: scale,
    x: anchorX - (anchorX - previous.x) * ratio,
    y: anchorY - (anchorY - previous.y) * ratio,
  }
}

/** Keep a retained node at the same screen position after an additive layout. */
export function preserveViewportAnchor(
  transform: ViewportTransform,
  previous: LaidOutGraph,
  next: LaidOutGraph,
  preferredIds: Array<number | null | undefined> = [],
): ViewportTransform {
  const previousById = new Map(previous.nodes.map((node) => [node.id, node]))
  const nextById = new Map(next.nodes.map((node) => [node.id, node]))
  const candidates = [
    ...preferredIds,
    ...previous.nodes.map((node) => node.id),
  ]
  for (const id of candidates) {
    if (id == null) continue
    const before = previousById.get(id)
    const after = nextById.get(id)
    if (!before || !after) continue
    const beforeX = before.x + before.width / 2
    const beforeY = before.y + before.height / 2
    const afterX = after.x + after.width / 2
    const afterY = after.y + after.height / 2
    return {
      ...transform,
      x: transform.x + (beforeX - afterX) * transform.k,
      y: transform.y + (beforeY - afterY) * transform.k,
    }
  }
  return transform
}

/**
 * Center laid-out graph content in a viewport without relying on SVG viewBox
 * scaling. A hidden or not-yet-laid-out flex pane can transiently report a
 * zero-sized viewport; callers should retain the last transform in that case.
 */
export function fitViewportToContent(
  viewportWidth: number,
  viewportHeight: number,
  contentWidth: number,
  contentHeight: number,
  padding = 40,
  maxScale = 1.5,
  insets: ViewportInsets = {},
): ViewportTransform | null {
  const inset = (value: number | undefined) =>
    Number.isFinite(value) && (value ?? 0) > 0 ? (value ?? 0) : 0
  const top = inset(insets.top)
  const right = inset(insets.right)
  const bottom = inset(insets.bottom)
  const left = inset(insets.left)
  const availableWidth = viewportWidth - left - right
  const availableHeight = viewportHeight - top - bottom
  if (
    !Number.isFinite(viewportWidth) ||
    !Number.isFinite(viewportHeight) ||
    availableWidth <= padding ||
    availableHeight <= padding
  ) {
    return null
  }

  const width =
    Number.isFinite(contentWidth) && contentWidth > 0 ? contentWidth : 1
  const height =
    Number.isFinite(contentHeight) && contentHeight > 0 ? contentHeight : 1
  const scale = Math.min(
    (availableWidth - padding) / width,
    (availableHeight - padding) / height,
    maxScale,
  )
  if (!(scale > 0) || !Number.isFinite(scale)) return null

  return {
    x: left + (availableWidth - width * scale) / 2,
    y: top + (availableHeight - height * scale) / 2,
    k: scale,
  }
}

