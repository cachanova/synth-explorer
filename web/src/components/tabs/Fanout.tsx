import { useMemo, useState } from 'react'
import { getFanout } from '../../api'
import { fuzzyFilter } from '../../lib/fuzzy'
import { fanoutDriverLabel } from '../../lib/prettyType'
import { useDesignData } from '../../lib/useDesignData'
import { useStore } from '../../store'
import { SrcLink } from '../SrcLink'

export function Fanout() {
  const store = useStore()
  const id = store.design?.design_id ?? null
  const { data, loading, error } = useDesignData(id, (i) => getFanout(i, 50))
  const [filter, setFilter] = useState('')

  const drivers = useMemo(
    () =>
      fuzzyFilter(
        data?.drivers ?? [],
        filter,
        (d) => `${d.driver.name} ${d.net_name} ${d.port}`,
      ),
    [data, filter],
  )

  if (!store.design) return <div className="empty-state">No design yet.</div>
  if (loading && !data) return <div className="empty-state">Loading fanout…</div>
  if (error) return <div className="empty-state">Failed to load fanout: {error}</div>
  if (!data || data.drivers.length === 0)
    return <div className="empty-state">No fanout data.</div>

  return (
    <div>
      <input
        className="filter-input"
        placeholder="Filter drivers / nets…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="section-title">High-fanout drivers ({drivers.length})</div>
      <table className="grid">
        <thead>
          <tr>
            <th>Driver</th>
            <th>Net</th>
            <th className="num">Fanout</th>
            <th className="num">Endpoints</th>
            <th></th>
            <th>src</th>
          </tr>
        </thead>
        <tbody>
          {drivers.map((d, i) => {
            const label = fanoutDriverLabel(d.driver, d.net_name)
            const prettified = label !== d.driver.name
            return (
            <tr
              key={i}
              className="clickable"
              title={
                prettified
                  ? `${d.driver.name} — open fanout cone in Graph`
                  : 'Open fanout cone in Graph'
              }
              onClick={() =>
                store.openCone({
                  node: d.driver.id,
                  dir: 'fanout',
                  label: `${label} (fanout)`,
                })
              }
            >
              <td className="mono">
                {label}
                {!prettified && <span className="faint"> ·{d.port}</span>}
              </td>
              <td className="mono faint">{d.net_name}</td>
              <td className="num">
                <span className="depth-chip">{d.fanout}</span>
              </td>
              <td className="num">{d.endpoints}</td>
              <td>{d.control && <span className="pill en">control</span>}</td>
              <td>
                <SrcLink src={d.driver.src} />
              </td>
            </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
