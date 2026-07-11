import { designSrcSpans, srcLabel } from '../lib/src'
import { displayNodeName, nodeLabel } from '../lib/prettyType'
import { useStore } from '../store'
import type { GraphNode } from '../types'

export function NodeCard({
  node,
  drivingNet,
  onClose,
}: {
  node: GraphNode
  drivingNet?: string | null
  onClose: () => void
}) {
  const store = useStore()
  const params = node.params ? Object.entries(node.params) : []
  const spans = designSrcSpans(node.src, store.files)
  const name = displayNodeName(node, drivingNet)

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
                <span className="t">{index === 0 ? 'primary' : 'contributor'}</span>
                <span className="n">{srcLabel(span)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <details className="collapsible" style={{ margin: '8px 0' }}>
        <summary>Yosys details</summary>
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

      <div className="actions">
        <button
          onClick={() =>
            store.openCone({ node: node.id, dir: 'fanin', label: `${name} (fanin)` })
          }
        >
          Fanin cone
        </button>
        <button
          onClick={() =>
            store.openCone({
              node: node.id,
              dir: 'fanout',
              label: `${name} (fanout)`,
            })
          }
        >
          Fanout cone
        </button>
      </div>
    </div>
  )
}

function truncateMid(s: string, n: number): string {
  if (s.length <= n) return s
  const half = Math.floor((n - 1) / 2)
  return `${s.slice(0, half)}…${s.slice(s.length - half)}`
}
