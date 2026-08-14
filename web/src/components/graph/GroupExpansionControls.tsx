import { useEffect, useMemo, useState, type RefObject } from 'react'
import type { LaidOutGraph } from '../../lib/graph/elkGraph'
import type { GraphNode } from '../../types'
import type { ExpandedGroupFrame } from './GraphView'
import { graphNodeElement, graphNodeId } from './SchematicNodes'

function activateGroupControl(
  event: React.KeyboardEvent<SVGGElement>,
  action: () => void,
) {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  event.stopPropagation()
  action()
}

function groupControlTargetId(
  target: EventTarget | null,
  viewport: SVGGElement,
  collapsedGroupIds: ReadonlySet<number>,
  expandedControlByMember: ReadonlyMap<number, number>,
): number | null {
  const element = target instanceof Element ? target : null
  const control = element?.closest<SVGGElement>(
    '.g-group-toggle[data-control-node-id]',
  )
  if (control && viewport.contains(control)) {
    const id = Number(control.dataset.controlNodeId)
    return Number.isFinite(id) ? id : null
  }
  const nodeId = graphNodeId(graphNodeElement(target, viewport))
  if (nodeId == null) return null
  if (collapsedGroupIds.has(nodeId)) return nodeId
  return expandedControlByMember.get(nodeId) ?? null
}

function expandedGroupTargetIdAtPoint(
  viewport: SVGGElement,
  expandedGroups: ExpandedGroupFrame[],
  clientX: number,
  clientY: number,
): number | null {
  for (const group of expandedGroups) {
    const boundary = viewport.querySelector<SVGRectElement>(
      `[data-expanded-group-id="${group.id}"] .g-expanded-group-boundary`,
    )
    if (!boundary) continue
    const box = boundary.getBoundingClientRect()
    if (
      clientX >= box.left &&
      clientX <= box.right &&
      clientY >= box.top &&
      clientY <= box.bottom
    ) {
      return group.members[0] ?? null
    }
  }
  return null
}

const GROUP_EXPAND_TOGGLE_INSET = 3
const GROUP_COLLAPSE_TOGGLE_INSET = 17
const GROUP_TOGGLE_HIT_RADIUS = 19
const GROUP_TOGGLE_GLYPH_RADIUS = 5

