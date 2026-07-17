import type {
  ExplorationEdge,
  ExplorationNode,
  ExplorationSnapshot,
  GraphEdge,
  GraphNode,
  SourceSelectionResult,
  SourceProbeDirection,
  SourceProbeHint,
  SourceRangeMapping,
  Subgraph,
} from '../types'

const MAX_SUBGRAPH_NODES = 2_000
const MAX_SUBGRAPH_EDGES = 10_000
const SOURCE_ROOT_COLLECTION_CAP = MAX_SUBGRAPH_NODES + 1

export interface SelectionOptions {
  maxNodes: number
  hideControl: boolean
  hideConst: boolean
  groupVectors: boolean
}

interface PreparedExploration {
  snapshot: ExplorationSnapshot
  incoming: number[][]
  outgoing: number[][]
  rangesByFile: Map<string, IntervalIndex<SourceRangeMapping>>
  hintsByFile: Map<string, IntervalIndex<SourceProbeHint>>
  seenLines: Set<string>
  seenRangesByFile: Map<string, IntervalIndex<{ start_line: number; end_line: number }>>
  targetsByFile: Map<string, Array<{ line: number; ids: number[] }>>
}

interface IntervalIndex<T extends { start_line: number; end_line: number }> {
  entries: T[]
  prefixMaxEnd: number[]
}

interface SourceProbe {
  roots: number[]
  direction: SourceProbeDirection | null
  highlightLogic: boolean
  expandOutputRegisterInputs: boolean
}

interface Traversal {
  direction: SourceProbeDirection
  seen: Set<number>
  queue: Array<[number, number]>
  queueIndex: number
  current: { id: number; depth: number; nextEdge: number } | null
}

export function prepareExploration(snapshot: ExplorationSnapshot): PreparedExploration {
  if (snapshot.schema_version !== 1) {
    throw new Error(`unsupported exploration schema ${snapshot.schema_version}`)
  }
  const incoming = snapshot.nodes.map(() => [] as number[])
  const outgoing = snapshot.nodes.map(() => [] as number[])
  snapshot.edges.forEach((edge, index) => {
    outgoing[edge.from]?.push(index)
    incoming[edge.to]?.push(index)
  })
  const rangesByFile = indexIntervals(snapshot.source_ranges, (range) => range.file)
  const hintsByFile = indexIntervals(snapshot.source_hints, (hint) => hint.file)
  const seenRangesByFile = indexIntervals(snapshot.source_seen_ranges, (range) => range.file)
  const targetsByFile = new Map(
    Object.entries(snapshot.procedural_targets).map(([file, targets]) => [
      file,
      Object.entries(targets)
        .map(([line, ids]) => ({ line: Number.parseInt(line, 10), ids }))
        .sort((a, b) => a.line - b.line),
    ]),
  )
  return {
    snapshot,
    incoming,
    outgoing,
    rangesByFile,
    hintsByFile,
    seenLines: new Set(snapshot.source_seen_lines),
    seenRangesByFile,
    targetsByFile,
  }
}

export function analyzeSourceSelection(
  prepared: PreparedExploration,
  file: string,
  startLine: number,
  endLine: number,
  options: SelectionOptions,
): SourceSelectionResult {
  if (!prepared.snapshot.files.includes(file)) throw new Error('unknown file')
  if (startLine < 1 || endLine < startLine) {
    throw new Error('line range must satisfy 1 <= start_line <= end_line')
  }
  if (endLine - startLine >= 200) throw new Error('at most 200 source lines may be selected')

  const probe = sourceProbeRange(prepared, file, startLine, endLine)
  const control = probe.roots.some((root) =>
    prepared.outgoing[root].some((edge) => prepared.snapshot.edges[edge].control),
  )
  const graph = multiRootSubgraph(
    prepared,
    probe.roots,
    probe.direction ? [probe.direction] : ['fanin', 'fanout'],
    {
      maxDepth: 64,
      maxNodes: options.maxNodes,
      hideControl: options.hideControl && !control,
      hideConst: options.hideConst,
      groupVectors: options.groupVectors,
      expandOutputRegisterInputs: probe.expandOutputRegisterInputs,
    },
  )
  const highlight = graph.nodes
    .filter((node) => (probe.highlightLogic ? node.kind === 'cell' : node.is_root === true))
    .map((node) => node.id)
  const mappingIncomplete = overlappingRanges(prepared, file, startLine, endLine).some(
    (range) => range.mapping_incomplete,
  )
  const sourceSeen =
    rangeLines(startLine, endLine).some((line) => prepared.seenLines.has(`${file}:${line}`)) ||
    overlappingIntervals(prepared.seenRangesByFile.get(file), startLine, endLine).length > 0
  return {
    status: mappingIncomplete
      ? 'mapping_incomplete'
      : probe.roots.length > 0
        ? 'mapped'
        : sourceSeen
          ? 'optimized_or_absorbed'
          : 'unmapped',
    control,
    highlight,
    graph,
  }
}

