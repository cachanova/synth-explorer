import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react'
import type { LaidOutGraph } from '../../lib/graph/elkGraph'
import {
  fitViewportToContent,
  type ViewportTransform,
} from '../../lib/graph/viewport'

export type SchematicDetailLevel = 'overview' | 'compact' | 'full'

const DETAIL_LEVEL_RANK: Record<SchematicDetailLevel, number> = {
  overview: 0,
  compact: 1,
  full: 2,
}
const DETAIL_RESTORE_IDLE_MS = 160
const DETAIL_VIEWPORT_OVERSCAN = 96
const INITIAL_DETAIL_VIEWPORT = { width: 960, height: 640 }

function initialDetailLevel(scale: number): SchematicDetailLevel {
  if (scale < 0.4) return 'overview'
  if (scale < 0.75) return 'compact'
  return 'full'
}

function nextDetailLevel(
  scale: number,
  current: SchematicDetailLevel,
): SchematicDetailLevel {
  if (current === 'overview') {
    if (scale >= 0.8) return 'full'
    if (scale >= 0.45) return 'compact'
    return 'overview'
  }
  if (current === 'compact') {
    if (scale < 0.35) return 'overview'
    if (scale >= 0.8) return 'full'
    return 'compact'
  }
  if (scale < 0.35) return 'overview'
  if (scale < 0.65) return 'compact'
  return 'full'
}

function visibleDetailNodeIds(
  graph: LaidOutGraph,
  transform: ViewportTransform,
  viewportWidth: number,
  viewportHeight: number,
): Set<number> {
  const ids = new Set<number>()
  const minX = -DETAIL_VIEWPORT_OVERSCAN
  const minY = -DETAIL_VIEWPORT_OVERSCAN
  const maxX = viewportWidth + DETAIL_VIEWPORT_OVERSCAN
  const maxY = viewportHeight + DETAIL_VIEWPORT_OVERSCAN
  for (const node of graph.nodes) {
    const left = node.x * transform.k + transform.x
    const right = (node.x + node.width) * transform.k + transform.x
    const top = node.y * transform.k + transform.y
    const bottom = (node.y + node.height) * transform.k + transform.y
    if (right >= minX && left <= maxX && bottom >= minY && top <= maxY) {
      ids.add(node.id)
    }
  }
  return ids
}

function initialDetailState(graph: LaidOutGraph): {
  level: SchematicDetailLevel
  ids: Set<number>
} {
  const transform = fitViewportToContent(
    INITIAL_DETAIL_VIEWPORT.width,
    INITIAL_DETAIL_VIEWPORT.height,
    graph.width,
    graph.height,
  )
  if (!transform) return { level: 'overview', ids: new Set() }
  const level = initialDetailLevel(transform.k)
  return {
    level,
    ids: level === 'overview'
      ? new Set()
      : visibleDetailNodeIds(
          graph,
          transform,
          INITIAL_DETAIL_VIEWPORT.width,
          INITIAL_DETAIL_VIEWPORT.height,
        ),
  }
}

function sameNodeIds(left: Set<number>, right: Set<number>): boolean {
  if (left.size !== right.size) return false
  for (const id of left) if (!right.has(id)) return false
  return true
}

export function useDetailLevel({
  graph,
  stageRef,
  viewportRef,
  transformRef,
}: {
  graph: LaidOutGraph
  stageRef: RefObject<HTMLDivElement | null>
  viewportRef: RefObject<SVGGElement | null>
  transformRef: RefObject<ViewportTransform>
}) {
  const graphRef = useRef(graph)
  graphRef.current = graph
  const detailLevel = useRef<SchematicDetailLevel | null>(null)
  const detailRestoreTimer = useRef<number | null>(null)
  const mountedDetailsGraph = useRef(graph)
  const [mountedDetails, setMountedDetails] = useState(() => ({
    graph,
    ...initialDetailState(graph),
  }))

  const clearDetailRestore = useCallback(() => {
    if (detailRestoreTimer.current == null) return
    window.clearTimeout(detailRestoreTimer.current)
    detailRestoreTimer.current = null
  }, [])

  const updateMountedDetails = useCallback((level: SchematicDetailLevel) => {
    const currentGraph = graphRef.current
    mountedDetailsGraph.current = currentGraph
    let ids = new Set<number>()
    if (level !== 'overview') {
      const rect = stageRef.current?.getBoundingClientRect()
      ids = rect && rect.width > 0 && rect.height > 0
        ? visibleDetailNodeIds(
            currentGraph,
            transformRef.current,
            rect.width,
            rect.height,
          )
        : initialDetailState(currentGraph).ids
    }
    setMountedDetails((previous) =>
      previous.graph === currentGraph &&
      previous.level === level &&
      sameNodeIds(previous.ids, ids)
        ? previous
        : { graph: currentGraph, level, ids },
    )
  }, [stageRef, transformRef])

  const applyDetailLevel = useCallback((next: SchematicDetailLevel) => {
    detailLevel.current = next
    viewportRef.current?.setAttribute('data-detail-level', next)
    updateMountedDetails(next)
  }, [updateMountedDetails, viewportRef])

  const applyTransformDetail = useCallback((next: ViewportTransform) => {
    const current = detailLevel.current
    if (current == null) {
      applyDetailLevel(initialDetailLevel(next.k))
      return
    }
    if (mountedDetailsGraph.current !== graphRef.current) {
      // A replacement graph must derive its overlay IDs from the preserved
      // viewport, not the nominal fit used to keep server/static markup useful.
      updateMountedDetails(current)
    }
    const desired = nextDetailLevel(next.k, current)
    clearDetailRestore()
    if (DETAIL_LEVEL_RANK[desired] < DETAIL_LEVEL_RANK[current]) {
      applyDetailLevel(desired)
      return
    }
    if (desired === current && desired === 'overview') return
    detailRestoreTimer.current = window.setTimeout(() => {
      detailRestoreTimer.current = null
      const activeLevel = detailLevel.current
      if (activeLevel == null) return
      const idleLevel = nextDetailLevel(transformRef.current.k, activeLevel)
      if (DETAIL_LEVEL_RANK[idleLevel] >= DETAIL_LEVEL_RANK[activeLevel]) {
        applyDetailLevel(idleLevel)
      }
    }, DETAIL_RESTORE_IDLE_MS)
  }, [applyDetailLevel, clearDetailRestore, transformRef, updateMountedDetails])

  useEffect(() => clearDetailRestore, [clearDetailRestore])

  const initialDetails = mountedDetails.graph === graph
    ? null
    : initialDetailState(graph)

  return {
    applyTransformDetail,
    clearDetailRestore,
    renderedDetailIds: initialDetails?.ids ?? mountedDetails.ids,
    renderedDetailLevel: initialDetails?.level ?? mountedDetails.level,
  }
}
