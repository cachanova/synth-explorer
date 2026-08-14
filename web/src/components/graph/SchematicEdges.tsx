import { memo } from 'react'
import type { LaidOutGraph, Point } from '../../lib/graph/elkGraph'
import { shortNetName } from '../../lib/graph/prettyType'
import type { GraphNode } from '../../types'

function pathD(points: Point[]): string {
  if (points.length === 0) return ''
  let d = `M ${points[0].x} ${points[0].y}`
  for (let i = 1; i < points.length; i++) d += ` L ${points[i].x} ${points[i].y}`
  return d
}

interface SchematicEdgesProps {
  prepared: PreparedSchematicEdges
}

interface SelectedSchematicEdgeBatch {
  key: string
  d: string
  count: number
  indexes: number[]
  relevant: boolean
  control: boolean
  isBus: boolean
}

interface SelectedSchematicArrowBatch {
  key: string
  d: string
  count: number
  relevant: boolean
  control: boolean
}

interface PreparedSelectedSchematicEdges {
  batches: SelectedSchematicEdgeBatch[]
  arrows: SelectedSchematicArrowBatch[]
}

interface SchematicEdgeStyleKeys {
  batch: string
  arrow: string
}

interface SchematicEdgeGeometry {
  index: number
  from: number
  to: number
  points: Point[]
  title: string
  bits: number
  netName: string
  netBits: number[]
  isBus: boolean
  control: boolean
  fromKind: GraphNode['kind'] | undefined
  toKind: GraphNode['kind'] | undefined
  lineD: string
  arrowDs: readonly [string, string]
  selectedArrowD: string
  styleKeys: readonly SchematicEdgeStyleKeys[]
  mid: Point | null
}

export interface PreparedSchematicEdge extends SchematicEdgeGeometry {
  relevant: boolean
  highlighted: boolean
  arrowD: string
}

interface SchematicEdgeBatch {
  key: string
  d: string
  count: number
  firstTitle: string
  relevant: boolean
  control: boolean
  isBus: boolean
  highlighted: boolean
  dimmed: boolean
}

interface SchematicArrowBatch {
  key: string
  d: string
  count: number
  relevant: boolean
  control: boolean
  highlighted: boolean
  dimmed: boolean
}

export interface PreparedSchematicEdges {
  edges: PreparedSchematicEdge[]
  batches: SchematicEdgeBatch[]
  arrows: SchematicArrowBatch[]
  incidentByNode: Map<number, PreparedSchematicEdge[]>
  dimmedEdgeKeys: Set<number>
}

interface SchematicEdgeGeometryFacts {
  edges: SchematicEdgeGeometry[]
}

export const EMPTY_PREPARED_SCHEMATIC_EDGES: PreparedSchematicEdge[] = []

function edgeBatchKey(
  relevant: boolean,
  control: boolean,
  isBus: boolean,
  highlighted: boolean,
  dimmed = false,
): string {
  return `${relevant ? 1 : 0}${control ? 1 : 0}${isBus ? 1 : 0}${highlighted ? 1 : 0}${dimmed ? 1 : 0}`
}

function edgeClassName(
  control: boolean,
  isBus: boolean,
  highlighted: boolean,
  dimmed = false,
): string {
  return `g-edge${control ? ' control' : ''}${isBus ? ' bus' : ''}${highlighted ? ' hl' : ''}${dimmed ? ' g-dimmed' : ''}`
}

function edgePaintOrder(batch: {
  relevant: boolean
  control: boolean
  isBus?: boolean
  highlighted: boolean
  dimmed?: boolean
}): number {
  // Paint context first and highlighted nets last. This makes the semantic
  // overlay deterministic instead of depending on analysis-response edge order.
  return (
    (batch.highlighted ? 8 : 0) +
    (batch.relevant ? 4 : 0) +
    (batch.control ? 2 : 0) +
    (batch.isBus ? 1 : 0) +
    (batch.dimmed ? 0 : 16)
  )
}

function edgeStrokeWidth(
  edge: Pick<PreparedSchematicEdge, 'isBus' | 'highlighted'>,
): number {
  if (edge.highlighted) return 2.2
  if (edge.isBus) return 2.4
  return 1.3
}

