import { useCallback, useEffect, useMemo, useState } from 'react'
import { GraphStatusBanner } from '../graph/GraphStatusBanner'
import { GraphToolbar } from '../graph/GraphToolbar'
import { GraphView } from '../graph/GraphView'
import { useGraphData } from '../graph/useGraphData'
import { NodeCard } from '../NodeCard'
import { EMPTY_SELECTED_NET_NAMES } from '../../lib/graph/relatedCone'
import { controlDriverIds, controlLabel } from '../../lib/graph/symbols'
import { sourceTierMessage } from '../../lib/source/sourceTiers'
import type { GraphNode } from '../../types'
import { shallowEqual, useStore } from '../../useStore'

export function Graph({ active }: { active: boolean }) {
  const store = useStore(
    ({
      analysisState,
      design,
      designRevision,
      coneReq,
      graphOptions,
      clearGraphSelection,
      registerGraphProbeReset,
      editorHighlight,
      selectSchematicNodes,
      selectSchematicNets,
      openControlCone,
    }) => ({
      analysisState,
      design,
      designRevision,
      coneReq,
      graphOptions,
      clearGraphSelection,
      registerGraphProbeReset,
      editorHighlight,
      selectSchematicNodes,
      selectSchematicNets,
      openControlCone,
    }),
    shallowEqual,
  )
  const {
    analysisState,
    design,
    designRevision,
    coneReq,
    graphOptions,
    clearGraphSelection,
    registerGraphProbeReset,
    editorHighlight,
    selectSchematicNodes,
    selectSchematicNets,
    openControlCone,
  } = store

  const [selected, setSelected] = useState<GraphNode | null>(null)
  const [selectedNetNames, setSelectedNetNames] = useState<string[]>([])
  const selectGraphNode = useCallback(
    (node: GraphNode | null) => {
      setSelected(node)
      setSelectedNetNames([])
      selectSchematicNodes(node ? [node.id] : [])
    },
    [selectSchematicNodes],
  )
  const {
    error,
    setError,
    sourceMessage,
    sourceControl,
    fitNonce,
    resetGraphProbe,
    graphInteractive,
    relevantIds,
    overlayIds,
    highlightedBits,
    rootId,
    sub,
    laid,
    visibleExpandedGroups,
    onExpandGroup,
    onCollapseGroup,
    onExpand,
    focusMode,
    loading,
    requestDesignMismatch,
    expansionDroppedNodes,
    expansionDroppedEdges,
  } = useGraphData({
    active,
    analysisState,
    design,
    designRevision,
    coneReq,
    graphOptions,
    clearGraphSelection,
    selectGraphNode,
  })

  useEffect(() => {
    registerGraphProbeReset(resetGraphProbe)
    return () => registerGraphProbeReset(null)
  }, [registerGraphProbeReset, resetGraphProbe])

  useEffect(() => {
    if (!active) return
    const clearSelection = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      clearGraphSelection()
    }
    window.addEventListener('keydown', clearSelection)
    return () => window.removeEventListener('keydown', clearSelection)
  }, [active, clearGraphSelection])

  // Net driven by the selected node (first outgoing edge) — lets the detail
  // card show a readable identity for hidden-name cells.
  const selectedNet = useMemo(() => {
    if (!sub || !selected) return null
    return sub.edges.find((edge) => edge.from === selected.id)?.net_name ?? null
  }, [sub, selected])

  const onGraphSelect = useCallback(
    (node: GraphNode | null) => {
      if (!graphInteractive) return
      selectGraphNode(node)
    },
    [graphInteractive, selectGraphNode],
  )
  const onEdgeSelect = useCallback(
    (selection: { names: string[]; bits: number[] }) => {
      if (selection.bits.length === 0) return
      setError(null)
      setSelected(null)
      setSelectedNetNames(selection.names)
      selectSchematicNets(selection)
    },
    [selectSchematicNets, setError],
  )
  const onControlSelect = useCallback(
    (control: NonNullable<GraphNode['controls']>[number]) => {
      if (!graphInteractive) return
      setSelectedNetNames([])
      selectSchematicNets({ names: [], bits: [] })
      openControlCone({
        nodes: controlDriverIds(control),
        label: controlLabel(control),
        generated: control.generated,
      })
    },
    [graphInteractive, openControlCone, selectSchematicNets],
  )
  const showLoading = loading || analysisState === 'refreshing'
  const sourceTierNotice = editorHighlight?.sourceTiers
    ? sourceTierMessage(
        editorHighlight.sourceTiers.truncated,
        editorHighlight.sourceTiers.approximate,
      )
    : null

  if (!design) return <div className="empty-state">No design yet.</div>

  return (
    <div className="graph-tab">
      <GraphToolbar graphInteractive={graphInteractive} />
      <div
        className="graph-stage-wrap"
        data-focus={focusMode}
        style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex' }}
      >
        {laid && laid.nodes.length > 0 ? (
          <GraphView
            graph={laid}
            rootId={rootId}
            relevantIds={relevantIds}
            overlayIds={overlayIds}
            highlightedBits={highlightedBits}
            extendOverlayToBoundaryNets={coneReq?.kind === 'source'}
            selectedId={graphInteractive ? (selected?.id ?? null) : null}
            selectedNetNames={
              graphInteractive ? selectedNetNames : EMPTY_SELECTED_NET_NAMES
            }
            interactive={graphInteractive}
            onSelect={onGraphSelect}
            onEdgeSelect={onEdgeSelect}
            onControlSelect={graphInteractive ? onControlSelect : undefined}
            onExpand={graphInteractive ? onExpand : undefined}
            expandedGroups={visibleExpandedGroups}
            onExpandGroup={graphInteractive ? onExpandGroup : undefined}
            onCollapseGroup={graphInteractive ? onCollapseGroup : undefined}
            active={active}
            fitNonce={fitNonce}
          />
        ) : (
          <div className="graph-stage">
            <div className="empty-state">
              {loading
                ? ''
                : error
                  ? ''
                  : sub && sub.nodes.length === 0
                    ? 'Empty cone — nothing drives/loads this node within the limits.'
                    : 'No schematic.'}
            </div>
          </div>
        )}

        <GraphStatusBanner
          showLoading={showLoading}
          error={error}
          sourceTierNotice={sourceTierNotice}
          analysisState={analysisState}
          requestDesignMismatch={requestDesignMismatch}
          sourceMessage={sourceMessage}
          sourceControl={sourceControl}
          selectionTruncated={
            coneReq?.kind === 'source' && coneReq.selectionTruncated
          }
          sub={sub}
          expansionDroppedNodes={expansionDroppedNodes}
          expansionDroppedEdges={expansionDroppedEdges}
        />

        {selected && graphInteractive && (
          <NodeCard
            node={selected}
            drivingNet={selectedNet}
            onClose={() => selectGraphNode(null)}
            onExpand={() => onExpand(selected)}
          />
        )}
      </div>
    </div>
  )
}
