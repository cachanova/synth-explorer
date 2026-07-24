import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react'
import {
  ApiRequestError,
  expandGroup,
  getCone,
  getNetlist,
  getSourceRangesForBits,
} from '../../api'
import { analyzeSourceInBrowser } from '../../lib/sourceSelectionClient'
import {
  MAX_GRAPH_RENDER_NODES,
  MAX_GROUP_EXPANSION_RENDER_NODES,
} from '../../lib/graphLimits'
import { graphProjection } from '../../lib/graphProjection'
import {
  applyGroupExpansions,
  cachedGroupExpansion,
  cacheGroupExpansion,
  createGroupExpansionCache,
  groupExpansionReducer,
  initialGroupExpansionState,
  resetGroupExpansionCache,
} from '../../lib/groupExpansion'
import {
  cacheGroupLayout,
  cachedGroupLayout,
  createGroupLayoutSession,
  resetGroupLayoutSession,
} from '../../lib/groupLayoutSession'
import {
  createLatestRequestQueue,
  type LatestRequestQueue,
} from '../../lib/latest'
import { mergeSubgraphs } from '../../lib/mergeSubgraph'
import { isDisplayedDesignCurrent } from '../../lib/graphOwnership'
import {
  comparisonLayoutEngine,
  layoutCollapsedGroupWithSchemWeave,
  layoutExpandedGroupWithSchemWeave,
  layoutSubgraph,
  prewarmLayoutWorker,
  refreshSchemWeaveLayout,
  shouldRefitProjection,
  type ExpandedGroupLayout,
  type LaidOutGraph,
} from '../../lib/layout'
import {
  sourceProbePresentation,
  sourceRangeProbeMessage,
} from '../../lib/sourceProbe'
import { controlDriverIds, controlLabel } from '../../lib/symbols'
import type { GraphNode, SourceSelectionStatus, Subgraph } from '../../types'
import { shallowEqual, useStore } from '../../useStore'
import { BubbleLoader } from '../BubbleLoader'
import { GraphView } from '../GraphView'
import { NodeCard } from '../NodeCard'

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
  expandedGroups: Array<{ id: number; label: string; members: number[] }>
}

interface FullGraphCacheEntry {
  key: string
  controller: AbortController
  promise: Promise<Subgraph>
}

interface EdgeSourceProbe {
  designId: string
  bits: number[]
}

