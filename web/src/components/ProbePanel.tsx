import { useStore } from '../store'

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
        probe.nodeIds.map((id) => (
          <div className="probe-item" key={id}>
            <span className="mono">node #{id}</span>
            <span className="row">
              <a
                onClick={() =>
                  store.openCone({ node: id, dir: 'fanin', label: `node #${id}` })
                }
              >
                fanin
              </a>
              <a
                onClick={() =>
                  store.openCone({ node: id, dir: 'fanout', label: `node #${id}` })
                }
              >
                fanout
              </a>
            </span>
          </div>
        ))
      )}
    </div>
  )
}
