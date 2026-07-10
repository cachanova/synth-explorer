import { useMemo, useState } from 'react'
import { getEndpoints } from '../../api'
import { fuzzyFilter } from '../../lib/fuzzy'
import { useDesignData } from '../../lib/useDesignData'
import { useStore } from '../../store'
import type { OutputEndpoint, RegisterEndpoint } from '../../types'
import { SrcLink } from '../SrcLink'

export function Endpoints() {
  const store = useStore()
  const id = store.design?.design_id ?? null
  const { data, loading, error } = useDesignData(id, getEndpoints)
  const [filter, setFilter] = useState('')

  const regs = useMemo(
    () =>
      fuzzyFilter(
        [...(data?.registers ?? [])].sort((a, b) => b.worst_depth - a.worst_depth),
        filter,
        (r) => `${r.name} ${r.cell_type} ${r.clock ?? ''}`,
      ),
    [data, filter],
  )
  const outs = useMemo(
    () => fuzzyFilter(data?.outputs ?? [], filter, (o) => o.name),
    [data, filter],
  )

  if (!store.design) return <div className="empty-state">No design yet.</div>
  if (loading && !data) return <div className="empty-state">Loading endpoints…</div>
  if (error) return <div className="empty-state">Failed to load endpoints: {error}</div>

  return (
    <div>
      <input
        className="filter-input"
        placeholder="Filter endpoints…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />

      <div className="section-title">
        Registers ({regs.length}
        {data ? ` / ${data.registers.length}` : ''})
      </div>
      {regs.length === 0 ? (
        <div className="faint">No matching registers.</div>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Name</th>
              <th className="num">W</th>
              <th>Type</th>
              <th>Clock</th>
              <th className="num">Depth</th>
              <th>src</th>
            </tr>
          </thead>
          <tbody>
            {regs.map((r) => (
              <RegRow key={r.name} r={r} onOpen={store.openCone} />
            ))}
          </tbody>
        </table>
      )}

      <div className="section-title">
        Outputs ({outs.length}
        {data ? ` / ${data.outputs.length}` : ''})
      </div>
      {outs.length === 0 ? (
        <div className="faint">No matching outputs.</div>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Name</th>
              <th className="num">W</th>
              <th className="num">Depth</th>
            </tr>
          </thead>
          <tbody>
            {outs.map((o) => (
              <OutRow key={o.name} o={o} onOpen={store.openCone} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

type Opener = ReturnType<typeof useStore>['openCone']

function RegRow({ r, onOpen }: { r: RegisterEndpoint; onOpen: Opener }) {
  const node = r.bits[0]?.node_id
  return (
    <tr
      className="clickable"
      onClick={() =>
        node != null && onOpen({ node, dir: 'fanin', label: `${r.name} (fanin)` })
      }
      title="Open fanin cone in Graph"
    >
      <td className="mono">{r.name}</td>
      <td className="num">{r.width}</td>
      <td>
        <span className="tag">{r.cell_type}</span>
      </td>
      <td className="mono faint">{r.clock ?? '—'}</td>
      <td className="num">
        <span className="depth-chip">{r.worst_depth}</span>
      </td>
      <td>
        <SrcLink src={r.src} />
      </td>
    </tr>
  )
}

function OutRow({ o, onOpen }: { o: OutputEndpoint; onOpen: Opener }) {
  const node = o.bits[0]?.node_id
  return (
    <tr
      className="clickable"
      onClick={() =>
        node != null && onOpen({ node, dir: 'fanin', label: `${o.name} (fanin)` })
      }
      title="Open fanin cone in Graph"
    >
      <td className="mono">{o.name}</td>
      <td className="num">{o.width}</td>
      <td className="num">
        <span className="depth-chip">{o.worst_depth}</span>
      </td>
    </tr>
  )
}