function edgeArrowD(points: Point[], strokeWidth: number): string {
  if (points.length < 2) return ''
  const tipAnchor = points[points.length - 1]
  let previousIndex = points.length - 2
  while (
    previousIndex >= 0 &&
    points[previousIndex].x === tipAnchor.x &&
    points[previousIndex].y === tipAnchor.y
  ) {
    previousIndex -= 1
  }
  if (previousIndex < 0) return ''
  const previous = points[previousIndex]
  const dx = tipAnchor.x - previous.x
  const dy = tipAnchor.y - previous.y
  const length = Math.hypot(dx, dy)
  if (length === 0) return ''
  const ux = dx / length
  const uy = dy / length
  const px = -uy
  const py = ux

  // Match the former marker: viewBox 0 0 10 10, ref 9 5, marker 7x7,
  // markerUnits=strokeWidth. The triangle tip sits 0.7 stroke widths past the
  // edge endpoint and its base 6.3 stroke widths behind it.
  const tipX = tipAnchor.x + ux * 0.7 * strokeWidth
  const tipY = tipAnchor.y + uy * 0.7 * strokeWidth
  const baseX = tipAnchor.x - ux * 6.3 * strokeWidth
  const baseY = tipAnchor.y - uy * 6.3 * strokeWidth
  const halfWidth = 3.5 * strokeWidth
  return [
    `M ${baseX + px * halfWidth} ${baseY + py * halfWidth}`,
    `L ${tipX} ${tipY}`,
    `L ${baseX - px * halfWidth} ${baseY - py * halfWidth}`,
    'Z',
  ].join(' ')
}

export function prepareSchematicEdgeGeometry(
  graph: LaidOutGraph,
): SchematicEdgeGeometryFacts {
  const prepared: SchematicEdgeGeometry[] = []
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))

  graph.edges.forEach((laidOutEdge, index) => {
    let points = laidOutEdge.points
    if (points.length < 2) {
      const from = nodeById.get(laidOutEdge.from)
      const to = nodeById.get(laidOutEdge.to)
      if (from && to) {
        points = [
          { x: from.x + from.width, y: from.y + from.height / 2 },
          { x: to.x, y: to.y + to.height / 2 },
        ]
      }
    }
    const bits = laidOutEdge.edge.bits.length
    const isBus = bits > 1
    const control = Boolean(laidOutEdge.edge.control)
    const mid = points.length > 0 ? points[Math.floor(points.length / 2)] : null
    const title = `${shortNetName(laidOutEdge.edge.net_name)} (${bits} bit${isBus ? 's' : ''}): ${laidOutEdge.edge.from_port}→${laidOutEdge.edge.to_port}`
    const lineD = pathD(points)
    const selectedArrowD = edgeArrowD(points, isBus ? 2.4 : 2.2)
    const styleKeys = Array.from({ length: 8 }, (_, variant) => {
      const relevant = (variant & 4) !== 0
      const highlighted = (variant & 2) !== 0
      const dimmed = (variant & 1) !== 0
      return {
        batch: edgeBatchKey(relevant, control, isBus, highlighted, dimmed),
        arrow:
          `${relevant ? 1 : 0}${control ? 1 : 0}${highlighted ? 1 : 0}${dimmed ? 1 : 0}`,
      }
    })
    prepared.push({
      index,
      from: laidOutEdge.from,
      to: laidOutEdge.to,
      points,
      title,
      bits,
      netName: laidOutEdge.edge.net_name,
      netBits: laidOutEdge.edge.bits,
      isBus,
      control,
      fromKind: nodeById.get(laidOutEdge.from)?.node.kind,
      toKind: nodeById.get(laidOutEdge.to)?.node.kind,
      lineD,
      arrowDs: [
        edgeArrowD(points, edgeStrokeWidth({ isBus, highlighted: false })),
        edgeArrowD(points, edgeStrokeWidth({ isBus, highlighted: true })),
      ],
      selectedArrowD,
      styleKeys,
      mid,
    })
  })

  return { edges: prepared }
}