export function Graph({ active }: { active: boolean }) {
  const layoutEngine = useMemo(
    () => comparisonLayoutEngine(window.location.search),
    [],
  )
  const store = useStore(
    ({
      analysisState,
      activeFileName,
      design,
      coneReq,
      graphOptions,
      clearGraphSelection,
      registerGraphProbeReset,
      highlightSources,
      highlightNodeSources,
      openControlCone,
    }) => ({
      analysisState,
      activeFileName,
      design,
      coneReq,
      graphOptions,
      clearGraphSelection,
      registerGraphProbeReset,
      highlightSources,
      highlightNodeSources,
      openControlCone,
    }),
    shallowEqual,
  )
  const {
    analysisState,
    activeFileName,
    design,
    coneReq,
    graphOptions,
    clearGraphSelection,
    registerGraphProbeReset,
    highlightSources,
    highlightNodeSources,
    openControlCone,
  } = store

  const [fullSubgraph, setFullSubgraph] = useState<FullSubgraph | null>(null)
  const [relevantSubgraph, setRelevantSubgraph] =
    useState<RelevantSubgraph | null>(null)
  // Neighborhoods accumulated from double-click expansions, merged on top of the
  // active projection before layout. The owner keeps full-view expansions stable
  // while non-focus selections update only their highlights.
  const [expansionState, setExpansionState] = useState<ExpansionState | null>(null)
  const [groupExpansionState, dispatchGroupExpansion] = useReducer(
    groupExpansionReducer,
    undefined,
    initialGroupExpansionState,
  )
  const [displayedGraph, setDisplayedGraph] = useState<DisplayedGraph | null>(null)
  const [fetchingFull, setFetchingFull] = useState(false)
  const [fetchingRelevant, setFetchingRelevant] = useState(false)
  const [fetchingGroups, setFetchingGroups] = useState(false)
  const [layingOut, setLayingOut] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sourceProbeNotice, setSourceProbeNotice] = useState<string | null>(null)
  const [selected, setSelected] = useState<GraphNode | null>(null)
  const [sourceStatus, setSourceStatus] = useState<SourceSelectionStatus | null>(null)
  const [sourceControl, setSourceControl] = useState(false)
  const [fitNonce, setFitNonce] = useState(0)
  const reqSeq = useRef(0)
  const expansionControllers = useRef(new Set<AbortController>())
  const groupExpansionControllers = useRef(new Map<number, AbortController>())
  const groupExpansionControllerKeys = useRef(new Map<number, string>())
  const groupExpansionRequestContext = useRef<string | null>(null)
  const groupExpansionCache = useRef(createGroupExpansionCache())
  const loadedFullGraphKey = useRef<string | null>(null)
  const laidOutSubgraph = useRef<Subgraph | null>(null)
  const displayedGraphRef = useRef<DisplayedGraph | null>(null)
  const pendingGroupCollapse = useRef<{
    groupId: number
    display: DisplayedGraph
    groups: ExpandedGroupLayout[]
  } | null>(null)
  const layoutCache = useRef(new WeakMap<Subgraph, LaidOutGraph>())
  const groupLayoutSession = useRef(createGroupLayoutSession())
  // The full projection is independent of source/cone selection. Reusing this
  // single entry keeps non-focus selection changes free of netlist refetches.
  const fullGraphCache = useRef<FullGraphCacheEntry | null>(null)
  const currentDesignIdRef = useRef(design?.design_id)
  currentDesignIdRef.current = design?.design_id
  const highlightSourcesRef = useRef(highlightSources)
  highlightSourcesRef.current = highlightSources
  const edgeSourceProbeRef = useRef<LatestRequestQueue<EdgeSourceProbe> | null>(null)
  if (!edgeSourceProbeRef.current) {
    edgeSourceProbeRef.current = createLatestRequestQueue(
      ({ designId, bits }: EdgeSourceProbe) => getSourceRangesForBits(designId, bits),
      (response, request) => {
        if (currentDesignIdRef.current !== request.designId) return
        setSourceProbeNotice(
          sourceRangeProbeMessage(response.truncated, response.approximate),
        )
        highlightSourcesRef.current(
          response.ranges.map((range) => ({
            file: range.file,
            startLine: range.start_line,
            startCol: range.start_column ?? 1,
            endLine: range.end_line,
            endCol: range.end_column ?? range.start_column ?? 1,
            exact: range.start_column != null && range.end_column != null,
          })),
        )
      },
      (cause, request) => {
        if (currentDesignIdRef.current !== request.designId) return
        setSourceProbeNotice(null)
        setError(cause instanceof Error ? cause.message : String(cause))
      },
    )
  }
  const resetGraphProbe = useCallback(() => {
    // Reject an in-flight source result immediately; the replacement request
    // is debounced, so waiting for its effect cleanup leaves a stale commit gap.
    reqSeq.current += 1
    setFetchingRelevant(false)
    edgeSourceProbeRef.current?.cancel()
    setSourceProbeNotice(null)
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
    setSelected(null)
  }, [])

  useEffect(() => {
    registerGraphProbeReset(resetGraphProbe)
    return () => registerGraphProbeReset(null)
  }, [registerGraphProbeReset, resetGraphProbe])

  // Layout engines are large modules and this graph surface stays mounted
  // across tabs. Start the selected reusable worker once at mount so startup
  // overlaps the editor's initial idle/debounce window.
  useEffect(() => {
    prewarmLayoutWorker(layoutEngine)
  }, [layoutEngine])

  useEffect(() => {
    if (!active) return
    const clearSelection = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      clearGraphSelection()
    }
    window.addEventListener('keydown', clearSelection)
    return () => window.removeEventListener('keydown', clearSelection)
  }, [active, clearGraphSelection])

  // Every option changes a graph projection. Source projections are local;
  // full and node-cone projections still come from the analysis worker.
  const optsKey = `${graphOptions.maxDepth}|${graphOptions.maxNodes}|${graphOptions.hideControl}|${graphOptions.hideConst}|${graphOptions.groupVectors}|${graphOptions.groupMemories}`
  const fullGraphKey = design
    ? `${design.design_id}|${graphOptions.maxNodes}|${graphOptions.groupVectors}|${graphOptions.groupMemories}|${graphOptions.hideControl}|${graphOptions.hideConst}`
    : null
  const currentRequestKey = design
    ? `${design.design_id}|${coneReq?.nonce ?? 'full'}|${optsKey}`
    : null
  const groupExpansionOwnerKey = design
    ? `${design.design_id}|${graphOptions.groupVectors}|${graphOptions.groupMemories}`
    : null
  const {
    specs: expandedGroupSpecs,
    expansions: groupExpansions,
  } = useMemo(
    () => groupExpansionState.ownerKey === groupExpansionOwnerKey
      ? groupExpansionState
      : { specs: [], expansions: [] },
    [groupExpansionOwnerKey, groupExpansionState],
  )
  const groupExpansionDataContext = groupExpansionOwnerKey
    ? [
        groupExpansionOwnerKey,
        graphOptions.hideControl,
        graphOptions.hideConst,
      ].join('|')
    : null
  const groupExpansionRequestKeyById = useMemo(() => {
    const keys = new Map<number, string>()
    if (!groupExpansionDataContext) return keys
    const prefix: number[] = []
    for (const group of expandedGroupSpecs) {
      prefix.push(group.id)
      keys.set(group.id, `${groupExpansionDataContext}|${prefix.join(',')}`)
    }
    return keys
  }, [expandedGroupSpecs, groupExpansionDataContext])
  const requestDesignMismatch = Boolean(
    design && coneReq?.kind === 'cone' && coneReq.designId !== design.design_id,
  )

  // Grouped projections use synthetic ids while raw projections use physical
  // ids. Never carry a detail card across a policy change.
  useEffect(() => setSelected(null), [graphOptions.groupMemories, graphOptions.groupVectors])

  // Per-group expansion is a presentation state owned by one synthesized
  // design and grouping policy. A new design or global policy starts clean.
  useEffect(() => {
    for (const controller of groupExpansionControllers.current.values()) {
      controller.abort()
    }
    groupExpansionControllers.current.clear()
    groupExpansionControllerKeys.current.clear()
    groupExpansionRequestContext.current = null
    resetGroupExpansionCache(
      groupExpansionCache.current,
      null,
    )
    dispatchGroupExpansion({ type: 'reset', ownerKey: groupExpansionOwnerKey })
    pendingGroupCollapse.current = null
    setFetchingGroups(false)
  }, [groupExpansionOwnerKey])

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
      edgeSourceProbeRef.current?.cancel()
      for (const inFlight of expansionControllers.current) inFlight.abort()
      expansionControllers.current.clear()
      for (const controller of groupExpansionControllers.current.values()) {
        controller.abort()
      }
      groupExpansionControllers.current.clear()
      groupExpansionControllerKeys.current.clear()
    },
    [],
  )
  useEffect(() => {
    edgeSourceProbeRef.current?.cancel()
    setSourceProbeNotice(null)
  }, [active, activeFileName, coneReq, design?.design_id])

  const fetchFullGraph = useCallback(
    (requestDesignId: string) => {
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
            requestDesignId,
            {
              max_nodes: graphOptions.maxNodes,
              show_infrastructure: false,
              group_vectors: graphOptions.groupVectors,
              group_memories: graphOptions.groupMemories,
              hide_control: graphOptions.hideControl,
              hide_const: graphOptions.hideConst,
            },
            fullController.signal,
          )
        })
        .catch((error) => {
          if (fullGraphCache.current === entry) fullGraphCache.current = null
          throw error
        })
      entry = { key: fullGraphKey, controller: fullController, promise }
      fullGraphCache.current = entry
      return promise
    },
    [
      fullGraphKey,
      graphOptions.groupVectors,
      graphOptions.groupMemories,
      graphOptions.hideConst,
      graphOptions.hideControl,
      graphOptions.maxNodes,
    ],
  )

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
    fetchFullGraph(requestDesignId)
      .then((graph) => {
        if (cancelled || fullGraphCache.current?.key !== ownerKey) return
        loadedFullGraphKey.current = ownerKey
        setFullSubgraph({ designId: requestDesignId, key: ownerKey, graph })
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof ApiRequestError ? e.message : String(e))
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
    setSelected(null)
    const fetchRelevantGraph =
      request.kind === 'source'
        ? analyzeSourceInBrowser(requestDesignId, {
            file: request.file,
            startLine: request.startLine,
            startColumn: request.startColumn,
            endLine: request.endLine,
            endColumn: request.endColumn,
            fallbackStartColumn: request.fallbackStartColumn,
            fallbackEndColumn: request.fallbackEndColumn,
          }, {
            maxNodes: graphOptions.maxNodes,
            hideControl: graphOptions.hideControl,
            hideConst: graphOptions.hideConst,
            groupVectors: graphOptions.groupVectors,
            groupMemories: graphOptions.groupMemories,
          }, controller.signal).then((response) => ({
            graph: response.graph,
            status: response.status,
            control: response.control,
            directIds: response.directIds,
            directBits: response.directBits,
          }))
        : getCone(requestDesignId, {
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
          }, controller.signal).then((graph) => ({
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
          if (status != null) setSelected(null)
        } else {
          clearGraphSelection()
        }
      })
      .catch((e) => {
        if (controller.signal.aborted || myReq !== reqSeq.current) return
        setError(e instanceof ApiRequestError ? e.message : String(e))
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

  // Fetch each open group independently. Controllers and responses are keyed
  // by the stable synthetic group id, so closing one group cannot cancel or
  // discard any other open group.
  useEffect(() => {
    const controllers = groupExpansionControllers.current
    const controllerKeys = groupExpansionControllerKeys.current
    if (
      !active ||
      analysisState !== 'current' ||
      !design ||
      !groupExpansionOwnerKey ||
      !groupExpansionDataContext ||
      expandedGroupSpecs.length === 0
    ) {
      for (const controller of controllers.values()) controller.abort()
      controllers.clear()
      controllerKeys.clear()
      groupExpansionRequestContext.current = null
      if (groupExpansionOwnerKey) {
        dispatchGroupExpansion({
          type: 'invalidate',
          ownerKey: groupExpansionOwnerKey,
        })
      }
      setFetchingGroups(false)
      return
    }

    const designId = design.design_id
    const desiredIds = new Set(expandedGroupSpecs.map((group) => group.id))
    const requestContext = groupExpansionDataContext
    const contextChanged = groupExpansionRequestContext.current !== requestContext
    if (contextChanged) {
      for (const controller of controllers.values()) controller.abort()
      controllers.clear()
      controllerKeys.clear()
      groupExpansionRequestContext.current = requestContext
      dispatchGroupExpansion({
        type: 'invalidate',
        ownerKey: groupExpansionOwnerKey,
      })
    }

    for (const [id, controller] of controllers) {
      if (
        desiredIds.has(id) &&
        controllerKeys.get(id) === groupExpansionRequestKeyById.get(id)
      ) {
        continue
      }
      controller.abort()
      controllers.delete(id)
      controllerKeys.delete(id)
    }
    const loadedRequestKeyById = contextChanged
      ? new Map<number, string>()
      : new Map(groupExpansions.map((group) => [group.id, group.requestKey]))
    const expandedPrefix: number[] = []
    for (const group of expandedGroupSpecs) {
      expandedPrefix.push(group.id)
      const requestKey = groupExpansionRequestKeyById.get(group.id)
      if (!requestKey) continue
      if (
        loadedRequestKeyById.get(group.id) === requestKey ||
        controllers.has(group.id)
      ) {
        continue
      }
      const cached = cachedGroupExpansion(
        groupExpansionCache.current,
        requestContext,
        requestKey,
      )
      if (cached?.id === group.id) {
        loadedRequestKeyById.set(group.id, requestKey)
        dispatchGroupExpansion({
          type: 'loaded',
          ownerKey: groupExpansionOwnerKey,
          expansion: cached,
        })
        continue
      }
      const controller = new AbortController()
      controllers.set(group.id, controller)
      controllerKeys.set(group.id, requestKey)
      setFetchingGroups(true)
      expandGroup(designId, {
        node: group.id,
        expanded_nodes: [...expandedPrefix],
        max_nodes: MAX_GROUP_EXPANSION_RENDER_NODES,
        hide_control: graphOptions.hideControl,
        hide_const: graphOptions.hideConst,
        group_vectors: graphOptions.groupVectors,
        group_memories: graphOptions.groupMemories,
      }, controller.signal)
        .then((response) => ({
          id: group.id,
          label: group.label,
          requestKey,
          ...response,
        }))
        .then((expansion) => {
          if (
            controller.signal.aborted ||
            currentDesignIdRef.current !== designId ||
            groupExpansionRequestContext.current !== requestContext ||
            controllerKeys.get(group.id) !== requestKey
          ) {
            return
          }
          cacheGroupExpansion(
            groupExpansionCache.current,
            requestContext,
            expansion,
          )
          dispatchGroupExpansion({
            type: 'loaded',
            ownerKey: groupExpansionOwnerKey,
            expansion,
          })
        })
        .catch((e) => {
          if (controller.signal.aborted) return
          dispatchGroupExpansion({
            type: 'failed',
            ownerKey: groupExpansionOwnerKey,
            id: group.id,
          })
          setError(
            `Could not expand group: ${e instanceof ApiRequestError ? e.message : String(e)}`,
          )
        })
        .finally(() => {
          if (controllers.get(group.id) === controller) {
            controllers.delete(group.id)
            controllerKeys.delete(group.id)
          }
          setFetchingGroups(controllers.size > 0)
        })
    }
    setFetchingGroups(controllers.size > 0)
  }, [
    active,
    analysisState,
    design,
    expandedGroupSpecs,
    groupExpansionDataContext,
    groupExpansionOwnerKey,
    groupExpansionRequestKeyById,
    groupExpansions,
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
      activeExpandedIds.has(group.id) &&
      projectedNodeIds.has(group.id) &&
      group.requestKey === groupExpansionRequestKeyById.get(group.id),
    ),
    [
      activeExpandedIds,
      groupExpansionRequestKeyById,
      groupExpansions,
      projectedNodeIds,
    ],
  )
  const waitingForVisibleGroupExpansions = useMemo(() => {
    const loadedIds = new Set(activeGroupExpansions.map((group) => group.id))
    return expandedGroupSpecs.some(
      (group) => projectedNodeIds.has(group.id) && !loadedIds.has(group.id),
    )
  }, [activeGroupExpansions, expandedGroupSpecs, projectedNodeIds])

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
      groupedBaseGraph: groupedBase.graph,
      expandedGroups: applied.groups,
      expansionDroppedNodes: groupedBase.expansionDroppedNodes,
      expansionDroppedEdges: groupedBase.expansionDroppedEdges,
    }
  }, [activeGroupExpansions, groupedBase])
  const combinedSubgraph = combined?.graph ?? null
  const groupedBaseSubgraph = combined?.groupedBaseGraph ?? null
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

  useEffect(() => {
    resetGroupLayoutSession(groupLayoutSession.current, groupedBaseSubgraph)
  }, [groupedBaseSubgraph])

  // Lay out only while visible, and retain a completed layout across tabs.
  useEffect(() => {
    if (!active) return
    if (!combinedSubgraph || projectionKey == null) return
    if (laidOutSubgraph.current === combinedSubgraph) return
    const ownerDesignId = focusActive
      ? relevantSubgraph?.designId
      : fullSubgraph?.designId
    if (ownerDesignId == null) return
    // Adding a lower-id group changes the canonical prefix of every later
    // group. Keep the last complete layout visible until every visible prefix
    // has reloaded instead of briefly rendering the compact projection.
    if (waitingForVisibleGroupExpansions) return
    const pendingCollapse = pendingGroupCollapse.current
    if (
      layoutEngine === 'schemweave' &&
      pendingCollapse &&
      pendingCollapse.display.designId === ownerDesignId &&
      pendingCollapse.display.projectionKey === projectionKey
    ) {
      const desiredIds = pendingCollapse.groups
        .filter((group) => group.id !== pendingCollapse.groupId)
        .map((group) => group.id)
      const specIds = expandedGroupSpecs.map((group) => group.id)
      const activeIds = new Set(
        activeGroupExpansions.map((group) => group.id),
      )
      const desiredStateCurrent =
        desiredIds.length === specIds.length &&
        desiredIds.every((id, index) => id === specIds[index])
      if (!desiredStateCurrent) {
        pendingGroupCollapse.current = null
      } else if (
        activeIds.size !== desiredIds.length ||
        desiredIds.some((id) => !activeIds.has(id))
      ) {
        // Closing a non-tail group changes every later prefix key. Keep the
        // previous complete layout visible until all surviving projections
        // have reloaded, then perform one inverse collapse from that geometry.
        return
      }
    }
    const toLayout = combinedSubgraph
    const previousDisplay = displayedGraphRef.current
    const sameDesign = previousDisplay?.designId === ownerDesignId
    const sameProjection =
      sameDesign &&
      previousDisplay.projectionKey === projectionKey
    const shouldRefit = (nextGraph: LaidOutGraph) =>
      shouldRefitProjection(
        previousDisplay?.graph,
        nextGraph,
        sameDesign,
        sameProjection,
      )
    const cachedLayout = layoutCache.current.get(toLayout)
    if (cachedLayout) {
      const nextDisplay = {
        designId: ownerDesignId,
        projectionKey,
        subgraph: toLayout,
        graph: cachedLayout,
        expandedGroups: visibleExpandedGroups,
      }
      displayedGraphRef.current = nextDisplay
      setDisplayedGraph(nextDisplay)
      laidOutSubgraph.current = toLayout
      if (shouldRefit(cachedLayout)) setFitNonce((n) => n + 1)
      return
    }
    const groupedBaseLayout = groupedBaseSubgraph
      ? layoutCache.current.get(groupedBaseSubgraph)
      : null
    let cancelled = false
    const controller = new AbortController()
    setLayingOut(true)
    const expandWithSchemWeave = async (groups: ExpandedGroupLayout[]) => {
      let baseLayout = groupedBaseLayout
      if (!baseLayout && groupedBaseSubgraph) {
        baseLayout = await layoutSubgraph(
          groupedBaseSubgraph,
          controller.signal,
          'schemweave',
        )
        layoutCache.current.set(groupedBaseSubgraph, baseLayout)
      }
      if (!baseLayout || !groupedBaseSubgraph) {
        return layoutSubgraph(
          toLayout,
          controller.signal,
          layoutEngine,
          expandedGroupsForLayout,
        )
      }
      const expansionById = new Map(
        activeGroupExpansions.map((expansion) => [expansion.id, expansion]),
      )
      const sequence = groups.map((group) => {
        const response = expansionById.get(group.id)
        if (!response) {
          throw new Error(`missing expansion projection for group ${group.id}`)
        }
        return { group, response }
      })
      for (let attempt = 0; attempt < 2; attempt++) {
        let currentLayout = baseLayout
        let startIndex = 0
        if (attempt === 0) {
          for (let index = sequence.length - 1; index >= 0; index--) {
            const cached = cachedGroupLayout(
              groupLayoutSession.current,
              groupedBaseSubgraph,
              sequence[index].response.requestKey,
            )
            if (!cached) continue
            currentLayout = cached
            startIndex = index + 1
            break
          }
        }
        let missingGroup: ExpandedGroupLayout | null = null
        for (let index = startIndex; index < sequence.length; index++) {
          const { group, response } = sequence[index]
          const prefix = sequence
            .slice(0, index + 1)
            .map((entry) => entry.response)
          const activeLayoutPrefix = sequence
            .slice(0, index + 1)
            .map((entry) => entry.group)
          const step = applyGroupExpansions(
            groupedBaseSubgraph,
            prefix,
            MAX_GROUP_EXPANSION_RENDER_NODES,
          )
          let expanded: LaidOutGraph | null
          try {
            expanded = await layoutExpandedGroupWithSchemWeave(
              step.graph,
              currentLayout,
              group,
              controller.signal,
              activeLayoutPrefix,
            )
          } catch (error) {
            if (!controller.signal.aborted && groupExpansionOwnerKey) {
              dispatchGroupExpansion({
                type: 'failed',
                ownerKey: groupExpansionOwnerKey,
                id: group.id,
              })
            }
            throw error
          }
          if (!expanded) {
            missingGroup = group
            break
          }
          currentLayout = expanded
          cacheGroupLayout(
            groupLayoutSession.current,
            groupedBaseSubgraph,
            response.requestKey,
            expanded,
          )
        }
        if (!missingGroup) return currentLayout
        if (attempt > 0) {
          if (groupExpansionOwnerKey) {
            dispatchGroupExpansion({
              type: 'failed',
              ownerKey: groupExpansionOwnerKey,
              id: missingGroup.id,
            })
          }
          throw new Error(
            `SchemWeave could not preserve expanded group ${missingGroup.id} in this projection`,
          )
        }
        resetGroupLayoutSession(groupLayoutSession.current, null)
        baseLayout = await refreshSchemWeaveLayout(
          groupedBaseSubgraph,
          [],
          controller.signal,
        )
        layoutCache.current.set(groupedBaseSubgraph, baseLayout)
      }
      throw new Error('SchemWeave group recovery exhausted its retry')
    }
    const collapseWithSchemWeave = async (): Promise<LaidOutGraph | null> => {
      const pendingCollapse = pendingGroupCollapse.current
      if (
        layoutEngine !== 'schemweave' ||
        !pendingCollapse ||
        pendingCollapse.display.designId !== ownerDesignId ||
        pendingCollapse.display.projectionKey !== projectionKey ||
        expandedGroupsForLayout.length === 0
      ) {
        return null
      }
      const previousGroups = pendingCollapse.groups
      const currentIds = new Set(
        expandedGroupsForLayout.map((group) => group.id),
      )
      const previousIds = new Set(previousGroups.map((group) => group.id))
      const removed = previousGroups.filter((group) => !currentIds.has(group.id))
      const added = expandedGroupsForLayout.filter(
        (group) => !previousIds.has(group.id),
      )
      if (
        removed.length !== 1 ||
        removed[0].id !== pendingCollapse.groupId ||
        added.length !== 0
      ) {
        return null
      }
      const collapsed = await layoutCollapsedGroupWithSchemWeave(
        toLayout,
        pendingCollapse.display.graph,
        removed[0],
        expandedGroupsForLayout,
        controller.signal,
      )
      if (!collapsed || !groupedBaseSubgraph) return collapsed
      const activeById = new Map(
        activeGroupExpansions.map((expansion) => [expansion.id, expansion]),
      )
      const last = expandedGroupsForLayout.at(-1)
      const response = last ? activeById.get(last.id) : undefined
      if (response) {
        cacheGroupLayout(
          groupLayoutSession.current,
          groupedBaseSubgraph,
          response.requestKey,
          collapsed,
        )
      }
      return collapsed
    }
    const layoutWithSchemWeave = async () => {
      const pendingCollapse = pendingGroupCollapse.current
      try {
        const collapsed = await collapseWithSchemWeave()
        if (collapsed) return collapsed
      } catch (error) {
        if (controller.signal.aborted) throw error
        console.warn('SchemWeave inverse collapse fell back to expansion', error)
      } finally {
        if (pendingGroupCollapse.current === pendingCollapse) {
          pendingGroupCollapse.current = null
        }
      }
      return expandWithSchemWeave(expandedGroupsForLayout)
    }
    const layoutPromise =
      layoutEngine === 'schemweave' && expandedGroupsForLayout.length > 0
        ? layoutWithSchemWeave()
        : layoutSubgraph(
            toLayout,
            controller.signal,
            layoutEngine,
            expandedGroupsForLayout,
          )
    layoutPromise
      .then((g) => {
        if (cancelled) return
        const nextDisplay = {
          designId: ownerDesignId,
          projectionKey,
          subgraph: toLayout,
          graph: g,
          expandedGroups: visibleExpandedGroups,
        }
        layoutCache.current.set(toLayout, g)
        displayedGraphRef.current = nextDisplay
        setDisplayedGraph(nextDisplay)
        laidOutSubgraph.current = toLayout
        setLayingOut(false)
        if (shouldRefit(g)) setFitNonce((n) => n + 1)
      })
      .catch((e) => {
        if (cancelled || controller.signal.aborted) return
        setError(String(e instanceof Error ? e.message : e))
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
    activeGroupExpansions,
    combinedSubgraph,
    expandedGroupSpecs,
    focusActive,
    fullSubgraph?.designId,
    groupExpansionOwnerKey,
    groupedBaseSubgraph,
    layoutEngine,
    projectionKey,
    relevantSubgraph?.designId,
    expandedGroupsForLayout,
    visibleExpandedGroups,
    waitingForVisibleGroupExpansions,
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
    () =>
      new Set<number>(
        [
          ...(relevantRequestCurrent ? (relevantSubgraph?.relevantIds ?? []) : []),
          ...(activeExpansion?.graph.nodes.map((node) => node.id) ?? []),
          ...activeGroupExpansions.flatMap((group) => group.members),
        ],
      ),
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
    () =>
      new Set<number>(
        relevantRequestCurrent ? (relevantSubgraph?.highlightedBits ?? []) : [],
      ),
    [relevantRequestCurrent, relevantSubgraph?.highlightedBits],
  )
  const rootId =
    relevantRequestCurrent && coneReq?.kind === 'cone' ? coneReq.node : -1

  // Net driven by the selected node (first outgoing edge) — lets the detail
  // card show a readable identity for hidden-name cells.
  const selectedNet = useMemo(() => {
    if (!sub || !selected) return null
    return sub.edges.find((e) => e.from === selected.id)?.net_name ?? null
  }, [sub, selected])

  // Double-click a node to additively pull in its immediate fanin and fanout
  // neighbors. Grouped nodes expand around their member bits so the neighborhood
  // comes back grouped and its synthetic ids line up with the base graph.
  const designId = design?.design_id
  const onExpandGroup = useCallback((node: GraphNode) => {
    if (node.member_count == null && node.members == null) return
    if (!groupExpansionOwnerKey) return
    if (groupExpansionControllers.current.has(node.id)) return
    const referenceHeight = (
      groupedBaseSubgraph
        ? layoutCache.current.get(groupedBaseSubgraph)?.height
        : null
    ) ?? displayedGraphRef.current?.graph.height
    if (referenceHeight == null) return
    pendingGroupCollapse.current = null
    setSelected(null)
    setError(null)
    dispatchGroupExpansion({
      type: 'open',
      ownerKey: groupExpansionOwnerKey,
      spec: {
        id: node.id,
        label: node.name || node.cell_type || 'group',
        referenceHeight,
      },
    })
  }, [groupExpansionOwnerKey, groupedBaseSubgraph])

  const onCollapseGroup = useCallback((groupId: number) => {
    const display = displayedGraphRef.current
    const groups = expandedGroupsForLayout
    pendingGroupCollapse.current =
      layoutEngine === 'schemweave' &&
        display &&
        display.graph.schemWeaveSession &&
        groups.length > 1 &&
        groups.some((group) => group.id === groupId)
        ? { groupId, display, groups }
        : null
    const controller = groupExpansionControllers.current.get(groupId)
    controller?.abort()
    groupExpansionControllers.current.delete(groupId)
    groupExpansionControllerKeys.current.delete(groupId)
    setSelected(null)
    setFetchingGroups(groupExpansionControllers.current.size > 0)
    if (!groupExpansionOwnerKey) return
    dispatchGroupExpansion({
      type: 'close',
      ownerKey: groupExpansionOwnerKey,
      id: groupId,
    })
  }, [expandedGroupsForLayout, groupExpansionOwnerKey, layoutEngine])

  const onExpand = useCallback(
    (node: GraphNode) => {
      if (!designId || !graphInteractive || !displayedGraph?.projectionKey) return
      setError(null)
      // Group projections expose a stable synthetic id. The grouped API
      // contract resolves that id in the worker, avoiding unbounded messages
      // and the public 200-root limit for wide vectors.
      const ids = [node.id]
      const ownerKey = displayedGraph.projectionKey
      const controller = new AbortController()
      expansionControllers.current.add(controller)
      const shared = {
        node: ids[0],
        nodes: ids.length > 1 ? ids : undefined,
        max_depth: 1,
        max_nodes: graphOptions.maxNodes,
        hide_control: graphOptions.hideControl,
        hide_const: graphOptions.hideConst,
        show_infrastructure: false,
        group_vectors: graphOptions.groupVectors,
        group_memories: graphOptions.groupMemories,
      }
      Promise.all([
        getCone(designId, { ...shared, dir: 'fanin' }, controller.signal),
        getCone(designId, { ...shared, dir: 'fanout' }, controller.signal),
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
          const clear = (g: Subgraph): Subgraph => ({ ...g, truncated: false })
          setExpansionState((prev) => {
            const owned = prev?.ownerKey === ownerKey ? prev : null
            const acc = owned?.graph ?? { nodes: [], edges: [], truncated: false }
            const withFanin = mergeSubgraphs(
              acc,
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
        .catch((e) => {
          if (
            controller.signal.aborted ||
            displayedGraphRef.current?.projectionKey !== ownerKey
          ) return
          setError(
            `Could not expand ${node.name || node.id}: ${
              e instanceof ApiRequestError ? e.message : String(e)
            }`,
          )
        })
        .finally(() => expansionControllers.current.delete(controller))
    },
    [
      designId,
      displayedGraph?.projectionKey,
      graphInteractive,
      graphOptions.groupVectors,
      graphOptions.groupMemories,
      graphOptions.hideConst,
      graphOptions.hideControl,
      graphOptions.maxNodes,
    ],
  )

  const onGraphSelect = useCallback(
    (node: GraphNode | null) => {
      if (!graphInteractive) return
      edgeSourceProbeRef.current?.cancel()
      setSourceProbeNotice(null)
      setSelected(node)
      highlightNodeSources(node?.src)
    },
    [graphInteractive, highlightNodeSources],
  )
  const onEdgeSelect = useCallback(
    (bits: number[]) => {
      if (!designId || bits.length === 0) return
      setSourceProbeNotice(null)
      setError(null)
      setSelected(null)
      edgeSourceProbeRef.current?.schedule({ designId, bits })
    },
    [designId],
  )
  const onControlSelect = useCallback(
    (control: NonNullable<GraphNode['controls']>[number]) => {
      if (!graphInteractive) return
      edgeSourceProbeRef.current?.cancel()
      setSourceProbeNotice(null)
      openControlCone({
        nodes: controlDriverIds(control),
        label: controlLabel(control),
        generated: control.generated,
      })
    },
    [graphInteractive, openControlCone],
  )
  const focusMode =
    relevantRequestCurrent && relevantIds.size > 0
      ? focusActive
        ? 'on'
        : 'off'
      : undefined
  const loading = fetchingFull || fetchingRelevant || fetchingGroups || layingOut
  const showLoading = loading || analysisState === 'refreshing'

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
            interactive={graphInteractive}
            onSelect={onGraphSelect}
            onEdgeSelect={onEdgeSelect}
            onControlSelect={graphInteractive ? onControlSelect : undefined}
            onExpand={graphInteractive ? onExpand : undefined}
            expandedGroups={visibleDisplayedGraph?.expandedGroups ?? []}
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

        <div className="graph-banner">
          {showLoading && (
            <span className="graph-loading-indicator">
              <BubbleLoader size={32} label="Loading schematic" />
            </span>
          )}
          {error && <span className="msg err">{error}</span>}
          {sourceProbeNotice && <span className="msg">{sourceProbeNotice}</span>}
          {analysisState === 'stale' && (
            <span className="msg">source changed — synthesize to refresh mapping</span>
          )}
          {requestDesignMismatch && (
            <span className="msg">this cone belongs to the previous synthesis</span>
          )}
          {sourcePresentation.message && (
            <span className="msg">{sourcePresentation.message}</span>
          )}
          {sourceControl && (
            <span className="msg">
              control path selection — reset/clock/enable connectivity is shown
            </span>
          )}
          {coneReq?.kind === 'source' && coneReq.selectionTruncated && (
            <span className="msg">selection capped at 200 source lines</span>
          )}
          {sub?.truncated && (
            <span className="msg">
              truncated — {sub.nodes.length} nodes and {sub.edges.length} edges shown;
              analysis limits omitted additional schematic content
            </span>
          )}
          {(combined?.expansionDroppedNodes ?? 0) > 0 ||
          (combined?.expansionDroppedEdges ?? 0) > 0 ? (
            <span className="msg">
              expansion reached the render cap — {combined?.expansionDroppedNodes ?? 0}{' '}
              nodes and {combined?.expansionDroppedEdges ?? 0} edges omitted
            </span>
          ) : null}
          {sub && !sub.truncated && (
            <span className="graph-count">{sub.nodes.length} nodes · {sub.edges.length} edges</span>
          )}
        </div>

        {selected && graphInteractive && (
          <NodeCard
            node={selected}
            drivingNet={selectedNet}
            onClose={() => setSelected(null)}
            onExpand={() => onExpand(selected)}
          />
        )}
      </div>
    </div>
  )
}

function GraphToolbar({ graphInteractive }: { graphInteractive: boolean }) {
  const store = useStore(
    ({ coneReq, design, graphOptions, setGraphOptions, openCone }) => ({
      coneReq,
      design,
      graphOptions,
      setGraphOptions,
      openCone,
    }),
    shallowEqual,
  )
  const { coneReq, design, graphOptions } = store
  const requestDesignMismatch = Boolean(
    design && coneReq?.kind === 'cone' && coneReq.designId !== design.design_id,
  )
  const setOpt = store.setGraphOptions
  const focusAvailable = coneReq?.kind === 'cone' || coneReq?.kind === 'source'

  const reissue = (dir: 'fanin' | 'fanout') => {
    if (coneReq?.kind !== 'cone') return
    store.openCone({
      nodes: coneReq.nodes,
      dir,
      label: coneReq.label,
      highlight: coneReq.highlight,
      rootPort: dir === 'fanin' ? coneReq.rootPort : undefined,
      rootPortBit: dir === 'fanin' ? coneReq.rootPortBit : undefined,
      rootPortBits: dir === 'fanin' ? coneReq.rootPortBits : undefined,
    })
  }

  return (
    <div className="graph-toolbar">
      {coneReq && (
        <>
          <span
            className="mono"
            style={{ color: 'var(--text-dim)', fontSize: 12 }}
          >
            {coneReq.label}
          </span>
          <span className="sep" />
        </>
      )}

      <label className="toggle" title="Max nodes to request">
        max nodes
        <div className="stepper">
          <button
            onClick={() => setOpt({ maxNodes: Math.max(50, graphOptions.maxNodes - 100) })}
          >
            −
          </button>
          <span className="val">{graphOptions.maxNodes}</span>
          <button
            onClick={() =>
              setOpt({
                maxNodes: Math.min(
                  MAX_GRAPH_RENDER_NODES,
                  graphOptions.maxNodes + 100,
                ),
              })
            }
          >
            +
          </button>
        </div>
      </label>
      <label className="toggle">
        <input
          type="checkbox"
          checked={graphOptions.hideControl}
          onChange={(e) => setOpt({ hideControl: e.target.checked })}
        />
        hide control
      </label>
      <label className="toggle">
        <input
          type="checkbox"
          checked={graphOptions.hideConst}
          onChange={(e) => setOpt({ hideConst: e.target.checked })}
        />
        hide const
      </label>

      <label
        className="toggle"
        title="Collapse bit-parallel ports, registers, and combinational logic"
      >
        <input
          type="checkbox"
          checked={graphOptions.groupVectors}
          onChange={(event) => setOpt({ groupVectors: event.target.checked })}
        />
        group vectors
      </label>

      <label
        className="toggle"
        title="Collapse logical memories and parallel mapped memory primitives"
      >
        <input
          type="checkbox"
          checked={graphOptions.groupMemories}
          onChange={(event) => setOpt({ groupMemories: event.target.checked })}
        />
        group memories
      </label>

      <label
        className="toggle"
        title={
          focusAvailable
            ? graphOptions.focus
              ? 'Show only the logic relevant to this selection'
              : 'Show the full schematic and highlight the relevant logic'
            : graphOptions.focus
              ? 'Turn Focus off before choosing a source selection or cone'
              : 'Focus applies to source selections and cones'
        }
      >
        <input
          type="checkbox"
          checked={graphOptions.focus}
          disabled={!focusAvailable && !graphOptions.focus}
          onChange={(event) => setOpt({ focus: event.target.checked })}
        />
        Focus
      </label>

      {coneReq?.kind === 'cone' && (
        <>
          <div className="stepper" title="Cone direction">
            <button
              className={coneReq.dir === 'fanin' ? 'primary' : ''}
              disabled={requestDesignMismatch || !graphInteractive}
              onClick={() => reissue('fanin')}
            >
              fanin
            </button>
            <button
              className={coneReq.dir === 'fanout' ? 'primary' : ''}
              disabled={requestDesignMismatch || !graphInteractive}
              onClick={() => reissue('fanout')}
            >
              fanout
            </button>
          </div>

          <label className="toggle">
            depth
            <div className="stepper">
              <button onClick={() => setOpt({ maxDepth: Math.max(1, graphOptions.maxDepth - 1) })}>
                −
              </button>
              <span className="val">{graphOptions.maxDepth}</span>
              <button onClick={() => setOpt({ maxDepth: graphOptions.maxDepth + 1 })}>+</button>
            </div>
          </label>
        </>
      )}
    </div>
  )
}
