import { diffCellsByType, totalCellDelta } from '../../lib/diff'
import { STRUCTURAL_DEPTH_CAVEAT } from '../../lib/depth'
import { displayCellType, shortNetName } from '../../lib/prettyType'
import { useStore } from '../../store'
import type { Snapshot } from '../../store'
import type { TimingPath } from '../../types'
import { ModeName } from './Overview'
import {
  BitCohort,
  OutputAliasName,
  PathClassName,
  PathEndpointName,
} from './Paths'

export function Compare() {
  const store = useStore()
  const { snapshotA, snapshotB } = store

  return (
    <div>
      <div className="caveat" style={{ marginTop: 0, marginBottom: 10 }}>
        {STRUCTURAL_DEPTH_CAVEAT}
      </div>

      <div className="cmp-slots">
        <SlotCard
          slot="A"
          snap={snapshotA}
          onTake={() => void store.takeSnapshot('A')}
        />
        <SlotCard
          slot="B"
          snap={snapshotB}
          onTake={() => void store.takeSnapshot('B')}
        />
      </div>

      {!store.design && !snapshotA && !snapshotB && (
        <div className="empty-state">
          Synthesize a design, then snapshot it as A or B to compare two versions or
          synthesis modes.
        </div>
      )}

      {snapshotA && snapshotB ? (
        <DeltaTables snapshotA={snapshotA} snapshotB={snapshotB} />
      ) : (
        (snapshotA || snapshotB) && (
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
            {snap.top} · <ModeName mode={snap.mode} />
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
        type="button"
        style={{ marginTop: 8 }}
        disabled={!store.design}
        onClick={onTake}
        title={store.design ? 'Snapshot current design' : 'Synthesize first'}
      >
        {snap ? 'Re-snapshot current' : `Snapshot as ${slot}`}
      </button>
    </div>
  )
}

function Delta({ value, lowerBetter = true }: { value: number; lowerBetter?: boolean }) {
  if (value === 0) return <span className="delta-zero">0</span>
  const improvement = lowerBetter ? value < 0 : value > 0
  const className = improvement ? 'delta-down' : 'delta-up'
  const sign = value > 0 ? '+' : ''
  return (
    <span className={className}>
      {sign}
      {value}
    </span>
  )
}

function DeltaTables({
  snapshotA,
  snapshotB,
}: {
  snapshotA: Snapshot
  snapshotB: Snapshot
}) {
  const cellsA = readableCellCounts(snapshotA.stats.cells_by_type)
  const cellsB = readableCellCounts(snapshotB.stats.cells_by_type)
  const cellDelta = diffCellsByType(cellsA, cellsB)
  const cellRows = [...cellDelta.added, ...cellDelta.removed, ...cellDelta.changed]
  const pathRows = Math.max(snapshotA.paths.length, snapshotB.paths.length)
  const fanoutRows = Math.max(snapshotA.fanout.length, snapshotB.fanout.length)

  return (
    <div>
      <div className="section-title">Structural logic depth</div>
      <table className="grid">
        <thead>
          <tr>
            <th>Path class</th>
            <th className="num">A</th>
            <th className="num">B</th>
            <th className="num">Δ (B−A)</th>
          </tr>
        </thead>
        <tbody>
          <MetricRow
            label="Overall max"
            a={snapshotA.stats.max_depth}
            b={snapshotB.stats.max_depth}
          />
          <MetricRow
            label="Input → register"
            a={snapshotA.stats.depths.input_to_register}
            b={snapshotB.stats.depths.input_to_register}
          />
          <MetricRow
            label="Register → register"
            a={snapshotA.stats.depths.register_to_register}
            b={snapshotB.stats.depths.register_to_register}
          />
          <MetricRow
            label="Register → output"
            a={snapshotA.stats.depths.register_to_output}
            b={snapshotB.stats.depths.register_to_output}
          />
          <MetricRow
            label="Input → output"
            a={snapshotA.stats.depths.input_to_output}
            b={snapshotB.stats.depths.input_to_output}
          />
        </tbody>
      </table>

      <div className="section-title">Cell categories</div>
      <table className="grid">
        <thead>
          <tr>
            <th>Category</th>
            <th className="num">A</th>
            <th className="num">B</th>
            <th className="num">Δ (B−A)</th>
          </tr>
        </thead>
        <tbody>
          <MetricRow
            label="Logic"
            a={snapshotA.stats.cell_categories.logic}
            b={snapshotB.stats.cell_categories.logic}
          />
          <MetricRow
            label="Registers"
            a={snapshotA.stats.cell_categories.registers}
            b={snapshotB.stats.cell_categories.registers}
          />
          <MetricRow
            label="Carry / special"
            a={snapshotA.stats.cell_categories.carry_special}
            b={snapshotB.stats.cell_categories.carry_special}
          />
          <MetricRow
            label="Infrastructure"
            a={snapshotA.stats.cell_categories.infrastructure}
            b={snapshotB.stats.cell_categories.infrastructure}
          />
          <MetricRow
            label="Total cells"
            a={snapshotA.stats.num_cells}
            b={snapshotB.stats.num_cells}
          />
          <MetricRow
            label="Register bits"
            a={snapshotA.stats.num_register_bits}
            b={snapshotB.stats.num_register_bits}
          />
          <MetricRow
            label="Register groups"
            a={snapshotA.stats.num_register_groups}
            b={snapshotB.stats.num_register_groups}
          />
        </tbody>
      </table>

      <div className="section-title">
        Cells by readable type ({totalCellDelta(cellDelta)} changed cells)
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
          {cellRows.length === 0 ? (
            <tr>
              <td colSpan={4} className="faint">
                No cell-type differences.
              </td>
            </tr>
          ) : (
            cellRows.map((row) => (
              <tr key={row.type}>
                <td className="mono">
                  {row.type}{' '}
                  {row.a === 0 ? (
                    <span className="tag delta-add">new</span>
                  ) : row.b === 0 ? (
                    <span className="tag delta-rm">gone</span>
                  ) : null}
                </td>
                <td className="num">{row.a}</td>
                <td className="num">{row.b}</td>
                <td className="num">
                  <Delta value={row.delta} />
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      <div className="section-title">
        Top-10 structural path variants (ranked independently)
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th className="num">#</th>
            <th className="num">A depth</th>
            <th>A logical endpoint</th>
            <th className="num">B depth</th>
            <th>B logical endpoint</th>
            <th className="num">Δ</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: Math.min(pathRows, 10) }, (_, index) => {
            const pathA = snapshotA.paths[index]
            const pathB = snapshotB.paths[index]
            return (
              <tr key={index}>
                <td className="num faint">{index + 1}</td>
                <td className="num">{pathA ? pathA.depth : '—'}</td>
                <td>{pathA ? <PathEndpoint path={pathA} /> : '—'}</td>
                <td className="num">{pathB ? pathB.depth : '—'}</td>
                <td>{pathB ? <PathEndpoint path={pathB} /> : '—'}</td>
                <td className="num">
                  {pathA && pathB ? (
                    <Delta value={pathB.depth - pathA.depth} />
                  ) : (
                    '—'
                  )}
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
          {Array.from({ length: Math.min(fanoutRows, 10) }, (_, index) => {
            const fanoutA = snapshotA.fanout[index]
            const fanoutB = snapshotB.fanout[index]
            return (
              <tr key={index}>
                <td className="num faint">{index + 1}</td>
                <td className="num">{fanoutA ? fanoutA.fanout : '—'}</td>
                <td className="num">{fanoutB ? fanoutB.fanout : '—'}</td>
                <td className="num">
                  {fanoutA && fanoutB ? (
                    <Delta value={fanoutB.fanout - fanoutA.fanout} />
                  ) : (
                    '—'
                  )}
                </td>
                <td className="mono faint">
                  {fanoutB ? shortNetName(fanoutB.net_name) : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function PathEndpoint({ path }: { path: TimingPath }) {
  return (
    <div>
      <span className="tag">
        {path.endpoint_kind === 'register'
          ? 'Register'
          : path.endpoint_kind === 'output'
            ? 'Top-level output'
            : 'Boundary'}
      </span>{' '}
      <span className="mono"><PathEndpointName path={path} /></span>
      <div className="faint" style={{ fontSize: 10 }}>
        <PathClassName value={path.class} /> · bits <BitCohort bits={path.bits} />
      </div>
      {path.output_aliases.map((alias) => (
        <div key={alias.name} className="faint" style={{ fontSize: 10 }}>
          output <span className="mono"><OutputAliasName alias={alias} /></span>
        </div>
      ))}
    </div>
  )
}

function readableCellCounts(cellsByType: Record<string, number>): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const [rawType, count] of Object.entries(cellsByType)) {
    const label = displayCellType(rawType)
    counts[label] = (counts[label] ?? 0) + count
  }
  return counts
}

function MetricRow({
  label,
  a,
  b,
}: {
  label: string
  a: number | null
  b: number | null
}) {
  return (
    <tr>
      <td>{label}</td>
      <td className="num">{a ?? '—'}</td>
      <td className="num">{b ?? '—'}</td>
      <td className="num">
        {a === null || b === null ? '—' : <Delta value={b - a} />}
      </td>
    </tr>
  )
}
