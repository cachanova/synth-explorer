import {
  memo,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from 'react'
import {
  buildEdgeHitIndex,
  hitTestEdge,
  type EdgeHitIndex,
} from '../../lib/graph/edgeHitGrid'
import type { SourceNetSelection } from '../../lib/source/sourceTiers'
import { graphNodeElement, graphNodeId } from './SchematicNodes'
import type { PreparedSchematicEdge } from './SchematicEdges'

const EDGE_HIT_TOLERANCE_PX = 7
interface EdgeTooltipState {
  edgeIndex: number
  title: string
  left: number
  top: number
}

interface NodeTooltipState {
  nodeId: number
  title: string
  left: number
  top: number
}

export const SchematicNodeTooltip = memo(function SchematicNodeTooltip({
  active,
  stageRef,
  svgRef,
  hideRef,
}: {
  active: boolean
  stageRef: RefObject<HTMLDivElement | null>
  svgRef: RefObject<SVGSVGElement | null>
  hideRef: MutableRefObject<(() => void) | null>
}) {
  const [tooltip, setTooltip] = useState<NodeTooltipState | null>(null)

  useEffect(() => {
    setTooltip(null)
    if (!active) return
    const svg = svgRef.current
    const stage = stageRef.current
    if (!svg || !stage) return
    let activeNode: SVGGElement | null = null
    const hide = () => {
      activeNode = null
      setTooltip(null)
    }
    hideRef.current = hide
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || svg.classList.contains('panning')) {
        hide()
        return
      }
      const node = graphNodeElement(event.target, svg)
      if (node === activeNode) return
      activeNode = node
      const title = node?.dataset.nodeTooltip
      if (!node || !title) {
        setTooltip(null)
        return
      }
      const stageRect = stage.getBoundingClientRect()
      const nodeRect = node.getBoundingClientRect()
      setTooltip({
        nodeId: graphNodeId(node) ?? -1,
        title,
        left: Math.min(
          Math.max(8, nodeRect.left - stageRect.left + nodeRect.width / 2),
          Math.max(8, stageRect.width - 272),
        ),
        top: Math.min(
          Math.max(8, nodeRect.top - stageRect.top - 30),
          Math.max(8, stageRect.height - 44),
        ),
      })
    }
    svg.addEventListener('pointermove', onPointerMove)
    svg.addEventListener('pointerleave', hide)
    svg.addEventListener('pointerdown', hide)
    svg.addEventListener('wheel', hide)
    return () => {
      svg.removeEventListener('pointermove', onPointerMove)
      svg.removeEventListener('pointerleave', hide)
      svg.removeEventListener('pointerdown', hide)
      svg.removeEventListener('wheel', hide)
      if (hideRef.current === hide) hideRef.current = null
    }
  }, [active, hideRef, stageRef, svgRef])

  if (!tooltip) return null
  return (
    <div
      className="g-edge-tooltip g-node-tooltip"
      role="tooltip"
      data-node-id={tooltip.nodeId}
      style={{ left: tooltip.left, top: tooltip.top }}
    >
      {tooltip.title}
    </div>
  )
})

