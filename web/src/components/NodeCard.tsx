import { designSrcSpans, srcLabel } from '../lib/src'
import { displayNodeName, nodeLabel } from '../lib/prettyType'
import { coneRootIds } from '../lib/graphProjection'
import { controlDriverIds, controlLabel, controlsFor, symbolKind } from '../lib/symbols'
import type { GraphNode } from '../types'
import { shallowEqual, useStore } from '../useStore'

export function NodeCard({
  node,
  drivingNet,
  onClose,
  onExpand,
}: {
  node: GraphNode
  drivingNet?: string | null
  onClose: () => void
  /** Additively render this node's connections in place (also on double-click). */
  onExpand?: () => void
}) {
  const store = useStore(
    ({
      design,
      files,
      editorHighlight,
      highlightSources,
      openCone,
      openControlCone,
    }) => ({
      design,
      files,
      editorHighlight,
      highlightSources,
      openCone,
      openControlCone,
    }),
    shallowEqual,
  )
  const params = node.params ? Object.entries(node.params) : []
  const tieredExact =
    store.editorHighlight?.sourceTiers?.nodeIds.includes(node.id)
      ? store.editorHighlight.sourceTiers.exact
      : []
  const spans =
    tieredExact.length > 0
      ? tieredExact
      : designSrcSpans(node.src, store.files)
  const name = displayNodeName(node, drivingNet)
  const controls = controlsFor(node)
  const groupedMemory = node.members != null && symbolKind(node) === 'memory'

  return (
    <div className="node-card">
      <button className="close" onClick={onClose} title="Close">
        ×
      </button>
      <h4>{nodeLabel(node)}</h4>
      <div className="kv">
        <span className="k">kind</span>
        <span className="v">{node.kind}</span>
        <span className="k">name</span>
        <span className="v">{name}</span>
        {node.depth != null && (
          <>
            <span className="k">depth</span>
            <span className="v">{node.depth}</span>
          </>
        )}
        {groupedMemory ? (
          <>
            <span className="k">primitives</span>
            <span className="v">{node.member_count ?? node.width ?? node.members?.length}</span>
          </>
        ) : node.width != null && node.width >= 2 ? (
          <>
            <span className="k">width</span>
            <span className="v">{node.width}</span>
            <span className="k">members</span>
            <span className="v">{node.width} bits</span>
          </>
        ) : null}
        {node.seq && (
          <>
            <span className="k">seq</span>
            <span className="v">yes</span>
          </>
        )}
        {node.is_boundary && (
          <>
            <span className="k">boundary</span>
            <span className="v">yes</span>
          </>
        )}
      </div>

      {spans.length > 0 && (
        <div style={{ margin: '8px 0' }}>
          <div className="section-title" style={{ margin: '8px 0 4px' }}>
            Source locations
          </div>
          <div className="chain">
            {spans.map((span, index) => (
              <button
                key={`${span.file}:${span.startLine}:${span.startCol}:${index}`}
                className="hop"
                onClick={() =>
                  store.highlightSources([
                    span,
                    ...spans.filter((_, other) => other !== index),
                  ])
                }
              >
                <span className="t">
                  {index === 0
                    ? 'primary'
                    : tieredExact.length > 0
                      ? 'exact'
                      : 'contributor'}
                </span>
                <span className="n">{srcLabel(span)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <details className="collapsible" style={{ margin: '8px 0' }}>
        <summary>{store.design?.tool === 'vivado' ? 'Vivado details' : 'Yosys details'}</summary>
        <div className="kv" style={{ marginTop: 6 }}>
          <span className="k">raw name</span>
          <span className="v">{node.name}</span>
          {node.cell_type && (
            <>
              <span className="k">raw type</span>
              <span className="v">{node.cell_type}</span>
            </>
          )}
          <span className="k">node id</span>
          <span className="v">{node.id}</span>
          {params.map(([k, v]) => (
            <span key={k} style={{ display: 'contents' }}>
              <span className="k">{k}</span>
              <span className="v">{truncateMid(v, 40)}</span>
            </span>
          ))}
        </div>
      </details>

      {controls.length > 0 && (
        <div style={{ margin: '8px 0' }}>
          <div className="section-title" style={{ margin: '8px 0 4px' }}>
            Controls
          </div>
          <div className="chain">
            {controls.map((control, index) => (
              <button
                key={`${control.role}-${control.driver_id}-${index}`}
                className="hop"
                onClick={() =>
                  store.openControlCone({
                    nodes: controlDriverIds(control),
                    label: controlLabel(control),
                    generated: control.generated,
                  })
                }
              >
                <span className="t">{control.role}</span>
                <span className="n">{controlLabel(control)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="actions">
        <button
          onClick={() =>
            store.openCone({
              nodes: coneRootIds(node),
              dir: 'fanin',
              label: `${name} (fanin)`,
            })
          }
        >
          Fanin cone
        </button>
        <button
          onClick={() =>
            store.openCone({
              nodes: coneRootIds(node),
              dir: 'fanout',
              label: `${name} (fanout)`,
            })
          }
        >
          Fanout cone
        </button>
        {onExpand && (
          <button
            onClick={onExpand}
            title="Add this node's fanin and fanout connections to the current schematic (or double-click the node)"
          >
            Expand here
          </button>
        )}
      </div>
    </div>
  )
}

function truncateMid(s: string, n: number): string {
  if (s.length <= n) return s
  const half = Math.floor((n - 1) / 2)
  return `${s.slice(0, half)}…${s.slice(s.length - half)}`
}