function sourceProbeRange(
  prepared: PreparedExploration,
  file: string,
  startLine: number,
  endLine: number,
): SourceProbe {
  const defaultRoots = sourceNodesRange(prepared, file, startLine, endLine)
  const overlapping = overlappingIntervals(prepared.hintsByFile.get(file), startLine, endLine)
  if (overlapping.length === 0) {
    return {
      roots: defaultRoots,
      direction: null,
      highlightLogic: false,
      expandOutputRegisterInputs: false,
    }
  }
  const selected =
    startLine === endLine && overlapping.some((hint) => hint.kind !== 'block')
      ? overlapping.filter((hint) => hint.kind !== 'block')
      : overlapping
  const roots = new Set(defaultRoots)
  if (selected.every((hint) => hint.kind === 'block')) roots.clear()
  for (const kind of ['procedural', 'block'] as const) {
    for (const hint of selected.filter((candidate) => candidate.kind === kind)) {
      for (const target of targetsInRange(prepared, file, hint.start_line, hint.end_line)) {
        for (const id of target.ids) insertBounded(roots, id)
      }
    }
  }
  if (roots.size === 0) {
    for (const id of sourceNodesRange(prepared, file, startLine, endLine)) roots.add(id)
  }
  const direction = selected.every((hint) => hint.direction === selected[0]?.direction)
    ? (selected[0]?.direction ?? null)
    : null
  return {
    roots: [...roots].sort(numberCompare),
    direction,
    highlightLogic: true,
    expandOutputRegisterInputs: selected.some((hint) => hint.kind === 'output_port'),
  }
}

function sourceNodesRange(
  prepared: PreparedExploration,
  file: string,
  startLine: number,
  endLine: number,
): number[] {
  const roots = new Set<number>()
  outer: for (let line = startLine; line <= endLine; line += 1) {
    for (const id of prepared.snapshot.source_by_line[`${file}:${line}`] ?? []) {
      if (insertBounded(roots, id)) break outer
    }
  }
  if (roots.size < SOURCE_ROOT_COLLECTION_CAP) {
    outer: for (const range of overlappingRanges(prepared, file, startLine, endLine)) {
      for (const id of range.node_ids) {
        if (insertBounded(roots, id)) break outer
      }
    }
  }
  return narrowToAssignmentTargets(prepared, file, startLine, endLine, [...roots].sort(numberCompare))
}

function narrowToAssignmentTargets(
  prepared: PreparedExploration,
  file: string,
  startLine: number,
  endLine: number,
  roots: number[],
): number[] {
  const perLineTargets = prepared.snapshot.procedural_targets[file]
  if (roots.length === 0 || !perLineTargets) return roots
  const blockRoots = new Set(
    roots.filter((id) => isBlockAttributed(prepared.snapshot.nodes[id], file, startLine, endLine)),
  )
  if (blockRoots.size === 0) return roots
  const ranges = overlappingRanges(prepared, file, startLine, endLine)
  const targets = new Set<number>()
  for (let line = startLine; line <= endLine; line += 1) {
    const lineTargets = perLineTargets[String(line)]
    for (const id of lineTargets ?? []) targets.add(id)
    const contributed =
      (prepared.snapshot.source_by_line[`${file}:${line}`] ?? []).some((id) =>
        blockRoots.has(id),
      ) ||
      ranges.some(
        (range) =>
          range.start_line <= line &&
          line <= range.end_line &&
          range.node_ids.some((id) => blockRoots.has(id)),
      )
    if (contributed && (!lineTargets || lineTargets.length === 0)) return roots
  }
  if (targets.size === 0) return roots
  const narrowed = roots.filter((id) => targets.has(id) || !blockRoots.has(id))
  return narrowed.length > 0 ? narrowed : roots
}

