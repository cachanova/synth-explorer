import { prettyCellType } from '../lib/prettyType'
import { useStore } from '../store'
import type { NodeRef } from '../types'
import { SrcLink } from './SrcLink'

function ProbeName({ id, node }: { id: number; node?: NodeRef }) {
  if (!node) return <span className="mono">node #{id}</span>
  return (
    <span className="row" style={{ gap: 6, minWidth: 0 }}>
      <span
        className="mono"
        style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        title={node.name}
      >
        {node.name}
      </span>
      <span className="tag">
        {node.kind === 'cell' ? prettyCellType(node.cell_type) : node.kind}
      </span>
      {node.seq && <span className="pill">seq</span>}
      {node.src && <SrcLink src={node.src} />}
    </span>
  )
}

export function ProbePanel() {
  const store = useStore()
  const probe = store.probe
  if (!probe) return null

  return (
    <div className="probe-panel">
      <div className="head">
        <span className="muted">
          Nodes at <span className="mono">{probe.file}:{probe.line}</span>{' '}
          <span className="faint">({probe.nodeIds.length})</span>
        </span>
        <button onClick={() => store.clearProbe()}>Close</button>
      </div>
      {probe.nodeIds.length === 0 ? (
        <div className="faint" style={{ fontSize: 12 }}>
          No synthesized nodes map to this line. ABC-generated gates/LUTs lose
          their source attribution — cross-probe is best-effort.
        </div>
      ) : (
        probe.nodeIds.map((id) => {
          const node = probe.refs[id]
          const label = node ? node.name : `node #${id}`
          return (
            <div className="probe-item" key={id}>
              <ProbeName id={id} node={node} />
              <span className="row">
                <a
                  onClick={() =>
                    store.openCone({ node: id, dir: 'fanin', label: `${label} (fanin)` })
                  }
                >
                  fanin
                </a>
                <a
                  onClick={() =>
                    store.openCone({ node: id, dir: 'fanout', label: `${label} (fanout)` })
                  }
                >
                  fanout
                </a>
              </span>
            </div>
          )
        })
      )}
    </div>
  )
}
