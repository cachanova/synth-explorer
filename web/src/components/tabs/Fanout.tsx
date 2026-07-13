import { useMemo, useState } from 'react'
import { getFanout } from '../../api'
import { fuzzyFilter } from '../../lib/fuzzy'
import { naturalCompare } from '../../lib/naturalCompare'
import { fanoutDriverLabel, shortNetName } from '../../lib/prettyType'
import { useDesignData } from '../../lib/useDesignData'
import { useStore } from '../../store'
import { SrcLink } from '../SrcLink'
import { StaleResultsChip } from '../StaleResultsChip'

export function Fanout() {
  const store = useStore()
  const id = store.design?.design_id ?? null
  const { data, loading, error } = useDesignData(id, (i) => getFanout(i, 50))
  const [filter, setFilter] = useState('')

  const drivers = useMemo(() => {
    // Equal-fanout rows sort by their displayed label in natural order
    // ("d_in[2]" before "d_in[10]").
    const sorted = [...(data?.drivers ?? [])].sort(
      (a, b) =>
        b.fanout - a.fanout ||
        naturalCompare(
          fanoutDriverLabel(a.driver, a.net_name),
          fanoutDriverLabel(b.driver, b.net_name),
        ),
    )
    return fuzzyFilter(
      sorted,
      filter,
      (d) => `${d.driver.name} ${d.net_name} ${d.port}`,
    )
  }, [data, filter])

  if (!store.design) return <div className="empty-state">No design yet.</div>
  if (loading && !data) return <div className="empty-state">Loading fanout…</div>
  if (error) return <div className="empty-state">Failed to load fanout: {error}</div>
  if (!data || data.drivers.length === 0)
    return <div className="empty-state">No fanout data.</div>

  return (
    <div>
      <StaleResultsChip state={store.analysisState} />
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
              title="Open fanout cone in Schematic"
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
              <td className="mono faint">{shortNetName(d.net_name)}</td>
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