function isBlockAttributed(
  node: ExplorationNode | undefined,
  file: string,
  startLine: number,
  endLine: number,
): boolean {
  return Boolean(
    node?.src?.split('|').some((location) => {
      const span = parseSourceLocation(location)
      return (
        span?.file === file &&
        span.start <= endLine &&
        span.end >= startLine &&
        (span.start < startLine || span.end > endLine)
      )
    }),
  )
}

function multiRootSubgraph(
  prepared: PreparedExploration,
  roots: number[],
  directions: SourceProbeDirection[],
  options: {
    maxDepth: number
    maxNodes: number
    hideControl: boolean
    hideConst: boolean
    groupVectors: boolean
    expandOutputRegisterInputs: boolean
  },
): Subgraph {
  const cap = Math.max(1, Math.min(options.maxNodes, MAX_SUBGRAPH_NODES))
  const seen = new Set<number>()
  const seenUnits = new Set<number>()
  const includedRoots = new Set<number>()
  const includedRootIds: number[] = []
  const boundaryNodes = new Set<number>()
  const edgeSet = new Set<number>()
  const expandedRegisterInputs = new Set<number>()
  let truncated = false
  for (const root of roots) {
    if (!prepared.snapshot.nodes[root] || includedRoots.has(root)) continue
    const unit = unitId(prepared, root, options.groupVectors)
    if (!seenUnits.has(unit) && seenUnits.size >= cap) {
      truncated = true
      continue
    }
    seenUnits.add(unit)
    seen.add(root)
    includedRoots.add(root)
    includedRootIds.push(root)
  }
  const outputFrontier = new Set<number>(
    options.expandOutputRegisterInputs
      ? [...includedRoots].filter((id) => prepared.snapshot.nodes[id].output_frontier)
      : [],
  )
  const traversals: Traversal[] = directions.map((direction) => ({
    direction,
    seen: new Set(includedRoots),
    queue: includedRootIds.map((root) => [root, 0]),
    queueIndex: 0,
    current: null,
  }))

  for (;;) {
    let advanced = false
    for (const traversal of traversals) {
      for (;;) {
        if (!traversal.current) {
          const queued = traversal.queue[traversal.queueIndex++]
          if (!queued) break
          const [id, depth] = queued
          const node = prepared.snapshot.nodes[id]
          if (
            !includedRoots.has(id) &&
            node.boundary &&
            !expandedRegisterInputs.has(id) &&
            !node.addressable_sequential
          ) {
            boundaryNodes.add(id)
            continue
          }
          if (depth >= options.maxDepth) {
            if (hasVisibleNeighbor(prepared, id, traversal.direction, options)) {
              boundaryNodes.add(id)
              truncated = true
            }
            continue
          }
          traversal.current = { id, depth, nextEdge: 0 }
        }
        const frame = traversal.current
        const edgeIds = traversal.direction === 'fanin' ? prepared.incoming[frame.id] : prepared.outgoing[frame.id]
        const edgeIndex = edgeIds[frame.nextEdge]
        if (edgeIndex == null) {
          traversal.current = null
          continue
        }
        frame.nextEdge += 1
        const edge = prepared.snapshot.edges[edgeIndex]
        if (shouldHideEdge(prepared, edge, options)) continue
        const frameNode = prepared.snapshot.nodes[frame.id]
        if (
          traversal.direction === 'fanin' &&
          frameNode.addressable_sequential &&
          !includedRoots.has(frame.id) &&
          !edge.depth_input
        ) continue
        if (
          traversal.direction === 'fanout' &&
          frameNode.addressable_sequential &&
          !includedRoots.has(frame.id) &&
          !edge.depth_output
        ) continue

        advanced = true
        const next = traversal.direction === 'fanin' ? edge.from : edge.to
        if (!seen.has(next)) {
          const unit = unitId(prepared, next, options.groupVectors)
          if (!seenUnits.has(unit) && seenUnits.size >= cap) {
            truncated = true
            break
          }
          seenUnits.add(unit)
          seen.add(next)
        }
        const nextNode = prepared.snapshot.nodes[next]
        if (
          options.expandOutputRegisterInputs &&
          traversal.direction === 'fanin' &&
          outputFrontier.has(frame.id)
        ) {
          if (nextNode.register_type) expandedRegisterInputs.add(next)
          else if (nextNode.transparent_buffer) outputFrontier.add(next)
        }
        const stopAtStateInput =
          traversal.direction === 'fanout' && nextNode.addressable_sequential && !edge.depth_input
        const stopAtFixedStateOutput =
          traversal.direction === 'fanin' && nextNode.addressable_sequential && !edge.depth_output
        if (stopAtStateInput || stopAtFixedStateOutput) boundaryNodes.add(next)
        else if (!traversal.seen.has(next)) {
          traversal.seen.add(next)
          traversal.queue.push([next, frame.depth + 1])
        }
        edgeSet.add(edgeIndex)
        break
      }
    }
    if (!advanced) break
  }
  let subgraph = subgraphFromSets(prepared, seen, edgeSet, includedRoots, boundaryNodes, truncated)
  subgraph = collapseInfrastructure(prepared, subgraph)
  return options.groupVectors ? quotientSubgraph(prepared, subgraph) : subgraph
}

