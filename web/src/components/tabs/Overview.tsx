import { useStore } from '../../store'

const CAVEAT =
  'Structural analysis of the synthesized netlist — not post-place-and-route timing.'

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

  const s = design.stats
  const byType = Object.entries(s.cells_by_type).sort((a, b) => b[1] - a[1])
  const max = byType.length ? byType[0][1] : 1

  return (
    <div>
      <div className="cards">
        <Card k="Top" v={design.top} small />
        <Card k="Mode" v={design.mode} small />
        <Card k="Cells" v={s.num_cells} />
        <Card k="Reg bits" v={s.num_register_bits} />
        <Card k="Reg groups" v={s.num_register_groups} />
        <Card k="Max depth" v={s.max_depth} accent />
        <Card k="Inputs" v={s.num_inputs} />
        <Card k="Outputs" v={s.num_outputs} />
      </div>

      <div className="section-title">Cell types ({byType.length})</div>
      {byType.length === 0 ? (
        <div className="faint">No cells.</div>
      ) : (
        <div>
          {byType.map(([type, count]) => (
            <div className="histo-row" key={type}>
              <span className="lbl" title={type}>
                {type}
              </span>
              <span
                className="histo-bar"
                style={{ width: `${Math.max(2, (count / max) * 100)}%` }}
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
            {design.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </>
      )}

      <div className="section-title">yosys log</div>
      <details className="collapsible">
        <summary>Show log ({design.log.split('\n').length} lines)</summary>
        <pre>{design.log}</pre>
      </details>

      <div className="caveat">{CAVEAT}</div>
    </div>
  )
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
