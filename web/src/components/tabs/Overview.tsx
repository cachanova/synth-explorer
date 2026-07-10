import { displayCellType } from '../../lib/prettyType'
import { useStore } from '../../store'
import type { CellCategoryCounts } from '../../types'

const CAVEAT =
  'Depth is a structural synthesized-cell count—not post-place-and-route delay, slack, or timing closure.'

function displayMode(mode: string): string {
  switch (mode) {
    case 'rtl':
      return 'RTL structure'
    case 'gates':
      return 'Generic gates'
    case 'lut4':
      return 'Generic LUT4 metric'
    case 'lut6':
      return 'Generic LUT6 metric'
    case 'ice40':
      return 'iCE40 target'
    case 'ecp5':
      return 'ECP5 target'
    case 'xilinx':
      return 'Xilinx target'
    default:
      return mode
  }
}

export function ModeName({ mode }: { mode: string }) {
  return displayMode(mode)
}

export function Overview() {
  const store = useStore()
  const design = store.design
  if (!design) {
    return (
      <div className="empty-state">
        Paste Verilog on the left and hit <b>Synthesize</b> (Ctrl+Enter) to explore
        the synthesized logic.
      </div>
    )
  }

  const stats = design.stats
  const byType = aggregateCellTypes(stats.cells_by_type)
  const maxTypeCount = byType.length ? byType[0][1] : 1
  const categories = cellCategoryRows(stats.cell_categories)
  const maxCategoryCount = Math.max(1, ...categories.map((category) => category.count))

  return (
    <div>
      <div className="caveat" style={{ marginTop: 0, marginBottom: 10 }}>
        {CAVEAT}
      </div>

      <div className="cards">
        <Card k="Top" v={design.top} small />
        <Card k="Mode" v={displayMode(design.mode)} small />
        <Card k="Cells" v={stats.num_cells} />
        <Card k="Reg bits" v={stats.num_register_bits} />
        <Card k="Reg groups" v={stats.num_register_groups} />
        <Card k="Input bits" v={stats.num_inputs} />
        <Card k="Output bits" v={stats.num_outputs} />
      </div>

      <div className="section-title">Structural logic depth</div>
      <div className="cards">
        <Card k="Overall max" v={stats.max_depth} accent />
        <Card k="Input → register" v={depthValue(stats.depths.input_to_register)} />
        <Card
          k="Register → register"
          v={depthValue(stats.depths.register_to_register)}
        />
        <Card
          k="Register → output"
          v={depthValue(stats.depths.register_to_output)}
        />
        <Card k="Input → output" v={depthValue(stats.depths.input_to_output)} />
      </div>

      <div className="section-title">Cell categories</div>
      <div>
        {categories.map((category) => (
          <div className="histo-row" key={category.label}>
            <span className="lbl" title={category.description}>
              {category.label}
            </span>
            <span
              className="histo-bar"
              style={{
                width: `${Math.max(2, (category.count / maxCategoryCount) * 100)}%`,
              }}
            />
            <span className="cnt">{category.count}</span>
          </div>
        ))}
      </div>

      <div className="section-title">Cell types ({byType.length})</div>
      {byType.length === 0 ? (
        <div className="faint">No cells.</div>
      ) : (
        <div>
          {byType.map(([type, count]) => (
            <div className="histo-row" key={type}>
              <span className="lbl">{type}</span>
              <span
                className="histo-bar"
                style={{ width: `${Math.max(2, (count / maxTypeCount) * 100)}%` }}
              />
              <span className="cnt">{count}</span>
            </div>
          ))}
        </div>
      )}

      {design.warnings.length > 0 && (
        <>
          <div className="section-title">Warnings ({design.warnings.length})</div>
          <ul className="warn-list">
            {design.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </>
      )}

      <div className="section-title">Yosys diagnostics</div>
      <details className="collapsible">
        <summary>Show synthesis log ({design.log.split('\n').length} lines)</summary>
        <pre>{design.log}</pre>
      </details>
    </div>
  )
}

function aggregateCellTypes(
  cellsByType: Record<string, number>,
): Array<[string, number]> {
  const displayCounts = new Map<string, number>()
  for (const [rawType, count] of Object.entries(cellsByType)) {
    const label = displayCellType(rawType)
    displayCounts.set(label, (displayCounts.get(label) ?? 0) + count)
  }
  return [...displayCounts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )
}

function depthValue(depth: number | null): number | string {
  return depth ?? '—'
}

interface CellCategoryRow {
  label: string
  count: number
  description: string
}

function cellCategoryRows(categories: CellCategoryCounts): CellCategoryRow[] {
  return [
    {
      label: 'Logic',
      count: categories.logic,
      description: 'LUTs, gates, arithmetic, muxes, and other data-path logic',
    },
    {
      label: 'Registers',
      count: categories.registers,
      description: 'Sequential cells; counts cells rather than register bits',
    },
    {
      label: 'Carry / special',
      count: categories.carry_special,
      description: 'Vendor carry-chain and special logic primitives',
    },
    {
      label: 'Infrastructure',
      count: categories.infrastructure,
      description: 'IO, clock, and other zero-depth infrastructure buffers',
    },
  ]
}

function Card({
  k,
  v,
  accent,
  small,
}: {
  k: string
  v: string | number
  accent?: boolean
  small?: boolean
}) {
  return (
    <div className="card">
      <div className="k">{k}</div>
      <div
        className={`v${accent ? ' accent' : ''}`}
        style={small ? { fontSize: 15, fontFamily: 'var(--mono)' } : undefined}
      >
        {v}
      </div>
    </div>
  )
}