function subgraphFromSets(
  prepared: PreparedExploration,
  seen: Set<number>,
  edgeSet: Set<number>,
  roots: Set<number>,
  boundaries: Set<number>,
  truncated: boolean,
): Subgraph {
  const nodes = [...seen].sort(numberCompare).map((id) => {
    const source = prepared.snapshot.nodes[id]
    const node: GraphNode = {
      id: source.id,
      kind: source.kind,
      name: source.name,
      ...(source.cell_type != null ? { cell_type: source.cell_type } : {}),
      ...(source.seq != null ? { seq: source.seq } : {}),
      ...(source.register != null ? { register: source.register } : {}),
      ...(source.src != null ? { src: source.src } : {}),
      ...(roots.has(id) ? { is_root: true } : {}),
      ...(!roots.has(id) && boundaries.has(id) ? { is_boundary: true } : {}),
      ...(source.depth != null ? { depth: source.depth } : {}),
      ...(source.params ? { params: source.params } : {}),
      ...(source.controls ? { controls: source.controls } : {}),
    }
    return node
  })
  const rawEdges = [...edgeSet]
    .map((index) => prepared.snapshot.edges[index])
    .filter((edge) => seen.has(edge.from) && seen.has(edge.to))
    .sort(compareExplorationEdges)
  const merged = mergeRawEdges(rawEdges)
  return capEdges({ nodes, edges: merged.edges, truncated: truncated || merged.truncated })
}

function mergeRawEdges(edges: ExplorationEdge[]): { edges: GraphEdge[]; truncated: boolean } {
  const merged = new Map<string, GraphEdge>()
  let truncated = false
  for (const edge of edges) {
    const key = `${edge.from}\0${edge.to}\0${edge.from_port}\0${edge.to_port}`
    let output = merged.get(key)
    if (!output) {
      if (merged.size === MAX_SUBGRAPH_EDGES) {
        truncated = true
        break
      }
      output = {
        from: edge.from,
        to: edge.to,
        from_port: edge.from_port,
        to_port: edge.to_port,
        net_name: edge.net_name,
        bits: [],
        ...(edge.control ? { control: true } : {}),
      }
      merged.set(key, output)
    }
    if (edge.bit != null) output.bits.push(edge.bit)
    if (edge.control) output.control = true
  }
  for (const edge of merged.values()) edge.bits = uniqueSorted(edge.bits)
  return { edges: [...merged.values()], truncated }
}

