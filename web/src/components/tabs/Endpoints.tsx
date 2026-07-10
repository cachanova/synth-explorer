import { useMemo, useState } from 'react'
import { getEndpoints } from '../../api'
import { fuzzyFilter } from '../../lib/fuzzy'
import { displayCellType } from '../../lib/prettyType'
import { useDesignData } from '../../lib/useDesignData'
import { useStore } from '../../store'
import type { EndpointBit, OutputEndpoint, RegisterEndpoint } from '../../types'
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
        (r) =>
          `${r.name} ${r.cell_type} ${displayCellType(r.cell_type)} ${r.clock ?? ''}`,
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

/** Bit with the deepest fanin cone — the one people actually care about. */
function worstBit(bits: EndpointBit[]): EndpointBit | undefined {
  if (bits.length === 0) return undefined
  return bits.reduce((a, b) => (b.depth > a.depth ? b : a), bits[0])
}

function bitLabel(name: string, width: number, bit: number): string {
  return width > 1 ? `${name}[${bit}]` : name
}

/** Expandable per-bit cone selector, shown under a multi-bit row. */
function BitsRow({
  name,
  width,
  bits,
  colSpan,
  onOpen,
}: {
  name: string
  width: number
  bits: EndpointBit[]
  colSpan: number
  onOpen: Opener
}) {
  return (
    <tr className="expanded">
      <td colSpan={colSpan}>
        <div className="chain">
          {bits.map((b) => (
            <button
              key={b.bit}
              className="hop"
              style={{ cursor: 'pointer' }}
              title={`Open fanin cone for ${bitLabel(name, width, b.bit)}`}
              onClick={() =>
                onOpen({
                  node: b.node_id,
                  dir: 'fanin',
                  label: `${bitLabel(name, width, b.bit)} (fanin)`,
                })
              }
            >
              <span className="t">[{b.bit}]</span>
              <span className="n">depth {b.depth}</span>
            </button>
          ))}
        </div>
      </td>
    </tr>
  )
}

function RegRow({ r, onOpen }: { r: RegisterEndpoint; onOpen: Opener }) {
  const [open, setOpen] = useState(false)
  const worst = worstBit(r.bits)
  return (
    <>
      <tr
        className={`clickable${open ? ' expanded' : ''}`}
        onClick={() =>
          worst &&
          onOpen({
            node: worst.node_id,
            dir: 'fanin',
            label: `${bitLabel(r.name, r.width, worst.bit)} (fanin)`,
          })
        }
        title="Open fanin cone of the worst-depth bit in Graph"
      >
        <td className="mono">
          {r.name}
          {r.width > 1 && (
            <a
              className="faint"
              style={{ marginLeft: 6, fontSize: 11 }}
              title="Choose a specific bit"
              onClick={(e) => {
                e.stopPropagation()
                setOpen((v) => !v)
              }}
            >
              bits {open ? '▾' : '▸'}
            </a>
          )}
        </td>
        <td className="num">{r.width}</td>
        <td>
          <span className="tag" title={r.cell_type}>
            {displayCellType(r.cell_type)}
          </span>
        </td>
        <td className="mono faint">{r.clock ?? '—'}</td>
        <td className="num">
          <span className="depth-chip">{r.worst_depth}</span>
        </td>
        <td>
          <SrcLink src={r.src} />
        </td>
      </tr>
      {open && (
        <BitsRow name={r.name} width={r.width} bits={r.bits} colSpan={6} onOpen={onOpen} />
      )}
    </>
  )
}

function OutRow({ o, onOpen }: { o: OutputEndpoint; onOpen: Opener }) {
  const [open, setOpen] = useState(false)
  const worst = worstBit(o.bits)
  return (
    <>
      <tr
        className={`clickable${open ? ' expanded' : ''}`}
        onClick={() =>
          worst &&
          onOpen({
            node: worst.node_id,
            dir: 'fanin',
            label: `${bitLabel(o.name, o.width, worst.bit)} (fanin)`,
          })
        }
        title="Open fanin cone of the worst-depth bit in Graph"
      >
        <td className="mono">
          {o.name}
          {o.width > 1 && (
            <a
              className="faint"
              style={{ marginLeft: 6, fontSize: 11 }}
              title="Choose a specific bit"
              onClick={(e) => {
                e.stopPropagation()
                setOpen((v) => !v)
              }}
            >
              bits {open ? '▾' : '▸'}
            </a>
          )}
        </td>
        <td className="num">{o.width}</td>
        <td className="num">
          <span className="depth-chip">{o.worst_depth}</span>
        </td>
      </tr>
      {open && (
        <BitsRow name={o.name} width={o.width} bits={o.bits} colSpan={3} onOpen={onOpen} />
      )}
    </>
  )
}