export const SchematicEdgeTooltip = memo(function SchematicEdgeTooltip({
  active,
  edges,
  geometryKey,
  stageRef,
  svgRef,
  viewportRef,
  hideRef,
  suppressClickRef,
  onSelect,
}: {
  active: boolean
  edges: PreparedSchematicEdge[]
  geometryKey: object
  stageRef: RefObject<HTMLDivElement | null>
  svgRef: RefObject<SVGSVGElement | null>
  viewportRef: RefObject<SVGGElement | null>
  hideRef: MutableRefObject<(() => void) | null>
  suppressClickRef: MutableRefObject<boolean>
  onSelect?: (selection: SourceNetSelection) => void
}) {
  const hitIndexRef = useRef<{
    geometryKey: object
    index: EdgeHitIndex<PreparedSchematicEdge>
  } | null>(null)
  const geometryEdgesRef = useRef({ geometryKey, edges })
  if (geometryEdgesRef.current.geometryKey !== geometryKey) {
    geometryEdgesRef.current = { geometryKey, edges }
  }
  if (hitIndexRef.current?.geometryKey !== geometryKey) hitIndexRef.current = null
  const [tooltip, setTooltip] = useState<EdgeTooltipState | null>(null)

  useEffect(() => {
    setTooltip(null)
    if (!active) return
    const svg = svgRef.current
    const stage = stageRef.current
    const viewport = viewportRef.current
    if (!svg || !stage || !viewport) return
    let frame: number | null = null
    let idle: number | null = null
    let pending: { clientX: number; clientY: number } | null = null
    let tooltipVisible = false
    const ensureHitIndex = () => {
      if (hitIndexRef.current?.geometryKey === geometryKey) return hitIndexRef.current.index
      const index = buildEdgeHitIndex(geometryEdgesRef.current.edges)
      hitIndexRef.current = { geometryKey, index }
      return index
    }

    // Building the geometry grid is linear in routed segments. Warm it only
    // after the graph paints; the first pointer hit can still build it on
    // demand if the browser has not reached an idle period yet.
    if (typeof window.requestIdleCallback === 'function') {
      idle = window.requestIdleCallback(ensureHitIndex, { timeout: 1_000 })
    } else {
      idle = window.setTimeout(ensureHitIndex, 0)
    }

    const hide = () => {
      pending = null
      if (frame != null) window.cancelAnimationFrame(frame)
      frame = null
      if (tooltipVisible) {
        tooltipVisible = false
        setTooltip(null)
      }
    }
    hideRef.current = hide
    const edgeAt = (clientX: number, clientY: number) => {
      const matrix = viewport.getScreenCTM()
      if (!matrix) return null
      const scale = Math.hypot(matrix.a, matrix.b)
      if (!Number.isFinite(scale) || scale <= 0) return null
      const graphPoint = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse())
      return hitTestEdge(
        ensureHitIndex(),
        graphPoint,
        EDGE_HIT_TOLERANCE_PX / scale,
      )
    }
    const resolvePending = () => {
      frame = null
      const current = pending
      pending = null
      if (!current || svg.classList.contains('panning')) {
        hide()
        return
      }
      const edge = edgeAt(current.clientX, current.clientY)
      if (!edge) {
        hide()
        return
      }
      const rect = stage.getBoundingClientRect()
      const left = Math.min(
        Math.max(8, current.clientX - rect.left + 12),
        Math.max(8, rect.width - 272),
      )
      const top = Math.min(
        Math.max(8, current.clientY - rect.top + 12),
        Math.max(8, rect.height - 44),
      )
      tooltipVisible = true
      setTooltip({ edgeIndex: edge.index, title: edge.title, left, top })
    }
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') {
        hide()
        return
      }
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('.g-node-body')) {
        hide()
        return
      }
      pending = { clientX: event.clientX, clientY: event.clientY }
      if (frame == null) frame = window.requestAnimationFrame(resolvePending)
    }
    const onClick = (event: MouseEvent) => {
      if (!onSelect || svg.classList.contains('panning')) return
      if (suppressClickRef.current) {
        return
      }
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('.g-node-body')) return
      const edge = edgeAt(event.clientX, event.clientY)
      if (!edge) return
      if (edge.netBits.length === 0) return
      event.stopPropagation()
      onSelect({
        names: edge.netName ? [edge.netName] : [],
        bits: edge.netBits,
      })
    }

    svg.addEventListener('pointermove', onPointerMove)
    svg.addEventListener('pointerleave', hide)
    svg.addEventListener('pointerdown', hide)
    svg.addEventListener('wheel', hide)
    svg.addEventListener('click', onClick)
    return () => {
      svg.removeEventListener('pointermove', onPointerMove)
      svg.removeEventListener('pointerleave', hide)
      svg.removeEventListener('pointerdown', hide)
      svg.removeEventListener('wheel', hide)
      svg.removeEventListener('click', onClick)
      if (hideRef.current === hide) hideRef.current = null
      if (frame != null) window.cancelAnimationFrame(frame)
      if (idle != null) {
        if (typeof window.cancelIdleCallback === 'function') {
          window.cancelIdleCallback(idle)
        } else {
          window.clearTimeout(idle)
        }
      }
    }
  }, [
    active,
    geometryKey,
    hideRef,
    onSelect,
    stageRef,
    suppressClickRef,
    svgRef,
    viewportRef,
  ])

  if (!tooltip) return null
  return (
    <div
      className="g-edge-tooltip"
      role="tooltip"
      data-edge-index={tooltip.edgeIndex}
      style={{ left: tooltip.left, top: tooltip.top }}
    >
      {tooltip.title}
    </div>
  )
})