function collapseInfrastructure(prepared: PreparedExploration, subgraph: Subgraph): Subgraph {
  const hidden = new Set(
    subgraph.nodes
      .filter((node) => {
        const source = prepared.snapshot.nodes[node.id]
        return source.infrastructure && !(node.is_root && !source.transparent_buffer)
      })
      .map((node) => node.id),
  )
  if (hidden.size === 0) return subgraph
  const outgoing = groupBy(subgraph.edges, (edge) => edge.from)
  const merged = new Map<string, GraphEdge>()
  let truncated = subgraph.truncated
  let work = 0
  sourceLoop: for (const sourceEdge of subgraph.edges.filter((edge) => !hidden.has(edge.from))) {
    work += 1
    if (work > MAX_SUBGRAPH_EDGES) {
      truncated = true
      break
    }
    const queue = [{ edge: sourceEdge, bits: sourceEdge.bits, control: sourceEdge.control === true }]
    const seen = new Set<string>()
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index]
      if (!hidden.has(current.edge.to)) {
        const key = `${sourceEdge.from}\0${current.edge.to}\0${sourceEdge.from_port}\0${current.edge.to_port}\0${current.edge.net_name}\0${current.control}`
        let output = merged.get(key)
        if (!output) {
          if (merged.size === MAX_SUBGRAPH_EDGES) {
            truncated = true
            break sourceLoop
          }
          output = {
            from: sourceEdge.from,
            to: current.edge.to,
            from_port: sourceEdge.from_port,
            to_port: current.edge.to_port,
            net_name: current.edge.net_name,
            bits: [],
            ...(current.control ? { control: true } : {}),
          }
          merged.set(key, output)
        }
        output.bits.push(...current.bits)
        continue
      }
      const stateKey = `${current.edge.to}\0${current.control}\0${current.bits.join(',')}`
      if (seen.has(stateKey)) continue
      seen.add(stateKey)
      for (const next of outgoing.get(current.edge.to) ?? []) {
        work += 1
        if (work > MAX_SUBGRAPH_EDGES) {
          truncated = true
          break sourceLoop
        }
        queue.push({
          edge: next,
          bits: next.bits.length === 0 ? current.bits : next.bits,
          control: current.control || next.control === true,
        })
      }
    }
  }
  for (const edge of merged.values()) edge.bits = uniqueSorted(edge.bits)
  return {
    nodes: subgraph.nodes.filter((node) => !hidden.has(node.id)),
    edges: [...merged.values()],
    truncated,
  }
}