export function bucketSchematicEdges(
  facts: SchematicEdgeGeometryFacts,
  relevantIds: Set<number>,
  overlayIds: Set<number>,
  highlightedBits: Set<number>,
  extendOverlayToBoundaryNets: boolean,
  relatedEdgeKeys: Set<number>,
  selectionActive: boolean,
): PreparedSchematicEdges {
  const edges: PreparedSchematicEdge[] = []
  const batchBuilders = new Map<string, SchematicEdgeBatch & { paths: string[] }>()
  const arrowBuilders = new Map<string, SchematicArrowBatch & { paths: string[] }>()
  const incidentByNode = new Map<number, PreparedSchematicEdge[]>()
  const dimmedEdgeKeys = new Set<number>()

  for (const geometry of facts.edges) {
    const relevant =
      relevantIds.size === 0 ||
      (relevantIds.has(geometry.from) && relevantIds.has(geometry.to))
    const fromHighlighted = overlayIds.has(geometry.from)
    const toHighlighted = overlayIds.has(geometry.to)
    // Source overlays name logic cells, not their port/constant boundary
    // nodes. Keep those terminal nets continuous without lighting up branches
    // from the selected logic into unrelated context cells.
    const exactBitHighlighted = geometry.netBits.some((bit) =>
      highlightedBits.has(bit),
    )
    const highlighted =
      exactBitHighlighted ||
      (highlightedBits.size === 0 &&
        ((fromHighlighted && toHighlighted) ||
          (extendOverlayToBoundaryNets &&
            relevant &&
            ((fromHighlighted &&
              geometry.toKind != null &&
              geometry.toKind !== 'cell') ||
              (toHighlighted &&
                geometry.fromKind != null &&
                geometry.fromKind !== 'cell')))))
    const dimmed = selectionActive && !relatedEdgeKeys.has(geometry.index)
    if (dimmed) dimmedEdgeKeys.add(geometry.index)
    const styleVariant =
      (relevant ? 4 : 0) | (highlighted ? 2 : 0) | (dimmed ? 1 : 0)
    const styleKeys = geometry.styleKeys[styleVariant]
    const edge: PreparedSchematicEdge = {
      ...geometry,
      relevant,
      highlighted,
      arrowD: geometry.arrowDs[highlighted ? 1 : 0],
    }
    edges.push(edge)
    for (const nodeId of edge.from === edge.to
      ? [edge.from]
      : [edge.from, edge.to]) {
      const incident = incidentByNode.get(nodeId)
      if (incident) incident.push(edge)
      else incidentByNode.set(nodeId, [edge])
    }

    let batch = batchBuilders.get(styleKeys.batch)
    if (!batch) {
      batch = {
        key: styleKeys.batch,
        d: '',
        count: 0,
        firstTitle: edge.title,
        relevant: edge.relevant,
        control: edge.control,
        isBus: edge.isBus,
        highlighted: edge.highlighted,
        dimmed,
        paths: [],
      }
      batchBuilders.set(styleKeys.batch, batch)
    }
    batch.count += 1
    if (edge.lineD) batch.paths.push(edge.lineD)

    if (edge.arrowD) {
      let arrowBatch = arrowBuilders.get(styleKeys.arrow)
      if (!arrowBatch) {
        arrowBatch = {
          key: styleKeys.arrow,
          d: '',
          count: 0,
          relevant: edge.relevant,
          control: edge.control,
          highlighted: edge.highlighted,
          dimmed,
          paths: [],
        }
        arrowBuilders.set(styleKeys.arrow, arrowBatch)
      }
      arrowBatch.count += 1
      arrowBatch.paths.push(edge.arrowD)
    }
  }

  const batches = [...batchBuilders.values()]
    .map(({ paths, ...batch }) => ({ ...batch, d: paths.join(' ') }))
    .sort((a, b) => edgePaintOrder(a) - edgePaintOrder(b))
  const arrows = [...arrowBuilders.values()]
    .map(({ paths, ...batch }) => ({ ...batch, d: paths.join(' ') }))
    .sort((a, b) => edgePaintOrder(a) - edgePaintOrder(b))
  return {
    edges,
    batches,
    arrows,
    incidentByNode,
    dimmedEdgeKeys,
  }
}

