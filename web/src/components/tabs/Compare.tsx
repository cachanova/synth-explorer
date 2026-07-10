import { diffCellsByType, totalCellDelta } from '../../lib/diff'
import {
  displayCellType,
  displayNodeName,
  shortNetName,
} from '../../lib/prettyType'
import { useStore } from '../../store'
import type { Snapshot } from '../../store'

export function Compare() {
  const store = useStore()
  const { snapshotA: a, snapshotB: b } = store

  return (
    <div>
      <div className="cmp-slots">
        <SlotCard slot="A" snap={a} onTake={() => void store.takeSnapshot('A')} />
        <SlotCard slot="B" snap={b} onTake={() => void store.takeSnapshot('B')} />
      </div>

      {!store.design && !a && !b && (
        <div className="empty-state">
          Synthesize a design, then snapshot it as A or B to compare two versions or
          synthesis modes.
        </div>
      )}

      {a && b ? (
        <DeltaTable a={a} b={b} />
      ) : (
        (a || b) && (
          <div className="faint">Take both snapshots to see the delta.</div>
        )
      )}
    </div>
  )
}

function SlotCard({
  slot,
  snap,
  onTake,
}: {
  slot: 'A' | 'B'
  snap: Snapshot | null
  onTake: () => void
}) {
  const store = useStore()
  return (
    <div className="cmp-slot">
      <h4>Snapshot {slot}</h4>
      {snap ? (
        <div style={{ fontSize: 12 }}>
          <div className="mono">
            {snap.top} · {snap.mode}
          </div>
          <div className="faint mono" style={{ fontSize: 10 }}>
            {snap.design_id.slice(0, 16)}
          </div>
          <div className="muted" style={{ marginTop: 4 }}>
            depth {snap.stats.max_depth} · {snap.stats.num_cells} cells ·{' '}
            {snap.stats.num_register_bits} reg bits
          </div>
        </div>
      ) : (
        <div className="faint" style={{ fontSize: 12 }}>
          Not set.
        </div>
      )}
      <button
        style={{ marginTop: 8 }}
        disabled={!store.design}
        onClick={onTake}
        title={store.design ? 'Snapshot current design' : 'Synthesize first'}
      >
        {snap ? 'Re-snapshot current' : 'Snapshot as ' + slot}
      </button>
    </div>
  )
}

function Delta({ value, lowerBetter = true }: { value: number; lowerBetter?: boolean }) {
  if (value === 0) return <span className="delta-zero">0</span>
  const improvement = lowerBetter ? value < 0 : value > 0
  const cls = improvement ? 'delta-down' : 'delta-up'
  const sign = value > 0 ? '+' : ''
  return (
    <span className={cls}>
      {sign}
      {value}
    </span>
  )
}

function DeltaTable({ a, b }: { a: Snapshot; b: Snapshot }) {
  const cd = diffCellsByType(a.stats.cells_by_type, b.stats.cells_by_type)
  const pathRows = Math.max(a.paths.length, b.paths.length)
  const foRows = Math.max(a.fanout.length, b.fanout.length)

  return (
    <div>
      <div className="section-title">Summary</div>
      <table className="grid">
        <thead>
          <tr>
            <th>Metric</th>
            <th className="num">A</th>
            <th className="num">B</th>
            <th className="num">Δ (B−A)</th>
          </tr>
        </thead>
        <tbody>
          <MetricRow
            label="Max depth"
            a={a.stats.max_depth}
            b={b.stats.max_depth}
          />
          <MetricRow label="Cells" a={a.stats.num_cells} b={b.stats.num_cells} />
          <MetricRow
            label="Register bits"
            a={a.stats.num_register_bits}
            b={b.stats.num_register_bits}
          />
          <MetricRow
            label="Register groups"
            a={a.stats.num_register_groups}
            b={b.stats.num_register_groups}
          />
        </tbody>
      </table>

      <div className="section-title">
        Cells by type ({totalCellDelta(cd)} cell delta)
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th>Type</th>
            <th className="num">A</th>
            <th className="num">B</th>
            <th className="num">Δ</th>
          </tr>
        </thead>
        <tbody>
          {[...cd.added, ...cd.removed, ...cd.changed].length === 0 ? (
            <tr>
              <td colSpan={4} className="faint">
                No cell-type differences.
              </td>
            </tr>
          ) : (
            [...cd.added, ...cd.removed, ...cd.changed].map((r) => (
              <tr key={r.type}>
                <td className="mono" title={r.type}>
                  {displayCellType(r.type)}{' '}
                  {r.a === 0 ? (
                    <span className="tag delta-add">new</span>
                  ) : r.b === 0 ? (
                    <span className="tag delta-rm">gone</span>
                  ) : null}
                </td>
                <td className="num">{r.a}</td>
                <td className="num">{r.b}</td>
                <td className="num">
                  <Delta value={r.delta} />
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      <div className="section-title">Top-10 path depths</div>
      <table className="grid">
        <thead>
          <tr>
            <th className="num">#</th>
            <th className="num">A depth</th>
            <th className="num">B depth</th>
            <th className="num">Δ</th>
            <th>B endpoint</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: Math.min(pathRows, 10) }, (_, i) => {
            const pa = a.paths[i]
            const pb = b.paths[i]
            const da = pa?.depth ?? 0
            const db = pb?.depth ?? 0
            return (
              <tr key={i}>
                <td className="num faint">{i + 1}</td>
                <td className="num">{pa ? da : '—'}</td>
                <td className="num">{pb ? db : '—'}</td>
                <td className="num">
                  {pa && pb ? <Delta value={db - da} /> : '—'}
                </td>
                <td className="mono faint">
                  {pb ? displayNodeName(pb.endpoint) : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <div className="section-title">Top-10 fanout</div>
      <table className="grid">
        <thead>
          <tr>
            <th className="num">#</th>
            <th className="num">A</th>
            <th className="num">B</th>
            <th className="num">Δ</th>
            <th>B net</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: Math.min(foRows, 10) }, (_, i) => {
            const fa = a.fanout[i]
            const fb = b.fanout[i]
            return (
              <tr key={i}>
                <td className="num faint">{i + 1}</td>
                <td className="num">{fa ? fa.fanout : '—'}</td>
                <td className="num">{fb ? fb.fanout : '—'}</td>
                <td className="num">
                  {fa && fb ? <Delta value={fb.fanout - fa.fanout} lowerBetter /> : '—'}
                </td>
                <td className="mono faint">
                  {fb ? shortNetName(fb.net_name) : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function MetricRow({ label, a, b }: { label: string; a: number; b: number }) {
  return (
    <tr>
      <td>{label}</td>
      <td className="num">{a}</td>
      <td className="num">{b}</td>
      <td className="num">
        <Delta value={b - a} />
      </td>
    </tr>
  )
}
