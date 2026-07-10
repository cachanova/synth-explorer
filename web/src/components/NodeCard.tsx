import { parseSrc } from '../lib/src'
import { nodeLabel } from '../lib/prettyType'
import { useStore } from '../store'
import type { GraphNode } from '../types'
import { SrcLink } from './SrcLink'

export function NodeCard({
  node,
  onClose,
}: {
  node: GraphNode
  onClose: () => void
}) {
  const store = useStore()
  const params = node.params ? Object.entries(node.params) : []
  const spans = parseSrc(node.src)

  return (
    <div className="node-card">
      <button className="close" onClick={onClose} title="Close">
        ×
      </button>
      <h4>{nodeLabel(node)}</h4>
      <div className="kv">
        <span className="k">kind</span>
        <span className="v">{node.kind}</span>
        {node.cell_type && (
          <>
            <span className="k">type</span>
            <span className="v">{node.cell_type}</span>
          </>
        )}
        <span className="k">name</span>
        <span className="v">{node.name}</span>
        <span className="k">id</span>
        <span className="v">{node.id}</span>
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

      {params.length > 0 && (
        <>
          <div className="section-title" style={{ margin: '8px 0 4px' }}>
            Params
          </div>
          <div className="kv">
            {params.map(([k, v]) => (
              <span key={k} style={{ display: 'contents' }}>
                <span className="k">{k}</span>
                <span className="v">{truncateMid(v, 40)}</span>
              </span>
            ))}
          </div>
        </>
      )}

      {spans.length > 0 && (
        <div style={{ margin: '8px 0' }}>
          <span className="k faint">src: </span>
          <SrcLink src={node.src} />
        </div>
      )}

      <div className="actions">
        <button
          onClick={() =>
            store.openCone({ node: node.id, dir: 'fanin', label: `${node.name} (fanin)` })
          }
        >
          Fanin cone
        </button>
        <button
          onClick={() =>
            store.openCone({
              node: node.id,
              dir: 'fanout',
              label: `${node.name} (fanout)`,
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
