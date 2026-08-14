import { describe, expect, it } from 'vitest'
import type { GraphNode } from '../../types'
import {
  fitViewportToContent,
  panViewport,
  preserveViewportAnchor,
  shouldRefitProjection,
  viewportTransformAttribute,
  zoomViewportAt,
} from './viewport'

const node = (id: number, cellType: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  id,
  kind: 'cell',
  name: `u${id}`,
  cell_type: cellType,
  ...extra,
})

describe('viewport transforms', () => {
  it('refits centered graph content when the containing pane changes size', () => {
    expect(fitViewportToContent(1000, 600, 800, 400)).toEqual({
      x: 20,
      y: 60,
      k: 1.2,
    })
    expect(fitViewportToContent(600, 400, 800, 400)).toEqual({
      x: 20,
      y: 60,
      k: 0.7,
    })
  })

  it('fits graph content inside overlay-safe viewport insets', () => {
    expect(
      fitViewportToContent(1000, 600, 800, 400, 40, 1.5, {
        top: 40,
        right: 280,
        bottom: 30,
        left: 0,
      }),
    ).toEqual({
      x: 20,
      y: 135,
      k: 0.85,
    })
  })

  it('ignores transient hidden-pane measurements instead of corrupting the transform', () => {
    expect(fitViewportToContent(0, 0, 800, 400)).toBeNull()
    expect(fitViewportToContent(1000, 0, 800, 400)).toBeNull()
    expect(fitViewportToContent(Number.NaN, 600, 800, 400)).toBeNull()
  })

  it('pans without changing scale and emits the SVG transform', () => {
    const moved = panViewport({ x: 10, y: 20, k: 2 }, 5, -7)
    expect(moved).toEqual({ x: 15, y: 13, k: 2 })
    expect(viewportTransformAttribute(moved)).toBe('translate(15,13) scale(2)')
  })

  it('preserves a retained anchor on screen without changing zoom', () => {
    const graphNode = node(1, '$_AND_')
    const previous = {
      nodes: [{ id: 1, x: 20, y: 30, width: 80, height: 50, node: graphNode }],
      edges: [],
      width: 100,
      height: 80,
    }
    const next = {
      ...previous,
      nodes: [{ ...previous.nodes[0], x: 120, y: 70 }],
    }

    expect(
      preserveViewportAnchor({ x: 10, y: 15, k: 2 }, previous, next, [1]),
    ).toEqual({ x: -190, y: -65, k: 2 })
  })

  it('refits every new sub-schematic and keeps the camera within one', () => {
    // An additive change to the displayed projection keeps its camera.
    expect(shouldRefitProjection(true, true)).toBe(false)
    // A different projection is a different sub-schematic, even when it
    // overlaps the previous one.
    expect(shouldRefitProjection(true, false)).toBe(true)
    expect(shouldRefitProjection(false, false)).toBe(true)
  })

  it('zooms around a fixed screen-space anchor and clamps scale', () => {
    const previous = { x: 10, y: 20, k: 1 }
    const zoomed = zoomViewportAt(previous, 110, 70, 2)
    expect(zoomed).toEqual({ x: -90, y: -30, k: 2 })
    expect((110 - zoomed.x) / zoomed.k).toBe((110 - previous.x) / previous.k)
    expect((70 - zoomed.y) / zoomed.k).toBe((70 - previous.y) / previous.k)
    expect(zoomViewportAt(previous, 0, 0, 100).k).toBe(4)
    expect(zoomViewportAt(previous, 0, 0, 0.001).k).toBe(0.08)
  })
})
