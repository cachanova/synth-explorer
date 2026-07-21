import { displayCellType } from '../../lib/prettyType'
import { formatSynthesisDelay } from '../../lib/synthesisSettings'
import { fmaxMhz } from '../../lib/timing'
import type { CellCategoryCounts, VivadoTimingReport } from '../../types'
import { shallowEqual, useStore } from '../../useStore'
import { TimingModel } from '../TimingModel'
import { Card } from '../Card'

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
      return 'Xilinx'
    default:
      return mode
  }
}

export function PlatformName({ mode }: { mode: string }) {
  return displayMode(mode)
}

export function Overview() {
  const store = useStore(
    ({ design, synthTool, autoSynthesize, autoSynthesisDelayMs }) => ({
      design,
      synthTool,
      autoSynthesize,
      autoSynthesisDelayMs,
    }),
    shallowEqual,
  )
  const { design } = store
  if (!design) {
    return (
      <div className="empty-state">
        {store.synthTool === 'vivado'
          ? 'Enter a top module or entity, then run Vivado from the toolbar.'
          : (
              <>
                Paste or edit Verilog or VHDL on the left.{' '}
                {store.autoSynthesize
                  ? `Synth Explorer automatically refreshes the synthesized logic after ${formatSynthesisDelay(store.autoSynthesisDelayMs)} without input.`
                  : 'Select Synthesize when you are ready to refresh the analysis.'}
              </>
            )}
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
      {design.memories_abstracted && (
        <div className="caveat" style={{ marginTop: 0, marginBottom: 10 }}>
          Memories kept abstract — flattening them to gates exceeded sandbox
          limits.
        </div>
      )}

      <div className="cards">
        <Card k="Top" v={design.top} small />
        <Card k="Tool" v={design.tool === 'vivado' ? 'Vivado' : 'Yosys'} small />
        {design.target && <Card k="Target" v={design.target} small />}
        <Card k="Platform" v={displayMode(design.mode)} small />
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

      {design.tool === 'vivado' ? (
        <VivadoTiming timing={design.vivado_timing} />
      ) : design.mode !== 'rtl' && (
        /* Every non-RTL Yosys design gets the timing controls. Generic
           gates/LUT modes need the profile selector even while auto deliberately
           withholds all timing figures. */
        <TimingModel
          key={design.design_id}
          designId={design.design_id}
          designMode={design.mode}
          resolvedProfile={design.delay_profile}
          fallbackDelayNs={stats.estimated_delay_ns ?? null}
          fallbackBreakdown={stats.estimated_delay_breakdown}
        />
      )}

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

      <div className="section-title">
        {design.tool === 'vivado' ? 'Synthesis diagnostics' : 'Yosys diagnostics'}
      </div>
      <details className="collapsible">
        <summary>Show synthesis log ({design.log.split('\n').length} lines)</summary>
        <pre>{design.log}</pre>
      </details>
    </div>
  )
}

function VivadoTiming({ timing }: { timing?: VivadoTimingReport }) {
  return (
    <>
      <div className="section-title">Vivado timing report</div>
      {timing ? (
        <>
          <div className="cards">
            <Card
              k="Data path delay"
              v={`${timing.data_path_delay_ns.toFixed(2)} ns`}
              accent
            />
            <Card
              k="Path Fmax"
              v={timing.data_path_delay_ns > 0
                ? `${fmaxMhz(timing.data_path_delay_ns).toFixed(0)} MHz`
                : '—'}
            />
            <Card k="Logic delay" v={timing.logic_delay_ns != null ? `${timing.logic_delay_ns.toFixed(2)} ns` : '—'} />
            <Card k="Route delay" v={timing.net_delay_ns != null ? `${timing.net_delay_ns.toFixed(2)} ns` : '—'} />
            <Card k="Slack" v={timing.slack_ns != null ? `${timing.slack_ns.toFixed(2)} ns` : '—'} />
            <Card k="Requirement" v={timing.requirement_ns != null ? `${timing.requirement_ns.toFixed(2)} ns` : '—'} />
            <Card k="Logic levels" v={timing.logic_levels ?? '—'} />
          </div>
          <div className="caveat" style={{ marginTop: 8 }}>
            From Vivado <code>report_timing -max_paths 1 -delay_type max</code> after synthesis. This is still pre-place-and-route unless the local flow is extended with implementation constraints.
          </div>
          <dl className="timing-path-summary">
            <div>
              <dt>Startpoint</dt>
              <dd>{timing.startpoint}</dd>
            </div>
            <div>
              <dt>Endpoint</dt>
              <dd>{timing.endpoint}</dd>
            </div>
            <div>
              <dt>Path group</dt>
              <dd>{timing.path_group ?? '—'}</dd>
            </div>
            <div>
              <dt>Corner</dt>
              <dd>{[timing.corner, timing.delay_type].filter(Boolean).join(' / ') || '—'}</dd>
            </div>
          </dl>
          <details className="collapsible">
            <summary>Show Vivado timing report ({timing.report.split('\n').length} lines)</summary>
            <pre>{timing.report}</pre>
          </details>
        </>
      ) : (
        <div className="empty-state">
          Vivado did not report a max timing path for this synthesized netlist.
        </div>
      )}
    </>
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
