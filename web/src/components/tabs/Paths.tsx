import { useState } from 'react'
import { getPaths } from '../../api'
import { useDesignData } from '../../lib/useDesignData'
import { displayCellType, displayNodeName, nodeSublabel } from '../../lib/prettyType'
import { useStore } from '../../store'
import type { NodeRef, TimingPath } from '../../types'
import { SrcLink } from '../SrcLink'

export function Paths() {
  const store = useStore()
  const id = store.design?.design_id ?? null
  const { data, loading, error } = useDesignData(id, (i) => getPaths(i, { limit: 25 }))
  const [open, setOpen] = useState<number | null>(null)

  if (!store.design) return <div className="empty-state">No design yet.</div>
  if (loading && !data) return <div className="empty-state">Loading paths…</div>
  if (error) return <div className="empty-state">Failed to load paths: {error}</div>
  if (!data || data.paths.length === 0)
    return <div className="empty-state">No structural paths reported.</div>

  return (
    <div>
      {data.comb_loops.length > 0 && (
        <div className="warn-list" style={{ marginBottom: 10 }}>
          <li>
            Combinational loops excluded: {data.comb_loops.join(', ')}
          </li>
        </div>
      )}
      <div className="section-title">
        Longest structural paths ({data.paths.length})
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th className="num">#</th>
            <th className="num">Depth</th>
            <th>Startpoint</th>
            <th>Endpoint</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {data.paths.map((p, i) => (
            <PathRow
              key={i}
              i={i}
              p={p}
              open={open === i}
              onToggle={() => setOpen(open === i ? null : i)}
              onShow={() => store.showPathInGraph(p)}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function PathRow({
  i,
  p,
  open,
  onToggle,
  onShow,
}: {
  i: number
  p: TimingPath
  open: boolean
  onToggle: () => void
  onShow: () => void
}) {
  return (
    <>
      <tr className={`clickable${open ? ' expanded' : ''}`} onClick={onToggle}>
        <td className="num faint">{i + 1}</td>
        <td className="num">
          <span className="depth-chip">{p.depth}</span>
        </td>
        <td className="mono">{displayNodeName(p.startpoint)}</td>
        <td className="mono">
          {displayNodeName(p.endpoint)}
          <span className="faint"> ·{p.endpoint_port}</span>
        </td>
        <td>
          <a
            onClick={(e) => {
              e.stopPropagation()
              onShow()
            }}
          >
            graph
          </a>
        </td>
      </tr>
      {open && (
        <tr className="expanded">
          <td colSpan={5}>
            <div className="chain">
              {p.nodes.map((n, j) => (
                <Hop key={n.id} n={n} last={j === p.nodes.length - 1} />
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function Hop({ n, last }: { n: NodeRef; last: boolean }) {
  const label =
    n.kind === 'cell'
      ? displayCellType(n.cell_type)
      : n.kind === 'port'
        ? 'PORT'
        : 'CONST'
  // Hidden names have nothing readable to add under the type; real names and
  // src links keep the sublabel row.
  const name = nodeSublabel(n)
  return (
    <>
      <span
        className={`hop${n.seq ? ' seq' : ''}`}
        title={n.cell_type ? `yosys type: ${n.cell_type}` : undefined}
      >
        <span className="t">{label}</span>
        {(name || n.src) && (
          <span className="n">
            {name}
            {name && n.src ? ' ' : ''}
            {n.src ? <SrcLink src={n.src} /> : null}
          </span>
        )}
      </span>
      {!last && <span className="arrow">→</span>}
    </>
  )
}