export function GroupExpansionControls({
  viewportRef,
  graph,
  expandedGroups,
  relevantIds,
  interactive,
  onExpand,
  onCollapse,
}: {
  viewportRef: RefObject<SVGGElement | null>
  graph: LaidOutGraph
  expandedGroups: ExpandedGroupFrame[]
  relevantIds: Set<number>
  interactive: boolean
  onExpand?: (node: GraphNode) => void
  onCollapse?: (groupId: number) => void
}) {
  const [hoveredNodeId, setHoveredNodeId] = useState<number | null>(null)
  const [focusedNodeId, setFocusedNodeId] = useState<number | null>(null)
  const collapsedGroupIds = useMemo(() => new Set(
    graph.nodes.flatMap((laidOutNode) =>
      laidOutNode.node.kind !== 'port' &&
      (laidOutNode.node.member_count != null || laidOutNode.node.members != null)
        ? [laidOutNode.id]
        : [],
    ),
  ), [graph.nodes])
  const expandedControlByMember = useMemo(() => new Map(
    expandedGroups.flatMap((group) => {
      const controlMemberId = group.members[0]
      return controlMemberId == null
        ? []
        : group.members.map((member) => [member, controlMemberId] as const)
    }),
  ), [expandedGroups])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const pointerSurface = viewport.ownerSVGElement ?? viewport

    const onPointerOver = (event: PointerEvent) => {
      const current =
        groupControlTargetId(
          event.target,
          viewport,
          collapsedGroupIds,
          expandedControlByMember,
        ) ??
        expandedGroupTargetIdAtPoint(
          viewport,
          expandedGroups,
          event.clientX,
          event.clientY,
        )
      const previous = groupControlTargetId(
        event.relatedTarget,
        viewport,
        collapsedGroupIds,
        expandedControlByMember,
      )
      if (current !== previous) setHoveredNodeId(current)
    }
    const onPointerMove = (event: PointerEvent) => {
      const current =
        groupControlTargetId(
          event.target,
          viewport,
          collapsedGroupIds,
          expandedControlByMember,
        ) ??
        expandedGroupTargetIdAtPoint(
          viewport,
          expandedGroups,
          event.clientX,
          event.clientY,
        )
      setHoveredNodeId((previous) => previous === current ? previous : current)
    }
    const onPointerOut = (event: PointerEvent) => {
      const current = groupControlTargetId(
        event.target,
        viewport,
        collapsedGroupIds,
        expandedControlByMember,
      )
      const next =
        groupControlTargetId(
          event.relatedTarget,
          viewport,
          collapsedGroupIds,
          expandedControlByMember,
        ) ??
        expandedGroupTargetIdAtPoint(
          viewport,
          expandedGroups,
          event.clientX,
          event.clientY,
        )
      if (current !== next) setHoveredNodeId(next)
    }
    const onPointerLeave = () => {
      setHoveredNodeId(null)
    }
    const onFocusIn = (event: FocusEvent) => {
      setFocusedNodeId(groupControlTargetId(
        event.target,
        viewport,
        collapsedGroupIds,
        expandedControlByMember,
      ))
    }
    const onFocusOut = (event: FocusEvent) => {
      setFocusedNodeId(groupControlTargetId(
        event.relatedTarget,
        viewport,
        collapsedGroupIds,
        expandedControlByMember,
      ))
    }

    pointerSurface.addEventListener('pointerover', onPointerOver)
    pointerSurface.addEventListener('pointermove', onPointerMove)
    pointerSurface.addEventListener('pointerout', onPointerOut)
    pointerSurface.addEventListener('pointerleave', onPointerLeave)
    viewport.addEventListener('focusin', onFocusIn)
    viewport.addEventListener('focusout', onFocusOut)
    return () => {
      pointerSurface.removeEventListener('pointerover', onPointerOver)
      pointerSurface.removeEventListener('pointermove', onPointerMove)
      pointerSurface.removeEventListener('pointerout', onPointerOut)
      pointerSurface.removeEventListener('pointerleave', onPointerLeave)
      viewport.removeEventListener('focusin', onFocusIn)
      viewport.removeEventListener('focusout', onFocusOut)
    }
  }, [
    collapsedGroupIds,
    expandedControlByMember,
    expandedGroups,
    viewportRef,
  ])

  const activeNodeId = hoveredNodeId ?? focusedNodeId
  if (!interactive) return null
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))
  const laidOutGroupById = new Map(
    (graph.groups ?? []).map((group) => [group.id, group]),
  )
  const expandedMemberIds = new Set(
    expandedGroups.flatMap((group) => group.members),
  )

  return (
    <g className="g-group-controls">
      {onCollapse && expandedGroups.flatMap((group) => {
        const members = group.members.flatMap((memberId) => {
          const member = nodeById.get(memberId)
          return member && member.node.kind !== 'port' ? [member] : []
        })
        if (members.length === 0) return []
        const compound = laidOutGroupById.get(group.id)
        const left = compound?.x ?? Math.min(...members.map((member) => member.x)) - 16
        const top = compound?.y ?? Math.min(...members.map((member) => member.y)) - 30
        const right = compound
          ? compound.x + compound.width
          : Math.max(...members.map((member) => member.x + member.width)) + 16
        const bottom = compound
          ? compound.y + compound.height
          : Math.max(...members.map((member) => member.y + member.height)) + 16
        const controlMemberId = members[0].id
        const active = activeNodeId != null && group.members.includes(activeNodeId)
        return [
          <g
            key={`expanded-${group.id}`}
            className="g-expanded-group"
            data-expanded-group-id={group.id}
          >
            <rect
              className="g-expanded-group-boundary"
              x={left}
              y={top}
              width={right - left}
              height={bottom - top}
              rx={5}
            />
            <text
              className="g-expanded-group-label"
              x={left + 11}
              y={top + 19}
            >
              {group.label}
            </text>
            <g
              className={`g-group-toggle${active ? ' component-active' : ''}`}
              data-group-action="collapse"
              data-group-id={group.id}
              data-control-node-id={controlMemberId}
              data-relevant={
                relevantIds.size === 0 ||
                group.members.some((member) => relevantIds.has(member))
                  ? 1
                  : 0
              }
              role="button"
              tabIndex={0}
              aria-label={`Collapse group ${group.label}`}
              transform={`translate(${
                right - GROUP_COLLAPSE_TOGGLE_INSET
              },${top + GROUP_COLLAPSE_TOGGLE_INSET})`}
              onPointerDown={(event) => {
                event.stopPropagation()
              }}
              onPointerUp={(event) => {
                event.stopPropagation()
                onCollapse(group.id)
              }}
              onClick={(event) => {
                event.stopPropagation()
              }}
              onKeyDown={(event) => activateGroupControl(event, () => onCollapse(group.id))}
            >
              <circle className="g-group-toggle-hit" r={GROUP_TOGGLE_HIT_RADIUS} />
              <path
                d={`M-${GROUP_TOGGLE_GLYPH_RADIUS} 0H${GROUP_TOGGLE_GLYPH_RADIUS}`}
              />
            </g>
          </g>,
        ]
      })}
      {onExpand && graph.nodes.map((laidOutNode) => {
        if (laidOutNode.node.kind === 'port') return null
        if (expandedMemberIds.has(laidOutNode.id)) return null
        if (laidOutNode.node.member_count == null && laidOutNode.node.members == null) return null
        return (
          <g
            key={`collapsed-${laidOutNode.id}`}
            className={`g-group-toggle${
              activeNodeId === laidOutNode.id ? ' component-active' : ''
            }`}
            data-group-action="expand"
            data-group-id={laidOutNode.id}
            data-control-node-id={laidOutNode.id}
            data-relevant={
              relevantIds.size === 0 || relevantIds.has(laidOutNode.id) ? 1 : 0
            }
            role="button"
            tabIndex={0}
            aria-label={`Expand group ${laidOutNode.node.name}`}
            transform={`translate(${
              laidOutNode.x + laidOutNode.width - GROUP_EXPAND_TOGGLE_INSET
            },${laidOutNode.y + GROUP_EXPAND_TOGGLE_INSET})`}
            onPointerDown={(event) => {
              // Do not let viewport panning claim this small SVG control.
              event.stopPropagation()
            }}
            onPointerUp={(event) => {
              // SVG clicks can be retargeted after the viewport's pointer
              // gesture; commit on release after suppressing that gesture.
              event.stopPropagation()
              onExpand(laidOutNode.node)
            }}
            onClick={(event) => {
              event.stopPropagation()
            }}
            onKeyDown={(event) => activateGroupControl(event, () => onExpand(laidOutNode.node))}
          >
            <circle className="g-group-toggle-hit" r={GROUP_TOGGLE_HIT_RADIUS} />
            <path
              d={
                `M-${GROUP_TOGGLE_GLYPH_RADIUS} 0H${GROUP_TOGGLE_GLYPH_RADIUS}` +
                `M0 -${GROUP_TOGGLE_GLYPH_RADIUS}V${GROUP_TOGGLE_GLYPH_RADIUS}`
              }
            />
          </g>
        )
      })}
    </g>
  )
}
