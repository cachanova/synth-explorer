import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type MutableRefObject,
  type RefObject,
} from 'react'
import type { LaidOutGraph } from '../../lib/graph/elkGraph'
import {
  fitViewportToContent,
  panViewport,
  preserveViewportAnchor,
  viewportTransformAttribute,
  zoomViewportAt,
  type ViewportTransform,
} from '../../lib/graph/viewport'

interface PanState {
  pointerId: number
  x: number
  y: number
  transform: ViewportTransform
  moved: boolean
}

interface PinchState {
  pointerIds: [number, number]
  centerX: number
  centerY: number
  distance: number
  transform: ViewportTransform
  moved: boolean
}

const FIT_OVERLAY_GAP = 12

export function useViewportGestures({
  active,
  graph,
  rootId,
  selectedId,
  fitNonce,
  stageRef,
  svgRef,
  viewportRef,
  transformRef,
  hideEdgeTooltipRef,
  hideNodeTooltipRef,
  applyTransformDetail,
  clearDetailRestore,
}: {
  active: boolean
  graph: LaidOutGraph
  rootId: number
  selectedId: number | null
  fitNonce: number
  stageRef: RefObject<HTMLDivElement | null>
  svgRef: RefObject<SVGSVGElement | null>
  viewportRef: RefObject<SVGGElement | null>
  transformRef: MutableRefObject<ViewportTransform>
  hideEdgeTooltipRef: MutableRefObject<(() => void) | null>
  hideNodeTooltipRef: MutableRefObject<(() => void) | null>
  applyTransformDetail: (next: ViewportTransform) => void
  clearDetailRestore: () => void
}) {
  const graphRef = useRef(graph)
  graphRef.current = graph
  const layoutHistory = useRef<{
    graph: LaidOutGraph | null
    fitNonce: number | null
  }>({ graph: null, fitNonce: null })
  const panState = useRef<PanState | null>(null)
  const pinchState = useRef<PinchState | null>(null)
  const suppressClick = useRef(false)
  const userAdjusted = useRef(false)

  // Keep pointer-frequency viewport updates outside React. The detail hook
  // independently applies the LOD hysteresis after this DOM-only transform.
  const applyTransform = useCallback((next: ViewportTransform) => {
    hideEdgeTooltipRef.current?.()
    hideNodeTooltipRef.current?.()
    transformRef.current = next
    viewportRef.current?.setAttribute('transform', viewportTransformAttribute(next))
    applyTransformDetail(next)
  }, [
    applyTransformDetail,
    hideEdgeTooltipRef,
    hideNodeTooltipRef,
    transformRef,
    viewportRef,
  ])

  const fit = useCallback(() => {
    const stage = stageRef.current
    const currentGraph = graphRef.current
    if (!stage || currentGraph.nodes.length === 0) return
    const rect = stage.getBoundingClientRect()
    const wrapper = stage.parentElement
    const bannerRect = wrapper
      ?.querySelector<HTMLElement>('.graph-banner')
      ?.getBoundingClientRect()
    const cardRect = wrapper
      ?.querySelector<HTMLElement>('.node-card')
      ?.getBoundingClientRect()
    const shortcutRect = stage
      .querySelector<HTMLElement>('.graph-shortcuts')
      ?.getBoundingClientRect()
    const zoomRect = stage
      .querySelector<HTMLElement>('.zoom-controls')
      ?.getBoundingClientRect()
    const bottomOverlayTop = Math.min(
      shortcutRect?.top ?? Number.POSITIVE_INFINITY,
      zoomRect?.top ?? Number.POSITIVE_INFINITY,
    )
    const next = fitViewportToContent(
      rect.width,
      rect.height,
      currentGraph.width,
      currentGraph.height,
      40,
      1.5,
      {
        top: bannerRect && bannerRect.height > 0
          ? Math.max(0, bannerRect.bottom - rect.top + FIT_OVERLAY_GAP)
          : 0,
        right: cardRect && cardRect.width > 0
          ? Math.max(0, rect.right - cardRect.left + FIT_OVERLAY_GAP)
          : 0,
        bottom: Number.isFinite(bottomOverlayTop)
          ? Math.max(0, rect.bottom - bottomOverlayTop + FIT_OVERLAY_GAP)
          : 0,
      },
    )
    if (next) applyTransform(next)
  }, [applyTransform, stageRef])

  useLayoutEffect(() => {
    const previous = layoutHistory.current
    if (previous.graph == null || previous.fitNonce !== fitNonce) {
      userAdjusted.current = false
      fit()
    } else if (previous.graph !== graph) {
      applyTransform(
        preserveViewportAnchor(
          transformRef.current,
          previous.graph,
          graph,
          [selectedId, rootId],
        ),
      )
    }
    layoutHistory.current = { graph, fitNonce }
  }, [applyTransform, fit, fitNonce, graph, rootId, selectedId, transformRef])

  useEffect(() => {
    if (!active) return
    const stage = stageRef.current
    if (!stage) return

    const updateSize = () => {
      if (!userAdjusted.current) fit()
      else applyTransform(transformRef.current)
    }

    // ResizeObserver normally delivers an initial entry, but measuring now
    // avoids one frame with a stale transform when a display:none Schematic tab is
    // shown again. fit() ignores transient zero-sized flex layouts.
    updateSize()

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateSize)
      return () => window.removeEventListener('resize', updateSize)
    }

    const observer = new ResizeObserver(updateSize)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [active, applyTransform, fit, stageRef, transformRef])

  const onWheel = useCallback(
    (event: React.WheelEvent) => {
      event.preventDefault()
      const stage = stageRef.current
      if (!stage) return
      const rect = stage.getBoundingClientRect()
      const mouseX = event.clientX - rect.left
      const mouseY = event.clientY - rect.top
      userAdjusted.current = true
      applyTransform(
        zoomViewportAt(
          transformRef.current,
          mouseX,
          mouseY,
          Math.exp(-event.deltaY * 0.0016),
        ),
      )
    },
    [applyTransform, stageRef, transformRef],
  )

  const onPointerDown = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      if (event.button !== 0) return
      if (event.pointerType === 'touch') return
      panState.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        transform: transformRef.current,
        moved: false,
      }
      event.currentTarget.classList.add('panning')
    },
    [transformRef],
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      if (event.pointerType === 'touch') return

      const pan = panState.current
      if (!pan || event.pointerId !== pan.pointerId) return
      if (event.buttons === 0) {
        // The release happened outside the svg before capture engaged; end
        // the gesture instead of panning with no button held.
        panState.current = null
        event.currentTarget.classList.remove('panning')
        return
      }
      const dx = event.clientX - pan.x
      const dy = event.clientY - pan.y
      if (!pan.moved && Math.hypot(dx, dy) >= 2) {
        pan.moved = true
        userAdjusted.current = true
        // Capture only once a pan actually starts. Capturing on pointerdown
        // makes the browser retarget the eventual pointerup/click at the svg
        // root, which silently drops the first click on a node.
        event.currentTarget.setPointerCapture?.(event.pointerId)
      }
      if (pan.moved) applyTransform(panViewport(pan.transform, dx, dy))
    },
    [applyTransform],
  )

  const finishPan = useCallback(() => {
    const moved = Boolean(panState.current?.moved || pinchState.current?.moved)
    suppressClick.current = moved
    if (moved) {
      window.setTimeout(() => {
        suppressClick.current = false
      }, 0)
    }
    panState.current = null
    pinchState.current = null
    const svg = svgRef.current
    svg?.classList.remove('panning')
  }, [svgRef])

  const finishPointer = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      if (event.pointerType !== 'touch') finishPan()
    },
    [finishPan],
  )

  const cancelPan = useCallback(() => {
    suppressClick.current = false
    panState.current = null
    pinchState.current = null
    const svg = svgRef.current
    svg?.classList.remove('panning')
  }, [svgRef])

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length === 1) {
        const touch = event.touches[0]
        panState.current = {
          pointerId: touch.identifier,
          x: touch.clientX,
          y: touch.clientY,
          transform: transformRef.current,
          moved: false,
        }
      } else if (event.touches.length === 2) {
        const [first, second] = event.touches
        pinchState.current = {
          pointerIds: [first.identifier, second.identifier],
          centerX: (first.clientX + second.clientX) / 2,
          centerY: (first.clientY + second.clientY) / 2,
          distance: Math.max(
            1,
            Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY),
          ),
          transform: transformRef.current,
          moved: false,
        }
        panState.current = null
        userAdjusted.current = true
      }
      svg.classList.add('panning')
    }

    const onTouchMove = (event: TouchEvent) => {
      event.preventDefault()
      const pinch = pinchState.current
      if (pinch) {
        const first = [...event.touches].find(
          (touch) => touch.identifier === pinch.pointerIds[0],
        )
        const second = [...event.touches].find(
          (touch) => touch.identifier === pinch.pointerIds[1],
        )
        const stage = stageRef.current
        if (!first || !second || !stage) return
        const centerX = (first.clientX + second.clientX) / 2
        const centerY = (first.clientY + second.clientY) / 2
        const distance = Math.max(
          1,
          Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY),
        )
        const rect = stage.getBoundingClientRect()
        const zoomed = zoomViewportAt(
          pinch.transform,
          pinch.centerX - rect.left,
          pinch.centerY - rect.top,
          distance / pinch.distance,
        )
        pinch.moved = true
        applyTransform(
          panViewport(
            zoomed,
            centerX - pinch.centerX,
            centerY - pinch.centerY,
          ),
        )
        return
      }

      const pan = panState.current
      const touch = [...event.touches].find(
        (candidate) => candidate.identifier === pan?.pointerId,
      )
      if (!pan || !touch) return
      const dx = touch.clientX - pan.x
      const dy = touch.clientY - pan.y
      if (!pan.moved && Math.hypot(dx, dy) >= 2) {
        pan.moved = true
        userAdjusted.current = true
      }
      if (pan.moved) applyTransform(panViewport(pan.transform, dx, dy))
    }

    const onTouchEnd = (event: TouchEvent) => {
      if (pinchState.current && event.touches.length === 1) {
        const touch = event.touches[0]
        pinchState.current = null
        panState.current = {
          pointerId: touch.identifier,
          x: touch.clientX,
          y: touch.clientY,
          transform: transformRef.current,
          moved: true,
        }
        return
      }
      finishPan()
    }

    svg.addEventListener('touchstart', onTouchStart, { passive: false })
    svg.addEventListener('touchmove', onTouchMove, { passive: false })
    svg.addEventListener('touchend', onTouchEnd, { passive: false })
    svg.addEventListener('touchcancel', cancelPan, { passive: false })
    return () => {
      svg.removeEventListener('touchstart', onTouchStart)
      svg.removeEventListener('touchmove', onTouchMove)
      svg.removeEventListener('touchend', onTouchEnd)
      svg.removeEventListener('touchcancel', cancelPan)
    }
  }, [applyTransform, cancelPan, finishPan, stageRef, svgRef, transformRef])

  useEffect(() => {
    if (active) {
      // Deactivation cancels any pending richer-detail restore. Re-evaluate the
      // preserved transform when the tab returns so a user-adjusted viewport
      // cannot remain stuck at the lower tier that was active mid-gesture.
      applyTransform(transformRef.current)
      return
    }
    panState.current = null
    pinchState.current = null
    suppressClick.current = false
    clearDetailRestore()
    const svg = svgRef.current
    svg?.classList.remove('panning')
  }, [active, applyTransform, clearDetailRestore, svgRef, transformRef])

  const zoomBy = useCallback((factor: number) => {
    userAdjusted.current = true
    const rect = stageRef.current?.getBoundingClientRect()
    const centerX = rect ? rect.width / 2 : 0
    const centerY = rect ? rect.height / 2 : 0
    applyTransform(
      zoomViewportAt(transformRef.current, centerX, centerY, factor),
    )
  }, [applyTransform, stageRef, transformRef])

  const onViewportKeyDown = useCallback(
    (event: React.KeyboardEvent<SVGSVGElement>) => {
      if (event.target !== event.currentTarget) return
      const step = event.shiftKey ? 80 : 32
      let handled = true
      switch (event.key) {
        case 'ArrowLeft':
          applyTransform(panViewport(transformRef.current, step, 0))
          break
        case 'ArrowRight':
          applyTransform(panViewport(transformRef.current, -step, 0))
          break
        case 'ArrowUp':
          applyTransform(panViewport(transformRef.current, 0, step))
          break
        case 'ArrowDown':
          applyTransform(panViewport(transformRef.current, 0, -step))
          break
        case '+':
        case '=':
          zoomBy(1.25)
          break
        case '-':
        case '_':
          zoomBy(0.8)
          break
        case '0':
          userAdjusted.current = false
          fit()
          break
        default:
          handled = false
      }
      if (!handled) return
      userAdjusted.current = event.key !== '0'
      event.preventDefault()
      event.stopPropagation()
    },
    [applyTransform, fit, transformRef, zoomBy],
  )

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const preventNativeScroll = (event: WheelEvent) => event.preventDefault()
    stage.addEventListener('wheel', preventNativeScroll, { passive: false })
    return () => stage.removeEventListener('wheel', preventNativeScroll)
  }, [stageRef])

  return {
    applyTransform,
    fit,
    onPointerDown,
    onPointerMove,
    onViewportKeyDown,
    onWheel,
    cancelPan,
    finishPointer,
    suppressClickRef: suppressClick,
    userAdjustedRef: userAdjusted,
    zoomBy,
  }
}