function quotientSubgraph(prepared: PreparedExploration, subgraph: Subgraph): Subgraph {
  const base = prepared.snapshot.nodes.length
  const groupAcc = new Map<
    number,
    { members: number[]; root: boolean; boundary: boolean; depth?: number; controls: NonNullable<GraphNode['controls']> }
  >()
  const nodes: GraphNode[] = []
  for (const node of subgraph.nodes) {
    const groupId = prepared.snapshot.nodes[node.id].group_id
    if (groupId == null) {
      nodes.push(node)
      continue
    }
    const acc = groupAcc.get(groupId) ?? { members: [], root: false, boundary: false, controls: [] }
    acc.members.push(node.id)
    acc.root ||= node.is_root === true
    acc.boundary ||= node.is_boundary === true
    if (node.depth != null) acc.depth = Math.max(acc.depth ?? node.depth, node.depth)
    for (const control of node.controls ?? []) {
      if (!acc.controls.some((kept) => kept.role === control.role && kept.net_name === control.net_name)) {
        acc.controls.push(control)
      }
    }
    groupAcc.set(groupId, acc)
  }
  for (const [groupId, acc] of [...groupAcc].sort(([a], [b]) => a - b)) {
    const group = prepared.snapshot.groups[groupId]
    acc.members.sort(numberCompare)
    const register = group.kind === 'register'
    const fragments: string[] = []
    for (const member of acc.members) {
      for (const fragment of prepared.snapshot.nodes[member].group_src?.split('|') ?? []) {
        if (fragment && !fragments.includes(fragment) && fragments.length < 8) fragments.push(fragment)
      }
    }
    nodes.push({
      id: base + groupId,
      kind: group.kind === 'port' ? 'port' : 'cell',
      name: group.label,
      ...(group.kind !== 'port' ? { cell_type: group.cell_type } : {}),
      ...(register ? { seq: true, register: prepared.snapshot.nodes[acc.members[0]].register_type } : {}),
      ...(fragments.length > 0 ? { src: fragments.join('|') } : {}),
      ...(acc.root ? { is_root: true } : {}),
      ...(!acc.root && acc.boundary ? { is_boundary: true } : {}),
      ...(acc.depth != null ? { depth: acc.depth } : {}),
      ...(acc.controls.length > 0 ? { controls: acc.controls } : {}),
      width: acc.members.length,
      members: acc.members,
    })
  }
  nodes.sort((a, b) => a.id - b.id)
  const merged = new Map<string, GraphEdge>()
  for (const edge of subgraph.edges) {
    const from = projectedId(prepared, edge.from)
    const to = projectedId(prepared, edge.to)
    if (from === to) continue
    const key = `${from}\0${to}\0${edge.from_port}\0${edge.to_port}`
    let output = merged.get(key)
    if (!output) {
      output = {
        from,
        to,
        from_port: edge.from_port,
        to_port: edge.to_port,
        net_name: stripBitSuffix(edge.net_name),
        bits: [],
        ...(edge.control ? { control: true } : {}),
      }
      merged.set(key, output)
    }
    output.bits.push(...edge.bits)
    if (edge.control) output.control = true
  }
  for (const edge of merged.values()) edge.bits = uniqueSorted(edge.bits)
  return { nodes, edges: [...merged.values()], truncated: subgraph.truncated }
}

function unitId(prepared: PreparedExploration, id: number, grouped: boolean): number {
  const groupId = grouped ? prepared.snapshot.nodes[id].group_id : undefined
  return groupId == null ? id : prepared.snapshot.nodes.length + groupId
}

function projectedId(prepared: PreparedExploration, id: number): number {
  const groupId = prepared.snapshot.nodes[id].group_id
  return groupId == null ? id : prepared.snapshot.nodes.length + groupId
}

function shouldHideEdge(
  prepared: PreparedExploration,
  edge: ExplorationEdge,
  options: { hideControl: boolean; hideConst: boolean },
): boolean {
  return (
    (options.hideControl && edge.hidden_control) ||
    (options.hideConst && prepared.snapshot.nodes[edge.from].constant)
  )
}

function hasVisibleNeighbor(
  prepared: PreparedExploration,
  id: number,
  direction: SourceProbeDirection,
  options: { hideControl: boolean; hideConst: boolean },
): boolean {
  const edges = direction === 'fanin' ? prepared.incoming[id] : prepared.outgoing[id]
  return edges.some((index) => !shouldHideEdge(prepared, prepared.snapshot.edges[index], options))
}

function overlappingRanges(
  prepared: PreparedExploration,
  file: string,
  startLine: number,
  endLine: number,
): SourceRangeMapping[] {
  return overlappingIntervals(prepared.rangesByFile.get(file), startLine, endLine)
}

function targetsInRange(
  prepared: PreparedExploration,
  file: string,
  startLine: number,
  endLine: number,
): Array<{ line: number; ids: number[] }> {
  const targets = prepared.targetsByFile.get(file) ?? []
  const start = partitionPoint(targets.length, (index) => targets[index].line < startLine)
  const end = partitionPoint(targets.length, (index) => targets[index].line <= endLine)
  return targets.slice(start, end)
}

function indexIntervals<T extends { start_line: number; end_line: number }, K>(
  values: T[],
  key: (value: T) => K,
): Map<K, IntervalIndex<T>> {
  const indexes = new Map<K, IntervalIndex<T>>()
  for (const [itemKey, entries] of groupBy(values, key)) {
    entries.sort((a, b) => a.start_line - b.start_line || a.end_line - b.end_line)
    let maxEnd = 0
    indexes.set(itemKey, {
      entries,
      prefixMaxEnd: entries.map((entry) => (maxEnd = Math.max(maxEnd, entry.end_line))),
    })
  }
  return indexes
}