// Selection changes affect node state far more often than edge state. Keep the
// complete edge layer outside those reconciliations, and batch equal semantic
// styles into a bounded number of paths instead of mounting one path and title
// for every connection.
export const SchematicEdges = memo(function SchematicEdges({ prepared }: SchematicEdgesProps) {
  if (prepared.edges.length === 0) return null
  return (
    <g
      className="g-edge-layer"
      role="img"
      aria-label={`${prepared.edges.length} schematic connection${prepared.edges.length === 1 ? '' : 's'}. Inspect nodes for accessible fanin and fanout details.`}
    >
      {prepared.batches.map((batch) => (
        <path
          key={batch.key}
          className={edgeClassName(
            batch.control,
            batch.isBus,
            batch.highlighted,
            batch.dimmed,
          )}
          d={batch.d}
          data-edge-batch={batch.key}
          data-edge-count={batch.count}
          data-first-edge-title={batch.firstTitle}
          data-relevant={batch.relevant ? 1 : 0}
          aria-hidden="true"
        />
      ))}
      {prepared.arrows.map((batch) => (
        <path
          key={batch.key}
          className={`g-edge-arrows${batch.control ? ' control' : ''}${batch.highlighted ? ' hl' : ''}${batch.dimmed ? ' g-dimmed' : ''}`}
          d={batch.d}
          data-arrow-count={batch.count}
          data-relevant={batch.relevant ? 1 : 0}
          aria-hidden="true"
        />
      ))}
      {prepared.edges.map((edge) => edge.isBus && edge.mid ? (
        <text
          key={edge.index}
          className={`g-bus-label${prepared.dimmedEdgeKeys.has(edge.index) ? ' g-dimmed' : ''}`}
          x={edge.mid.x}
          y={edge.mid.y - 3}
          textAnchor="middle"
          aria-hidden="true"
          data-relevant={edge.relevant ? 1 : 0}
        >
          {edge.bits}
        </text>
      ) : null)}
    </g>
  )
})

function prepareSelectedSchematicEdges(
  edges: PreparedSchematicEdge[],
): PreparedSelectedSchematicEdges {
  const batchBuilders = new Map<
    string,
    Omit<SelectedSchematicEdgeBatch, 'd'> & { paths: string[] }
  >()
  const arrowBuilders = new Map<
    string,
    Omit<SelectedSchematicArrowBatch, 'd'> & { paths: string[] }
  >()

  for (const edge of edges) {
    if (edge.lineD) {
      const key = edgeBatchKey(edge.relevant, edge.control, edge.isBus, true)
      const batch = batchBuilders.get(key) ?? {
        key,
        count: 0,
        indexes: [],
        relevant: edge.relevant,
        control: edge.control,
        isBus: edge.isBus,
        paths: [],
      }
      batch.count += 1
      batch.indexes.push(edge.index)
      batch.paths.push(edge.lineD)
      batchBuilders.set(key, batch)
    }

    if (edge.selectedArrowD) {
      const key =
        `${edge.relevant ? 1 : 0}${edge.control ? 1 : 0}${edge.isBus ? 1 : 0}`
      const batch = arrowBuilders.get(key) ?? {
        key,
        count: 0,
        relevant: edge.relevant,
        control: edge.control,
        paths: [],
      }
      batch.count += 1
      batch.paths.push(edge.selectedArrowD)
      arrowBuilders.set(key, batch)
    }
  }

  return {
    batches: [...batchBuilders.values()].map(({ paths, ...batch }) => ({
      ...batch,
      d: paths.join(' '),
    })),
    arrows: [...arrowBuilders.values()].map(({ paths, ...batch }) => ({
      ...batch,
      d: paths.join(' '),
    })),
  }
}

export const SelectedSchematicEdges = memo(function SelectedSchematicEdges({
  edges,
}: {
  edges: PreparedSchematicEdge[]
}) {
  if (edges.length === 0) return null
  const prepared = prepareSelectedSchematicEdges(edges)
  return (
    <g className="g-selected-edge-layer" aria-hidden="true">
      {prepared.batches.map((batch) => (
        <path
          key={batch.key}
          className={edgeClassName(batch.control, batch.isBus, true)}
          d={batch.d}
          data-selected-edge-count={batch.count}
          data-selected-edge-indices={batch.indexes.join(',')}
          data-relevant={batch.relevant ? 1 : 0}
        />
      ))}
      {prepared.arrows.map((batch) => (
        <path
          key={batch.key}
          className={`g-edge-arrows${batch.control ? ' control' : ''} hl`}
          d={batch.d}
          data-selected-arrow-count={batch.count}
          data-relevant={batch.relevant ? 1 : 0}
        />
      ))}
    </g>
  )
})
