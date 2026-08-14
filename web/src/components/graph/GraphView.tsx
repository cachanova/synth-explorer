import { memo, useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import {
  canonicalPinNames,
  controlRoleForPin,
  isRegisterControlPin,
} from '../../lib/graph/nodeGeometry'
import type { LaidOutGraph, LaidOutNode } from '../../lib/graph/elkGraph'
import { EMPTY_SELECTED_NET_NAMES, relatedCone, type RelatedCone } from '../../lib/graph/relatedCone'
import { type ViewportTransform } from '../../lib/graph/viewport'
import {
  controlDriverIds,
  controlsFor,
  inferPortDirections,
  symbolKind,
} from '../../lib/graph/symbols'
import type { SourceNetSelection } from '../../lib/source/sourceTiers'
import type { ControlRef, ControlRole, GraphNode } from '../../types'
import { GroupExpansionControls } from './GroupExpansionControls'
import {
  EMPTY_PREPARED_SCHEMATIC_EDGES,
  SelectedSchematicEdges,
  SchematicEdges,
  bucketSchematicEdges,
  prepareSchematicEdgeGeometry,
  type PreparedSchematicEdge,
} from './SchematicEdges'
import {
  GRAPH_NAVIGATION_KEYS,
  SchematicNodeDetailOverlays,
  SchematicNodeShells,
  SchematicPinOverlays,
  graphNodeElement,
  graphNodeId,
  type GraphNavigationKey,
  type NodePins,
} from './SchematicNodes'
import { SchematicEdgeTooltip, SchematicNodeTooltip } from './SchematicTooltips'
import { useDetailLevel } from './useDetailLevel'
import { useViewportGestures } from './useViewportGestures'

interface Props {
  graph: LaidOutGraph
  rootId: number
  relevantIds: Set<number>
  overlayIds: Set<number>
  /** Final Yosys net bits named directly by the selected source declaration. */
  highlightedBits?: Set<number>
  /** Extend source-selection overlays across adjacent port/constant nets. */
  extendOverlayToBoundaryNets?: boolean
  selectedId: number | null
  /** Net names whose routed segments use the selected-wire overlay. */
  selectedNetNames?: string[]
  interactive: boolean
  onSelect: (node: GraphNode | null) => void
  /** Cross-probes the names and exact final-net bits carried by a clicked edge. */
  onEdgeSelect?: (selection: SourceNetSelection) => void
  /** Opens a dedicated control cone when the parent supports that workflow. */
  onControlSelect?: (control: ControlRef, node: GraphNode) => void
  /** Double-click a node to additively render its fanin/fanout connections. */
  onExpand?: (node: GraphNode) => void
  /** Expand one synthetic group into its canonical physical members. */
  onExpandGroup?: (node: GraphNode) => void
  /** Collapse a locally expanded group back to its stable synthetic node. */
  onCollapseGroup?: (groupId: number) => void
  expandedGroups?: ExpandedGroupFrame[]
  active: boolean
  fitNonce: number
}

export interface ExpandedGroupFrame {
  id: number
  label: string
  members: number[]
}

interface MutableNodePins {
  incoming: Set<string>
  outgoing: Set<string>
  controlInputs: Map<string, ControlRole>
}

const EMPTY_HIGHLIGHTED_BITS = new Set<number>()
const EMPTY_EXPANDED_GROUPS: ExpandedGroupFrame[] = []
const EMPTY_RELATED_CONE: RelatedCone = {
  nodeIds: new Set<number>(),
  edgeKeys: new Set<number>(),
}

export const GraphView = memo(function GraphView({
  graph,
  rootId,
  relevantIds,
  overlayIds,
  highlightedBits = EMPTY_HIGHLIGHTED_BITS,
  extendOverlayToBoundaryNets = false,
  selectedId,
  selectedNetNames = EMPTY_SELECTED_NET_NAMES,
  interactive,
  onSelect,
  onEdgeSelect,
  onControlSelect,
  onExpand,
  onExpandGroup,
  onCollapseGroup,
  expandedGroups = EMPTY_EXPANDED_GROUPS,
  active,
  fitNonce,
}: Props) {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const viewportRef = useRef<SVGGElement | null>(null)
  const hideEdgeTooltipRef = useRef<(() => void) | null>(null)
  const hideNodeTooltipRef = useRef<(() => void) | null>(null)
  const transformRef = useRef<ViewportTransform>({ x: 0, y: 0, k: 1 })
  const rovingNodeId = useRef<number | null>(null)
  const nodeElements = useRef(new Map<number, SVGGElement>())
  const programmaticFocusNodeId = useRef<number | null>(null)
  const {
    applyTransformDetail,
    clearDetailRestore,
    renderedDetailIds,
    renderedDetailLevel,
  } = useDetailLevel({ graph, stageRef, viewportRef, transformRef })
  const {
    applyTransform,
    fit,
    onPointerDown,
    onPointerMove,
    onViewportKeyDown: onViewportPanKeyDown,
    onWheel,
    cancelPan,
    finishPointer,
    suppressClickRef,
    userAdjustedRef,
    zoomBy,
  } = useViewportGestures({
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
  })

  const metadata = useMemo(() => {
    const nodeById = new Map<number, LaidOutNode>()
    const pinSetsById = new Map<number, MutableNodePins>()

    for (const laidOutNode of graph.nodes) {
      nodeById.set(laidOutNode.id, laidOutNode)
      pinSetsById.set(laidOutNode.id, {
        incoming: new Set(),
        outgoing: new Set(),
        controlInputs: new Map(),
      })
    }
    for (const edge of graph.edges) {
      const fromPins = pinSetsById.get(edge.from)
      const toPins = pinSetsById.get(edge.to)
      if (fromPins && edge.edge.from_port) fromPins.outgoing.add(edge.edge.from_port)
      if (toPins && edge.edge.to_port) {
        toPins.incoming.add(edge.edge.to_port)
        const target = nodeById.get(edge.to)?.node
        const targetKind = target ? symbolKind(target) : null
        if (
          edge.edge.control ||
          ((targetKind === 'reg' || targetKind === 'latch') &&
            isRegisterControlPin(edge.edge.to_port))
        ) {
          toPins.controlInputs.set(
            edge.edge.to_port,
            controlRoleForPin(edge.edge.to_port),
          )
        }
      }
    }

    const controlDrivers = new Set<number>()
    for (const laidOutNode of graph.nodes) {
      for (const control of controlsFor(laidOutNode.node)) {
        for (const driver of controlDriverIds(control)) {
          controlDrivers.add(driver)
        }
      }
    }
    const portNodes = graph.nodes.filter(
      (laidOutNode) => laidOutNode.node.kind === 'port',
    )
    const portDirection = inferPortDirections(
      portNodes.map((laidOutNode) => laidOutNode.id),
      graph.edges,
      controlDrivers,
      new Map(
        portNodes.flatMap((laidOutNode) =>
          laidOutNode.node.port_direction
            ? [[laidOutNode.id, laidOutNode.node.port_direction]]
            : [],
        ),
      ),
    )
    const pinsById = new Map<number, NodePins>()
    for (const [nodeId, pins] of pinSetsById) {
      pinsById.set(nodeId, {
        incoming: canonicalPinNames(pins.incoming),
        outgoing: canonicalPinNames(pins.outgoing),
        controlInputs: [...pins.controlInputs].map(([pin, role]) => ({ pin, role })),
      })
    }
    return { nodeById, pinsById, portDirection }
  }, [graph])
  const expandedGroupByMember = useMemo(() => new Map(
    expandedGroups.flatMap((group) =>
      group.members.map((member) => [member, group.id] as const),
    ),
  ), [expandedGroups])
  const selectedRelatedCone = useMemo<RelatedCone | null>(() => {
    if (selectedId == null && selectedNetNames.length === 0) {
      return null
    }
    let cone: RelatedCone
    const nodes = graph.nodes.map((laidOutNode) => ({
      id: laidOutNode.id,
      members: laidOutNode.node.members,
    }))
    if (selectedId != null) {
      cone = relatedCone(nodes, graph.edges, { kind: 'node', nodeId: selectedId })
    } else if (selectedNetNames.length > 0) {
      const names = new Set(selectedNetNames)
      const edgeKeys = graph.edges.flatMap((edge, index) =>
        names.has(edge.edge.net_name) ? [index] : [],
      )
      cone = relatedCone(nodes, graph.edges, { kind: 'edge', edgeKeys })
    } else {
      return null
    }
    return cone.nodeIds.size > 0 || cone.edgeKeys.size > 0 ? cone : null
  }, [graph.edges, graph.nodes, selectedId, selectedNetNames])
  const selectionActive = selectedRelatedCone != null
  const related = selectedRelatedCone ?? EMPTY_RELATED_CONE
  const edgeGeometry = useMemo(
    () => prepareSchematicEdgeGeometry(graph),
    [graph],
  )
  const preparedEdges = useMemo(
    () => bucketSchematicEdges(
      edgeGeometry,
      relevantIds,
      overlayIds,
      highlightedBits,
      extendOverlayToBoundaryNets,
      related.edgeKeys,
      selectionActive,
    ),
    [
      edgeGeometry,
      extendOverlayToBoundaryNets,
      highlightedBits,
      overlayIds,
      relevantIds,
      related.edgeKeys,
      selectionActive,
    ],
  )
  const selectedEdges = useMemo(() => {
    if (selectedId == null && selectedNetNames.length === 0) {
      return EMPTY_PREPARED_SCHEMATIC_EDGES
    }
    const seen = new Set<number>()
    const edges: PreparedSchematicEdge[] = []
    if (selectedId != null) {
      const selectedNode = metadata.nodeById.get(selectedId)?.node
      const endpointIds = [selectedId, ...(selectedNode?.members ?? [])]
      for (const endpointId of endpointIds) {
        for (const edge of preparedEdges.incidentByNode.get(endpointId) ?? []) {
          if (seen.has(edge.index)) continue
          seen.add(edge.index)
          edges.push(edge)
        }
      }
    }
    if (selectedNetNames.length > 0) {
      const names = new Set(selectedNetNames)
      for (const edge of preparedEdges.edges) {
        if (!names.has(edge.netName) || seen.has(edge.index)) continue
        seen.add(edge.index)
        edges.push(edge)
      }
    }
    return edges
  }, [metadata.nodeById, preparedEdges, selectedId, selectedNetNames])

  const rovingTabStopId = interactive
    ? metadata.nodeById.has(rovingNodeId.current ?? Number.NaN)
      ? rovingNodeId.current
      : metadata.nodeById.has(selectedId ?? Number.NaN)
        ? selectedId
        : metadata.nodeById.has(rootId)
          ? rootId
          : (graph.nodes[0]?.id ?? null)
    : null
  rovingNodeId.current = rovingTabStopId

  const setNodeElement = useCallback(
    (nodeId: number, element: SVGGElement | null) => {
      if (element) nodeElements.current.set(nodeId, element)
      else nodeElements.current.delete(nodeId)
    },
    [],
  )

  const focusGraphNode = useCallback((nodeId: number) => {
    const previous = rovingNodeId.current == null
      ? null
      : (nodeElements.current.get(rovingNodeId.current) ?? null)
    previous?.setAttribute('tabindex', '-1')
    const next = nodeElements.current.get(nodeId)
    if (!next) return
    rovingNodeId.current = nodeId
    next.setAttribute('tabindex', '0')

    const laidOutNode = metadata.nodeById.get(nodeId)
    const stage = stageRef.current
    if (laidOutNode && stage) {
      const rect = stage.getBoundingClientRect()
      const wrapper = stage.parentElement
      const cardRect = wrapper
        ?.querySelector<HTMLElement>('.node-card')
        ?.getBoundingClientRect()
      const bannerRect = wrapper
        ?.querySelector<HTMLElement>('.graph-banner')
        ?.getBoundingClientRect()
      const shortcutRect = stage
        .querySelector<HTMLElement>('.graph-shortcuts')
        ?.getBoundingClientRect()
      const zoomControlsRect = stage
        .querySelector<HTMLElement>('.zoom-controls')
        ?.getBoundingClientRect()
      const transform = transformRef.current
      const margin = 24
      const leftBound = margin
      const rightBound = cardRect
        ? cardRect.left - rect.left - margin
        : rect.width - margin
      const topBound = bannerRect && bannerRect.height > 0
        ? bannerRect.bottom - rect.top + margin
        : margin
      const bottomOverlayTop = Math.min(
        shortcutRect?.top ?? Number.POSITIVE_INFINITY,
        zoomControlsRect?.top ?? Number.POSITIVE_INFINITY,
      )
      const bottomBound = Number.isFinite(bottomOverlayTop)
        ? bottomOverlayTop - rect.top - margin
        : rect.height - margin
      const left = laidOutNode.x * transform.k + transform.x
      const right = (laidOutNode.x + laidOutNode.width) * transform.k + transform.x
      const top = laidOutNode.y * transform.k + transform.y
      const bottom = (laidOutNode.y + laidOutNode.height) * transform.k + transform.y
      const dx = left < leftBound
        ? leftBound - left
        : right > rightBound
          ? rightBound - right
          : 0
      const dy = top < topBound
        ? topBound - top
        : bottom > bottomBound
          ? bottomBound - bottom
          : 0
      if (dx !== 0 || dy !== 0) {
        userAdjustedRef.current = true
        applyTransform({ ...transform, x: transform.x + dx, y: transform.y + dy })
      }
    }
    programmaticFocusNodeId.current = nodeId
    next.focus()
    programmaticFocusNodeId.current = null
  }, [applyTransform, metadata.nodeById, userAdjustedRef])

  const acceptGraphNodeFocus = useCallback(
    (nodeId: number) => {
      if (programmaticFocusNodeId.current === nodeId) return
      focusGraphNode(nodeId)
    },
    [focusGraphNode],
  )

  useLayoutEffect(() => {
    if (selectedId == null || rovingNodeId.current == null) return
    focusGraphNode(rovingNodeId.current)
  }, [focusGraphNode, selectedId])

  const navigateGraphNode = useCallback(
    (nodeId: number, key: GraphNavigationKey) => {
      if (graph.nodes.length === 0) return
      if (key === 'Home') {
        focusGraphNode(graph.nodes[0].id)
        return
      }
      if (key === 'End') {
        focusGraphNode(graph.nodes[graph.nodes.length - 1].id)
        return
      }

      const current = metadata.nodeById.get(nodeId)
      if (!current) return
      const currentX = current.x + current.width / 2
      const currentY = current.y + current.height / 2
      let best: { id: number; score: number } | null = null
      for (const candidate of graph.nodes) {
        if (candidate.id === nodeId) continue
        const dx = candidate.x + candidate.width / 2 - currentX
        const dy = candidate.y + candidate.height / 2 - currentY
        const inDirection =
          (key === 'ArrowLeft' && dx < 0) ||
          (key === 'ArrowRight' && dx > 0) ||
          (key === 'ArrowUp' && dy < 0) ||
          (key === 'ArrowDown' && dy > 0)
        if (!inDirection) continue
        const primary = key === 'ArrowLeft' || key === 'ArrowRight'
          ? Math.abs(dx)
          : Math.abs(dy)
        const cross = key === 'ArrowLeft' || key === 'ArrowRight'
          ? Math.abs(dy)
          : Math.abs(dx)
        const score = primary + cross * 0.5
        if (!best || score < best.score) best = { id: candidate.id, score }
      }
      if (best) focusGraphNode(best.id)
    },
    [focusGraphNode, graph.nodes, metadata.nodeById],
  )

  const acceptNodeTargetFocus = useCallback(
    (target: EventTarget | null, boundary: Element) => {
      if (!interactive) return
      const nodeId = graphNodeId(graphNodeElement(target, boundary))
      if (nodeId != null) acceptGraphNodeFocus(nodeId)
    },
    [acceptGraphNodeFocus, interactive],
  )

  const selectNodeTarget = useCallback(
    (event: React.MouseEvent<SVGSVGElement>) => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false
        return
      }
      if (!interactive) return
      const nodeElement = graphNodeElement(event.target, event.currentTarget)
      const nodeId = graphNodeId(nodeElement)
      const laidOutNode = nodeId == null ? null : metadata.nodeById.get(nodeId)
      if (nodeElement && nodeId != null && laidOutNode) {
        event.stopPropagation()
        if (document.activeElement !== nodeElement) acceptGraphNodeFocus(nodeId)
        onSelect(laidOutNode.node)
        return
      }
      if (event.target === event.currentTarget) onSelect(null)
    },
    [
      acceptGraphNodeFocus,
      interactive,
      metadata.nodeById,
      onSelect,
      suppressClickRef,
    ],
  )

  const expandNodeTarget = useCallback(
    (event: React.MouseEvent<SVGSVGElement>) => {
      if (!interactive || !onExpand) return
      const nodeId = graphNodeId(graphNodeElement(event.target, event.currentTarget))
      const laidOutNode = nodeId == null ? null : metadata.nodeById.get(nodeId)
      if (!laidOutNode) return
      event.stopPropagation()
      onExpand(laidOutNode.node)
    },
    [interactive, metadata.nodeById, onExpand],
  )

  const onViewportKeyDown = useCallback(
    (event: React.KeyboardEvent<SVGSVGElement>) => {
      const nodeId = interactive
        ? graphNodeId(graphNodeElement(event.target, event.currentTarget))
        : null
      const laidOutNode = nodeId == null ? null : metadata.nodeById.get(nodeId)
      if (nodeId != null && laidOutNode) {
        if (GRAPH_NAVIGATION_KEYS.has(event.key)) {
          event.preventDefault()
          event.stopPropagation()
          navigateGraphNode(nodeId, event.key as GraphNavigationKey)
          return
        }
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        event.stopPropagation()
        if (event.key === 'Enter' && event.shiftKey && onExpand) {
          onExpand(laidOutNode.node)
          return
        }
        onSelect(laidOutNode.node)
        return
      }
      onViewportPanKeyDown(event)
    },
    [
      interactive,
      metadata.nodeById,
      navigateGraphNode,
      onExpand,
      onSelect,
      onViewportPanKeyDown,
    ],
  )

  return (
    <div className="graph-stage" ref={stageRef}>
      <svg
        ref={svgRef}
        width="100%"
        height="100%"
        role="region"
        aria-label="Schematic viewport. Use arrow keys to pan, plus and minus to zoom, and zero to fit."
        tabIndex={0}
        onWheel={onWheel}
        onKeyDown={onViewportKeyDown}
        onFocus={(event) => acceptNodeTargetFocus(event.target, event.currentTarget)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishPointer}
        onPointerCancel={cancelPan}
        onClick={selectNodeTarget}
        onDoubleClick={expandNodeTarget}
      >
        <g
          ref={viewportRef}
          className="g-viewport"
          data-detail-level="overview"
        >
          <SchematicEdges prepared={preparedEdges} />
          <SelectedSchematicEdges edges={selectedEdges} />

          <SchematicNodeDetailOverlays
            viewportRef={viewportRef}
            nodeById={metadata.nodeById}
            pinsById={metadata.pinsById}
            portDirection={metadata.portDirection}
            mountedIds={renderedDetailIds}
            detailLevel={renderedDetailLevel}
            rootId={rootId}
            relevantIds={relevantIds}
            overlayIds={overlayIds}
            selectedId={selectedId}
            relatedNodeIds={related.nodeIds}
            selectionActive={selectionActive}
            interactive={interactive}
            onControlSelect={onControlSelect}
          >
            <SchematicNodeShells
              graph={graph}
              rootId={rootId}
              relevantIds={relevantIds}
              overlayIds={overlayIds}
              selectedId={selectedId}
              relatedNodeIds={related.nodeIds}
              selectionActive={selectionActive}
              portDirection={metadata.portDirection}
              interactive={interactive}
              rovingTabStopId={rovingTabStopId}
              onNodeElement={setNodeElement}
              expandedGroupByMember={expandedGroupByMember}
            />
          </SchematicNodeDetailOverlays>

          <SchematicPinOverlays
            viewportRef={viewportRef}
            nodeById={metadata.nodeById}
            pinsById={metadata.pinsById}
            portDirection={metadata.portDirection}
            selectedId={selectedId}
          />

          <GroupExpansionControls
            viewportRef={viewportRef}
            graph={graph}
            expandedGroups={expandedGroups}
            relevantIds={relevantIds}
            interactive={interactive}
            onExpand={onExpandGroup}
            onCollapse={onCollapseGroup}
          />
        </g>
      </svg>

      <SchematicEdgeTooltip
        active={active}
        edges={preparedEdges.edges}
        geometryKey={graph.edges}
        stageRef={stageRef}
        svgRef={svgRef}
        viewportRef={viewportRef}
        hideRef={hideEdgeTooltipRef}
        suppressClickRef={suppressClickRef}
        onSelect={interactive ? onEdgeSelect : undefined}
      />

      <SchematicNodeTooltip
        active={active}
        stageRef={stageRef}
        svgRef={svgRef}
        hideRef={hideNodeTooltipRef}
      />

      {interactive && (
        <div className="graph-shortcuts" role="note">
          Node arrows move focus · Enter inspects · Shift+Enter or double-click
          expands · Esc clears · Viewport arrows pan · +/− zoom · 0 fits
        </div>
      )}

      <div className="zoom-controls">
        <button onClick={() => zoomBy(1.25)} title="Zoom in" aria-label="Zoom in">
          +
        </button>
        <button onClick={() => zoomBy(0.8)} title="Zoom out" aria-label="Zoom out">
          −
        </button>
        <button
          onClick={() => {
            userAdjustedRef.current = false
            fit()
          }}
          title="Fit to view"
          aria-label="Fit schematic to view"
        >
          ⤢
        </button>
      </div>
    </div>
  )
})