function overlappingIntervals<T extends { start_line: number; end_line: number }>(
  index: IntervalIndex<T> | undefined,
  startLine: number,
  endLine: number,
): T[] {
  if (!index) return []
  const end = partitionPoint(
    index.entries.length,
    (position) => index.entries[position].start_line <= endLine,
  )
  const start = partitionPoint(end, (position) => index.prefixMaxEnd[position] < startLine)
  return index.entries
    .slice(start, end)
    .filter((entry) => entry.end_line >= startLine)
}

function partitionPoint(length: number, beforeBoundary: (index: number) => boolean): number {
  let left = 0
  let right = length
  while (left < right) {
    const middle = left + Math.floor((right - left) / 2)
    if (beforeBoundary(middle)) left = middle + 1
    else right = middle
  }
  return left
}

function parseSourceLocation(location: string): { file: string; start: number; end: number } | null {
  const trimmed = location.trim()
  const colon = trimmed.lastIndexOf(':')
  if (colon < 0) return null
  const file = trimmed.slice(0, colon).split(/[\\/]/).at(-1) ?? ''
  const [startText, endText = startText] = trimmed.slice(colon + 1).split('-', 2)
  const start = Number.parseInt(startText.split('.')[0], 10)
  const parsedEnd = Number.parseInt(endText.split('.')[0], 10)
  if (!Number.isFinite(start) || !Number.isFinite(parsedEnd)) return null
  return { file, start, end: Math.max(start, parsedEnd) }
}

function insertBounded(values: Set<number>, id: number): boolean {
  if (!values.has(id) && values.size < SOURCE_ROOT_COLLECTION_CAP) values.add(id)
  return values.size >= SOURCE_ROOT_COLLECTION_CAP
}

function rangeLines(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index)
}

function groupBy<T, K>(values: T[], key: (value: T) => K): Map<K, T[]> {
  const grouped = new Map<K, T[]>()
  for (const value of values) {
    const itemKey = key(value)
    const entries = grouped.get(itemKey) ?? []
    entries.push(value)
    grouped.set(itemKey, entries)
  }
  return grouped
}

function compareExplorationEdges(a: ExplorationEdge, b: ExplorationEdge): number {
  return compareTuples(
    [a.from, a.to, a.from_port, a.to_port, a.net_name, Number(a.control), a.bit ?? -1],
    [b.from, b.to, b.from_port, b.to_port, b.net_name, Number(b.control), b.bit ?? -1],
  )
}

function compareGraphEdges(a: GraphEdge, b: GraphEdge): number {
  const fixed = compareTuples(
    [a.from, a.to, a.from_port, a.to_port, a.net_name, Number(a.control)],
    [b.from, b.to, b.from_port, b.to_port, b.net_name, Number(b.control)],
  )
  if (fixed !== 0) return fixed
  for (let index = 0; index < Math.min(a.bits.length, b.bits.length); index += 1) {
    const compared = numberCompare(a.bits[index], b.bits[index])
    if (compared !== 0) return compared
  }
  return numberCompare(a.bits.length, b.bits.length)
}

function compareTuples(a: Array<string | number>, b: Array<string | number>): number {
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] < b[index]) return -1
    if (a[index] > b[index]) return 1
  }
  return 0
}

function capEdges(subgraph: Subgraph): Subgraph {
  subgraph.edges.sort(compareGraphEdges)
  if (subgraph.edges.length > MAX_SUBGRAPH_EDGES) {
    subgraph.edges.length = MAX_SUBGRAPH_EDGES
    subgraph.truncated = true
  }
  return subgraph
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort(numberCompare)
}

function stripBitSuffix(value: string): string {
  return value.replace(/\[\d+\]$/, '')
}

function numberCompare(a: number, b: number): number {
  return a - b
}
