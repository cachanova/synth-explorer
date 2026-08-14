import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DesignRequestError,
  expandGroup,
  getCone,
  getNetlist,
} from '../../lib/designClient'
import {
  MAX_GRAPH_RENDER_NODES,
  MAX_GROUP_EXPANSION_RENDER_NODES,
  MAX_OPEN_EXPANDED_GROUPS,
} from '../../lib/graph/graphLimits'
import { graphProjection } from '../../lib/graph/graphProjection'
import type { GraphOptions } from '../../lib/graph/graphSettings'
import {
  applyGroupExpansions,
  openExpandedGroup,
  type ExpandedGroup,
  type ExpandedGroupSpec,
} from '../../lib/graph/groupExpansion'
import { isDisplayedDesignCurrent, isRequestDesignMismatch } from '../../lib/graph/graphOwnership'
import type { LaidOutGraph } from '../../lib/graph/elkGraph'
import { layoutSubgraph, prewarmLayoutWorker } from '../../lib/graph/layoutClient'
import { mergeSubgraphs } from '../../lib/graph/mergeSubgraph'
import { shouldRefitProjection } from '../../lib/graph/viewport'
import { analyzeSourceInBrowser } from '../../lib/source/sourceSelectionClient'
import { sourceProbePresentation } from '../../lib/source/sourceProbe'
import type {
  AnalysisState,
  ConeGraphRequest,
  GraphRequest,
  SourceGraphRequest,
} from '../../store'
import type {
  GraphNode,
  SourceSelectionStatus,
  Subgraph,
  SynthesizeResponse,
} from '../../types'

interface FullSubgraph {
  designId: string
  key: string
  graph: Subgraph
}

interface RelevantSubgraph {
  designId: string
  requestKey: string
  graph: Subgraph
  relevantIds: number[]
  overlayIds: number[]
  highlightedBits: number[]
}

interface ExpansionState {
  ownerKey: string
  graph: Subgraph
  droppedNodes: number
  droppedEdges: number
}

interface DisplayedGraph {
  designId: string
  projectionKey: string
  subgraph: Subgraph
  graph: LaidOutGraph
}

interface FullGraphCacheEntry {
  key: string
  controller: AbortController
  promise: Promise<Subgraph>
}

interface UseGraphDataOptions {
  active: boolean
  analysisState: AnalysisState
  design: SynthesizeResponse | null
  designRevision: number
  coneReq: GraphRequest | null
  graphOptions: GraphOptions
  clearGraphSelection: () => void
  selectGraphNode: (node: GraphNode | null) => void
}

export function graphDataKeys(
  designId: string | undefined,
  requestNonce: number | null | undefined,
  graphOptions: GraphOptions,
) {
  const optsKey = `${graphOptions.maxDepth}|${graphOptions.maxNodes}|${graphOptions.hideControl}|${graphOptions.hideConst}|${graphOptions.groupVectors}|${graphOptions.groupMemories}`
  return {
    optsKey,
    fullGraphKey: designId
      ? `${designId}|${graphOptions.maxNodes}|${graphOptions.groupVectors}|${graphOptions.groupMemories}|${graphOptions.hideControl}|${graphOptions.hideConst}`
      : null,
    currentRequestKey: designId
      ? `${designId}|${requestNonce ?? 'full'}|${optsKey}`
      : null,
  }
}

export function fullGraphRequestOptions(
  graphOptions: Pick<
    GraphOptions,
    | 'groupMemories'
    | 'groupVectors'
    | 'hideConst'
    | 'hideControl'
    | 'maxNodes'
  >,
) {
  return {
    max_nodes: graphOptions.maxNodes,
    show_infrastructure: false,
    group_vectors: graphOptions.groupVectors,
    group_memories: graphOptions.groupMemories,
    hide_control: graphOptions.hideControl,
    hide_const: graphOptions.hideConst,
  }
}

export function coneRequestOptions(
  request: ConeGraphRequest,
  graphOptions: GraphOptions,
) {
  return {
    node: request.node,
    nodes: request.nodes.length > 1 ? request.nodes : undefined,
    dir: request.dir,
    max_depth: graphOptions.maxDepth,
    max_nodes: graphOptions.maxNodes,
    hide_control: graphOptions.hideControl,
    hide_const: graphOptions.hideConst,
    show_infrastructure: false,
    group_vectors: graphOptions.groupVectors,
    group_memories: graphOptions.groupMemories,
    root_port: request.rootPort,
    root_port_bit: request.rootPortBit,
    root_port_bits: request.rootPortBits,
  }
}

export function sourceRequestOptions(
  request: SourceGraphRequest,
  graphOptions: GraphOptions,
) {
  return {
    selection: {
      file: request.file,
      startLine: request.startLine,
      startColumn: request.startColumn,
      endLine: request.endLine,
      endColumn: request.endColumn,
      fallbackStartColumn: request.fallbackStartColumn,
      fallbackEndColumn: request.fallbackEndColumn,
    },
    filters: {
      maxNodes: graphOptions.maxNodes,
      hideControl: graphOptions.hideControl,
      hideConst: graphOptions.hideConst,
      groupVectors: graphOptions.groupVectors,
      groupMemories: graphOptions.groupMemories,
    },
  }
}

export function groupExpansionRequestOptions(
  node: number,
  expandedNodes: number[],
  graphOptions: Pick<
    GraphOptions,
    'groupMemories' | 'groupVectors' | 'hideConst' | 'hideControl'
  >,
) {
  return {
    node,
    expanded_nodes: expandedNodes,
    max_nodes: MAX_GROUP_EXPANSION_RENDER_NODES,
    hide_control: graphOptions.hideControl,
    hide_const: graphOptions.hideConst,
    group_vectors: graphOptions.groupVectors,
    group_memories: graphOptions.groupMemories,
  }
}

export function neighborhoodRequestOptions(
  node: number,
  dir: 'fanin' | 'fanout',
  graphOptions: Pick<
    GraphOptions,
    | 'groupMemories'
    | 'groupVectors'
    | 'hideConst'
    | 'hideControl'
    | 'maxNodes'
  >,
) {
  return {
    node,
    nodes: undefined,
    dir,
    max_depth: 1,
    max_nodes: graphOptions.maxNodes,
    hide_control: graphOptions.hideControl,
    hide_const: graphOptions.hideConst,
    show_infrastructure: false,
    group_vectors: graphOptions.groupVectors,
    group_memories: graphOptions.groupMemories,
  }
}

export function useGraphData({
  active,
  analysisState,
  design,
  designRevision,
  coneReq,
  graphOptions,
  clearGraphSelection,
  selectGraphNode,
}: UseGraphDataOptions) {
  const [fullSubgraph, setFullSubgraph] = useState<FullSubgraph | null>(null)
  const [relevantSubgraph, setRelevantSubgraph] =
    useState<RelevantSubgraph | null>(null)
  // Neighborhoods accumulated from double-click expansions, merged on top of the
  // active projection before layout. The owner keeps full-view expansions stable
  // while non-focus selections update only their highlights.
  const [expansionState, setExpansionState] = useState<ExpansionState | null>(null)
  const [expandedGroupSpecs, setExpandedGroupSpecs] = useState<ExpandedGroupSpec[]>([])
  const [groupExpansions, setGroupExpansions] = useState<ExpandedGroup[]>([])
  const [displayedGraph, setDisplayedGraph] = useState<DisplayedGraph | null>(null)
  const [fetchingFull, setFetchingFull] = useState(false)
  const [fetchingRelevant, setFetchingRelevant] = useState(false)
  const [fetchingGroups, setFetchingGroups] = useState(false)
  const [layingOut, setLayingOut] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sourceStatus, setSourceStatus] = useState<SourceSelectionStatus | null>(null)
  const [sourceControl, setSourceControl] = useState(false)
  const [fitNonce, setFitNonce] = useState(0)

  const reqSeq = useRef(0)
  const expansionControllers = useRef(new Set<AbortController>())
  const groupExpansionController = useRef<AbortController | null>(null)
  const loadedFullGraphKey = useRef<string | null>(null)
  const laidOutSubgraph = useRef<Subgraph | null>(null)
  const displayedGraphRef = useRef<DisplayedGraph | null>(null)
  const layoutCache = useRef(new WeakMap<Subgraph, LaidOutGraph>())
  // The full projection is independent of source/cone selection. Reusing this
  // single entry keeps non-focus selection changes free of netlist refetches.
  const fullGraphCache = useRef<FullGraphCacheEntry | null>(null)
  const currentDesignIdRef = useRef(design?.design_id)
  currentDesignIdRef.current = design?.design_id

  const { optsKey, fullGraphKey, currentRequestKey } = graphDataKeys(
    design?.design_id,
    coneReq?.nonce,
    graphOptions,
  )
  const requestDesignMismatch = isRequestDesignMismatch(design?.design_id, coneReq)

  const resetGraphProbe = useCallback(() => {
    // Reject an in-flight source result immediately; the replacement request
    // is debounced, so waiting for its effect cleanup leaves a stale commit gap.
    reqSeq.current += 1
    setFetchingRelevant(false)
    setSourceStatus(null)
    setSourceControl(false)
    setRelevantSubgraph((current) => {
      if (
        current == null ||
        (current.relevantIds.length === 0 &&
          current.overlayIds.length === 0 &&
          current.highlightedBits.length === 0)
      ) {
        return current
      }
      return {
        ...current,
        relevantIds: [],
        overlayIds: [],
        highlightedBits: [],
      }
    })
    selectGraphNode(null)
  }, [selectGraphNode])

  // ELK is a large module and this graph surface stays mounted across tabs.
  // Start its reusable worker once at mount so module startup can overlap the
  // editor's initial idle/debounce window instead of the first real layout.
  useEffect(() => {
    prewarmLayoutWorker()
  }, [])

  // Grouped projections use synthetic ids while raw projections use physical
  // ids. Never carry a detail card across a policy change.
  useEffect(
    () => selectGraphNode(null),
    [graphOptions.groupMemories, graphOptions.groupVectors, selectGraphNode],
  )
  // Node and wire selections are owned by one synthesis result. Even when a
  // resynthesis returns the same design id, it starts without a local cone.
  useEffect(
    () => selectGraphNode(null),
    [design?.design_id, designRevision, selectGraphNode],
  )

  // Per-group expansion is a presentation state owned by one synthesized
  // design and grouping policy. A new design or global policy starts clean.
  useEffect(() => {
    groupExpansionController.current?.abort()
    setExpandedGroupSpecs([])
    setGroupExpansions([])
    setFetchingGroups(false)
  }, [design?.design_id, graphOptions.groupMemories, graphOptions.groupVectors])

  // The full projection changes only with the design or analysis options.
  useEffect(() => {
    const cached = fullGraphCache.current
    if (cached && cached.key !== fullGraphKey) {
      cached.controller.abort()
      fullGraphCache.current = null
    }
  }, [fullGraphKey])
  useEffect(
    () => () => {
      fullGraphCache.current?.controller.abort()
      fullGraphCache.current = null
      for (const inFlight of expansionControllers.current) inFlight.abort()
      expansionControllers.current.clear()
      groupExpansionController.current?.abort()
      groupExpansionController.current = null
    },
    [],
  )

  const fetchFullGraph = useCallback(() => {
    if (fullGraphKey == null) return Promise.reject(new Error('missing graph cache key'))
    const cached = fullGraphCache.current
    if (cached?.key === fullGraphKey) return cached.promise
    cached?.controller.abort()
    const fullController = new AbortController()
    let entry: FullGraphCacheEntry
    // Let the selection effect in this commit post its bounded query first.
    // The analysis worker is synchronous, so queueing a whole-netlist scan
    // first would otherwise head-of-line block the responsive source result.
    const promise = Promise.resolve()
      .then(() => {
        fullController.signal.throwIfAborted()
        return getNetlist(
          fullGraphRequestOptions({
            groupMemories: graphOptions.groupMemories,
            groupVectors: graphOptions.groupVectors,
            hideConst: graphOptions.hideConst,
            hideControl: graphOptions.hideControl,
            maxNodes: graphOptions.maxNodes,
          }),
          fullController.signal,
        )
      })
      .catch((caught) => {
        if (fullGraphCache.current === entry) fullGraphCache.current = null
        throw caught
      })
    entry = { key: fullGraphKey, controller: fullController, promise }
    fullGraphCache.current = entry
    return promise
  }, [
    fullGraphKey,
    graphOptions.groupVectors,
    graphOptions.groupMemories,
    graphOptions.hideConst,
    graphOptions.hideControl,
    graphOptions.maxNodes,
  ])

  // Fetch the capped full schematic independently of selection. It is the
  // stable non-focus geometry and is also ready when Focus is turned off.
  useEffect(() => {
    if (!design || fullGraphKey == null) {
      setFullSubgraph(null)
      setRelevantSubgraph(null)
      setExpansionState(null)
      setDisplayedGraph(null)
      displayedGraphRef.current = null
      loadedFullGraphKey.current = null
      laidOutSubgraph.current = null
      return
    }
    if (!active || analysisState !== 'current') return
    if (loadedFullGraphKey.current === fullGraphKey) return

    const requestDesignId = design.design_id
    const ownerKey = fullGraphKey
    let cancelled = false
    setFetchingFull(true)
    setError(null)
    fetchFullGraph()
      .then((graph) => {
        if (cancelled || fullGraphCache.current?.key !== ownerKey) return
        loadedFullGraphKey.current = ownerKey
        setFullSubgraph({ designId: requestDesignId, key: ownerKey, graph })
      })
      .catch((caught) => {
        if (cancelled) return
        setError(caught instanceof DesignRequestError ? caught.message : String(caught))
      })
      .finally(() => {
        if (!cancelled) setFetchingFull(false)
      })
    return () => {
      cancelled = true
      setFetchingFull(false)
    }
  }, [active, analysisState, design, fetchFullGraph, fullGraphKey])

  // Source/cone requests compute relevance and overlays. They do not replace
  // the rendered graph unless Focus is on.
  useEffect(() => {
    setSourceStatus(null)
    setSourceControl(false)
    setRelevantSubgraph(null)
    if (!design || !coneReq || currentRequestKey == null || requestDesignMismatch) {
      setFetchingRelevant(false)
      return
    }
    if (!active || analysisState !== 'current') return

    const requestDesignId = design.design_id
    const request = coneReq
    const requestKey = currentRequestKey
    const myReq = ++reqSeq.current
    const controller = new AbortController()
    setFetchingRelevant(true)
    setError(null)
    selectGraphNode(null)
    const fetchRelevantGraph =
      request.kind === 'source'
        ? (() => {
            const sourceOptions = sourceRequestOptions(request, graphOptions)
            return analyzeSourceInBrowser(
              requestDesignId,
              sourceOptions.selection,
              sourceOptions.filters,
              controller.signal,
            ).then((response) => ({
              graph: response.graph,
              status: response.status,
              control: response.control,
              directIds: response.directIds,
              directBits: response.directBits,
            }))
          })()
        : getCone(coneRequestOptions(request, graphOptions), controller.signal)
            .then((graph) => ({
              graph,
              status: null,
              control: false,
              directIds: [],
              directBits: [],
            }))
    fetchRelevantGraph
      .then(({ graph, status, control, directIds, directBits }) => {
        if (controller.signal.aborted || myReq !== reqSeq.current) return
        setSourceControl(control)
        const presentation = sourceProbePresentation(status)
        if (presentation.acceptReturnedGraph) {
          setSourceStatus(status)
          setRelevantSubgraph({
            designId: requestDesignId,
            requestKey,
            graph,
            relevantIds: graph.nodes.map((node) => node.id),
            overlayIds: [
              ...request.highlight,
              ...(request.kind === 'source' && presentation.showDirectSelection
                ? directIds
                : []),
            ],
            highlightedBits:
              request.kind === 'source' && presentation.showDirectSelection
                ? directBits
                : [],
          })
          if (status != null) selectGraphNode(null)
        } else {
          clearGraphSelection()
        }
      })
      .catch((caught) => {
        if (controller.signal.aborted || myReq !== reqSeq.current) return
        setError(caught instanceof DesignRequestError ? caught.message : String(caught))
      })
      .finally(() => {
        if (!controller.signal.aborted && myReq === reqSeq.current) {
          setFetchingRelevant(false)
        }
      })
    return () => {
      controller.abort()
      setFetchingRelevant(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    active,
    analysisState,
    design?.design_id,
    coneReq?.nonce,
    optsKey,
    requestDesignMismatch,
  ])

  // Every open group is re-projected together whenever the open set changes:
  // each response has to see its neighbors expanded, otherwise a net between
  // two open groups would still terminate on a quotient node. The open set is
  // capped, which keeps this bounded. Previous expansions stay rendered until
  // the new set resolves, so opening one group does not blink the others.
  useEffect(() => {
    groupExpansionController.current?.abort()
    groupExpansionController.current = null
    if (
      !active ||
      analysisState !== 'current' ||
      !design ||
      expandedGroupSpecs.length === 0
    ) {
      setGroupExpansions([])
      setFetchingGroups(false)
      return
    }
    const controller = new AbortController()
    groupExpansionController.current = controller
    const designId = design.design_id
    const openIds = expandedGroupSpecs.map((group) => group.id)
    setFetchingGroups(true)
    Promise.all(
      expandedGroupSpecs.map((group) =>
        expandGroup(
          groupExpansionRequestOptions(group.id, openIds, {
            groupMemories: graphOptions.groupMemories,
            groupVectors: graphOptions.groupVectors,
            hideConst: graphOptions.hideConst,
            hideControl: graphOptions.hideControl,
          }),
          controller.signal,
        )
          .then((response) => ({
            expansion: { id: group.id, label: group.label, ...response },
          }))
          .catch((caught: unknown) => ({ failed: group, error: caught })),
      ),
    )
      .then((results) => {
        if (controller.signal.aborted || currentDesignIdRef.current !== designId) return
        setGroupExpansions(
          results.flatMap((result) =>
            'expansion' in result ? [result.expansion] : [],
          ),
        )
        // Only the groups that failed close again; the rest stay open.
        const failures = results.flatMap((result) =>
          'failed' in result ? [result] : [],
        )
        if (failures.length === 0) return
        const failedIds = new Set(failures.map((failure) => failure.failed.id))
        setExpandedGroupSpecs((current) =>
          current.filter((group) => !failedIds.has(group.id)),
        )
        const { error: caught } = failures[0]
        setError(
          `Could not expand group ${failures[0].failed.label}: ${
            caught instanceof DesignRequestError ? caught.message : String(caught)
          }`,
        )
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          groupExpansionController.current = null
          setFetchingGroups(false)
        }
      })
    return () => controller.abort()
  }, [
    active,
    analysisState,
    design,
    expandedGroupSpecs,
    graphOptions.groupMemories,
    graphOptions.groupVectors,
    graphOptions.hideConst,
    graphOptions.hideControl,
  ])

  const relevantRequestCurrent =
    currentRequestKey != null && relevantSubgraph?.requestKey === currentRequestKey
  const focusActive = Boolean(graphOptions.focus && coneReq)
  const projectionKey = focusActive ? currentRequestKey : fullGraphKey
  const projectedSubgraph = graphProjection(
    fullSubgraph?.key === fullGraphKey ? fullSubgraph.graph : null,
    relevantRequestCurrent ? relevantSubgraph.graph : null,
    focusActive,
  )
  const activeExpansion =
    expansionState?.ownerKey === projectionKey ? expansionState : null

  const activeExpandedIds = useMemo(
    () => new Set(expandedGroupSpecs.map((group) => group.id)),
    [expandedGroupSpecs],
  )
  const projectedNodeIds = useMemo(
    () => new Set(projectedSubgraph?.nodes.map((node) => node.id) ?? []),
    [projectedSubgraph],
  )
  const activeGroupExpansions = useMemo(
    () => groupExpansions.filter((group) =>
      activeExpandedIds.has(group.id) && projectedNodeIds.has(group.id),
    ),
    [activeExpandedIds, groupExpansions, projectedNodeIds],
  )

  // Merge ordinary one-hop context before applying the one open quotient group.
  const groupedBase = useMemo(() => {
    if (!projectedSubgraph) return null
    const expanded = mergeSubgraphs(
      projectedSubgraph,
      activeExpansion?.graph ?? null,
      MAX_GRAPH_RENDER_NODES,
    )
    return {
      graph: expanded.graph,
      expansionDroppedNodes:
        (activeExpansion?.droppedNodes ?? 0) + expanded.droppedNodes,
      expansionDroppedEdges:
        (activeExpansion?.droppedEdges ?? 0) + expanded.droppedEdges,
    }
  }, [activeExpansion, projectedSubgraph])

  // The selected projection is merged only with group expansions that belong
  // to it. Applying a group does not rebuild the stable grouped base above.
  const combined = useMemo(() => {
    if (!groupedBase) return null
    const applied = applyGroupExpansions(
      groupedBase.graph,
      activeGroupExpansions,
      MAX_GROUP_EXPANSION_RENDER_NODES,
    )
    return {
      graph: applied.graph,
      expandedGroups: applied.groups,
      expansionDroppedNodes: groupedBase.expansionDroppedNodes,
      expansionDroppedEdges: groupedBase.expansionDroppedEdges,
    }
  }, [activeGroupExpansions, groupedBase])
  const combinedSubgraph = combined?.graph ?? null
  const visibleExpandedGroups = useMemo(
    () => combined?.expandedGroups ?? [],
    [combined],
  )
  const expandedGroupsForLayout = useMemo(() => {
    const referenceHeightById = new Map(
      expandedGroupSpecs.map((group) => [group.id, group.referenceHeight]),
    )
    return visibleExpandedGroups.map((group) => ({
      id: group.id,
      members: group.members,
      referenceHeight: referenceHeightById.get(group.id),
    }))
  }, [expandedGroupSpecs, visibleExpandedGroups])

  // Lay out only while visible, and retain a completed layout across tabs.
  useEffect(() => {
    if (!active) return
    if (!combinedSubgraph || projectionKey == null) return
    if (laidOutSubgraph.current === combinedSubgraph) return
    const ownerDesignId = focusActive
      ? relevantSubgraph?.designId
      : fullSubgraph?.designId
    if (ownerDesignId == null) return
    const toLayout = combinedSubgraph
    const previousDisplay = displayedGraphRef.current
    const sameDesign = previousDisplay?.designId === ownerDesignId
    const sameProjection =
      sameDesign && previousDisplay.projectionKey === projectionKey
    const shouldRefit = shouldRefitProjection(sameDesign, sameProjection)
    const cachedLayout = layoutCache.current.get(toLayout)
    if (cachedLayout) {
      const nextDisplay = {
        designId: ownerDesignId,
        projectionKey,
        subgraph: toLayout,
        graph: cachedLayout,
      }
      displayedGraphRef.current = nextDisplay
      setDisplayedGraph(nextDisplay)
      laidOutSubgraph.current = toLayout
      if (shouldRefit) setFitNonce((nonce) => nonce + 1)
      return
    }
    let cancelled = false
    const controller = new AbortController()
    setLayingOut(true)
    // Opening or closing a group replaces the quotient node with an ELK
    // compound. ELK re-renders the complete projection so the members remain
    // together and surrounding nets route around their dashed boundary.
    layoutSubgraph(toLayout, controller.signal, expandedGroupsForLayout)
      .then((graph) => {
        if (cancelled) return
        const nextDisplay = {
          designId: ownerDesignId,
          projectionKey,
          subgraph: toLayout,
          graph,
        }
        layoutCache.current.set(toLayout, graph)
        displayedGraphRef.current = nextDisplay
        setDisplayedGraph(nextDisplay)
        laidOutSubgraph.current = toLayout
        setLayingOut(false)
        if (shouldRefit) setFitNonce((nonce) => nonce + 1)
      })
      .catch((caught) => {
        if (cancelled || controller.signal.aborted) return
        setError(String(caught instanceof Error ? caught.message : caught))
        laidOutSubgraph.current = null
        setLayingOut(false)
      })
    return () => {
      cancelled = true
      controller.abort()
      setLayingOut(false)
    }
  }, [
    active,
    combinedSubgraph,
    focusActive,
    fullSubgraph?.designId,
    projectionKey,
    relevantSubgraph?.designId,
    expandedGroupsForLayout,
  ])

  const displayedDesignCurrent = isDisplayedDesignCurrent(
    design?.design_id,
    displayedGraph?.designId,
  )
  // Keep completed layouts cached, but never render a schematic for stale
  // synthesis inputs or while the replacement design is still being laid out.
  const visibleDisplayedGraph =
    analysisState === 'current' && displayedDesignCurrent ? displayedGraph : null
  const sub = visibleDisplayedGraph?.subgraph ?? null
  const laid = visibleDisplayedGraph?.graph ?? null
  const sourcePresentation = sourceProbePresentation(sourceStatus)
  const displayedProjectionCurrent =
    projectionKey != null && displayedGraph?.projectionKey === projectionKey
  const graphInteractive =
    analysisState === 'current' && displayedDesignCurrent && displayedProjectionCurrent
  const relevantIds = useMemo(
    () => new Set<number>([
      ...(relevantRequestCurrent ? (relevantSubgraph?.relevantIds ?? []) : []),
      ...(activeExpansion?.graph.nodes.map((node) => node.id) ?? []),
      ...activeGroupExpansions.flatMap((group) => group.members),
    ]),
    [
      activeExpansion,
      activeGroupExpansions,
      relevantRequestCurrent,
      relevantSubgraph?.relevantIds,
    ],
  )
  const overlayIds = useMemo(() => {
    const ids = new Set<number>(
      relevantRequestCurrent ? (relevantSubgraph?.overlayIds ?? []) : [],
    )
    // A grouped bus node collapses per-bit ids the highlight set names, so it
    // must highlight when any of its members does (e.g. a path through a bus).
    for (const node of sub?.nodes ?? []) {
      if (node.members?.some((member) => ids.has(member))) ids.add(node.id)
    }
    for (const group of activeGroupExpansions) {
      if (ids.has(group.id)) {
        for (const member of group.members) ids.add(member)
      }
    }
    return ids
  }, [activeGroupExpansions, relevantRequestCurrent, relevantSubgraph?.overlayIds, sub])
  const highlightedBits = useMemo(
    () => new Set<number>(
      relevantRequestCurrent ? (relevantSubgraph?.highlightedBits ?? []) : [],
    ),
    [relevantRequestCurrent, relevantSubgraph?.highlightedBits],
  )
  const rootId =
    relevantRequestCurrent && coneReq?.kind === 'cone' ? coneReq.node : -1

  const onExpandGroup = useCallback((node: GraphNode) => {
    if (node.member_count == null && node.members == null) return
    const referenceHeight = displayedGraphRef.current?.graph.height
    if (referenceHeight == null) return
    if (expandedGroupSpecs.length >= MAX_OPEN_EXPANDED_GROUPS) {
      setError(
        `Close a group before opening another — at most ${MAX_OPEN_EXPANDED_GROUPS} groups can be open at once.`,
      )
      return
    }
    selectGraphNode(null)
    setError(null)
    setExpandedGroupSpecs((current) => openExpandedGroup(
      current,
      { id: node.id, label: node.name || node.cell_type || 'group' },
      referenceHeight,
    ))
  }, [expandedGroupSpecs.length, selectGraphNode])

  const onCollapseGroup = useCallback((groupId: number) => {
    selectGraphNode(null)
    setExpandedGroupSpecs((current) =>
      current.filter((group) => group.id !== groupId),
    )
  }, [selectGraphNode])

  const onExpand = useCallback((node: GraphNode) => {
    if (!design?.design_id || !graphInteractive || !displayedGraph?.projectionKey) return
    setError(null)
    // Group projections expose a stable synthetic id. The grouped API
    // contract resolves that id in the worker, avoiding unbounded messages
    // and the public 200-root limit for wide vectors.
    const ownerKey = displayedGraph.projectionKey
    const controller = new AbortController()
    expansionControllers.current.add(controller)
    Promise.all([
      getCone(
        neighborhoodRequestOptions(node.id, 'fanin', {
          groupMemories: graphOptions.groupMemories,
          groupVectors: graphOptions.groupVectors,
          hideConst: graphOptions.hideConst,
          hideControl: graphOptions.hideControl,
          maxNodes: graphOptions.maxNodes,
        }),
        controller.signal,
      ),
      getCone(
        neighborhoodRequestOptions(node.id, 'fanout', {
          groupMemories: graphOptions.groupMemories,
          groupVectors: graphOptions.groupVectors,
          hideConst: graphOptions.hideConst,
          hideControl: graphOptions.hideControl,
          maxNodes: graphOptions.maxNodes,
        }),
        controller.signal,
      ),
    ])
      .then(([fanin, fanout]) => {
        // Drop stale results if the rendered projection changed while fetching.
        if (
          controller.signal.aborted ||
          displayedGraphRef.current?.projectionKey !== ownerKey
        ) return
        // A depth-1 neighborhood is deliberately shallow, so its truncated
        // flag (hit the depth limit) is expected and must not mark the whole
        // view truncated — only the base cone and render cap do that.
        const clear = (graph: Subgraph): Subgraph => ({ ...graph, truncated: false })
        setExpansionState((previous) => {
          const owned = previous?.ownerKey === ownerKey ? previous : null
          const accumulated = owned?.graph ?? { nodes: [], edges: [], truncated: false }
          const withFanin = mergeSubgraphs(
            accumulated,
            clear(fanin),
            MAX_GRAPH_RENDER_NODES,
          )
          const withFanout = mergeSubgraphs(
            withFanin.graph,
            clear(fanout),
            MAX_GRAPH_RENDER_NODES,
          )
          return {
            ownerKey,
            graph: withFanout.graph,
            droppedNodes:
              (owned?.droppedNodes ?? 0) +
              withFanin.droppedNodes +
              withFanout.droppedNodes,
            droppedEdges:
              (owned?.droppedEdges ?? 0) +
              withFanin.droppedEdges +
              withFanout.droppedEdges,
          }
        })
      })
      .catch((caught) => {
        if (
          controller.signal.aborted ||
          displayedGraphRef.current?.projectionKey !== ownerKey
        ) return
        setError(
          `Could not expand ${node.name || node.id}: ${
            caught instanceof DesignRequestError ? caught.message : String(caught)
          }`,
        )
      })
      .finally(() => expansionControllers.current.delete(controller))
  }, [
    design?.design_id,
    displayedGraph?.projectionKey,
    graphInteractive,
    graphOptions.groupVectors,
    graphOptions.groupMemories,
    graphOptions.hideConst,
    graphOptions.hideControl,
    graphOptions.maxNodes,
  ])

  const focusMode =
    relevantRequestCurrent && relevantIds.size > 0
      ? focusActive
        ? 'on'
        : 'off'
      : undefined

  return {
    error,
    setError,
    sourceMessage: sourcePresentation.message,
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
    loading: fetchingFull || fetchingRelevant || fetchingGroups || layingOut,
    requestDesignMismatch,
    expansionDroppedNodes: combined?.expansionDroppedNodes ?? 0,
    expansionDroppedEdges: combined?.expansionDroppedEdges ?? 0,
  }
}
