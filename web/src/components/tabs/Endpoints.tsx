import { useMemo, useState } from 'react'
import { getEndpoints } from '../../api'
import { fuzzyFilter } from '../../lib/fuzzy'
import {
  displayCellType,
  isHiddenName,
  shortNetName,
} from '../../lib/prettyType'
import { useDesignData } from '../../lib/useDesignData'
import { useStore } from '../../store'
import type {
  EndpointBit,
  OutputAlias,
  OutputEndpoint,
  RegisterEndpoint,
} from '../../types'
import { SrcLink } from '../SrcLink'

type EndpointFilter = 'all' | 'register' | 'registered_output' | 'output'

type LogicalEndpoint =
  | { kind: 'register'; endpoint: RegisterEndpoint }
  | { kind: 'output'; endpoint: OutputEndpoint }

export function Endpoints() {
  const store = useStore()
  const id = store.design?.design_id ?? null
  const { data, loading, error } = useDesignData(id, getEndpoints)
  const [filter, setFilter] = useState('')
  const [kindFilter, setKindFilter] = useState<EndpointFilter>('all')

  const rows = useMemo(() => {
    const all: LogicalEndpoint[] = [
      ...(data?.registers ?? []).map(
        (endpoint): LogicalEndpoint => ({ kind: 'register', endpoint }),
      ),
      ...(data?.outputs ?? []).map(
        (endpoint): LogicalEndpoint => ({ kind: 'output', endpoint }),
      ),
    ]
    const byKind = all.filter((row) => {
      if (kindFilter === 'all') return true
      if (kindFilter === 'output') return row.kind === 'output'
      if (row.kind !== 'register') return false
      if (kindFilter === 'registered_output') {
        return row.endpoint.output_aliases.length > 0
      }
      return true
    })
    const sorted = byKind.sort(
      (a, b) =>
        b.endpoint.worst_depth - a.endpoint.worst_depth ||
        a.endpoint.name.localeCompare(b.endpoint.name),
    )
    return fuzzyFilter(sorted, filter, endpointSearchText)
  }, [data, filter, kindFilter])

  if (!store.design) return <div className="empty-state">No design yet.</div>
  if (loading && !data) return <div className="empty-state">Loading endpoints…</div>
  if (error) return <div className="empty-state">Failed to load endpoints: {error}</div>

  const total = (data?.registers.length ?? 0) + (data?.outputs.length ?? 0)

  return (
    <div>
      <div className="caveat" style={{ marginTop: 0, marginBottom: 10 }}>
        Logic depth is a structural synthesized-cell count, not routed timing.
        Registered top-level outputs are aliases of their driving register and are
        counted once.
      </div>

      <div className="row" style={{ alignItems: 'stretch', marginBottom: 8 }}>
        <input
          className="filter-input"
          style={{ marginBottom: 0 }}
          placeholder="Filter logical endpoints…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <select
          aria-label="Endpoint kind"
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value as EndpointFilter)}
        >
          <option value="all">All kinds</option>
          <option value="register">Registers</option>
          <option value="registered_output">Registered outputs</option>
          <option value="output">Combinational outputs</option>
        </select>
      </div>

      <div className="section-title">
        Logical endpoints ({rows.length} / {total})
      </div>
      {rows.length === 0 ? (
        <div className="faint">No matching logical endpoints.</div>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Endpoint</th>
              <th>Kind</th>
              <th className="num">Bits</th>
              <th>Implementation</th>
              <th className="num">Logic depth</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) =>
              row.kind === 'register' ? (
                <RegisterRow
                  key={`register:${row.endpoint.name}`}
                  endpoint={row.endpoint}
                  onOpen={store.openCone}
                />
              ) : (
                <OutputRow
                  key={`output:${row.endpoint.name}`}
                  endpoint={row.endpoint}
                  onOpen={store.openCone}
                />
              ),
            )}
          </tbody>
        </table>
      )}
    </div>
  )
}

type Opener = ReturnType<typeof useStore>['openCone']

function endpointSearchText(row: LogicalEndpoint): string {
  if (row.kind === 'output') return `${row.endpoint.name} combinational output`
  const endpoint = row.endpoint
  return [
    endpoint.name,
    endpoint.cell_type,
    displayCellType(endpoint.cell_type),
    endpoint.clock ?? '',
    endpoint.output_aliases.map((alias) => alias.name).join(' '),
    endpoint.output_aliases.length > 0 ? 'registered output' : 'register',
  ].join(' ')
}

/** Bit with the deepest fanin cone — the default graph target for a group. */
function worstBit(bits: EndpointBit[]): EndpointBit | undefined {
  if (bits.length === 0) return undefined
  return bits.reduce((a, b) => (b.depth > a.depth ? b : a), bits[0])
}

function bitLabel(name: string, width: number, bit: number): string {
  return width > 1 ? `${name}[${bit}]` : name
}

function registerDisplayName(endpoint: RegisterEndpoint): string {
  return isHiddenName(endpoint.name)
    ? displayCellType(endpoint.cell_type)
    : endpoint.name
}

function formatBitRanges(bits: number[]): string {
  const sorted = [...new Set(bits)].sort((a, b) => a - b)
  if (sorted.length === 0) return ''
  const ranges: Array<[number, number]> = []
  let start = sorted[0]
  let end = start
  for (const bit of sorted.slice(1)) {
    if (bit === end + 1) {
      end = bit
      continue
    }
    ranges.push([start, end])
    start = bit
    end = bit
  }
  ranges.push([start, end])
  return ranges
    .reverse()
    .map(([lo, hi]) => (lo === hi ? `[${lo}]` : `[${hi}:${lo}]`))
    .join(', ')
}

function aliasLabel(alias: OutputAlias): string {
  const outputBits = alias.bits.map((bit) => bit.output_bit)
  if (alias.width === 1 && outputBits.length === 1 && outputBits[0] === 0) {
    return alias.name
  }
  return `${alias.name}${formatBitRanges(outputBits)}`
}

function aliasesForBit(aliases: OutputAlias[], registerBit: number): string[] {
  return aliases.flatMap((alias) =>
    alias.bits
      .filter((bit) => bit.register_bit === registerBit)
      .map((bit) => bitLabel(alias.name, alias.width, bit.output_bit)),
  )
}

function ExpandButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      title="Inspect endpoint bits"
      aria-label={open ? 'Hide endpoint bits' : 'Show endpoint bits'}
      aria-expanded={open}
      onClick={(event) => {
        event.stopPropagation()
        onToggle()
      }}
      style={{
        marginLeft: 6,
        padding: '0 4px',
        border: 0,
        background: 'transparent',
        color: 'var(--text-faint)',
      }}
    >
      bits {open ? '▾' : '▸'}
    </button>
  )
}

function BitsRow({
  name,
  width,
  bits,
  aliases = [],
  depthLabel = 'D-cone depth',
  openTitle = 'Open D-input fanin for',
  colSpan,
  onOpen,
}: {
  name: string
  width: number
  bits: EndpointBit[]
  aliases?: OutputAlias[]
  depthLabel?: string
  openTitle?: string
  colSpan: number
  onOpen: Opener
}) {
  return (
    <tr className="expanded">
      <td colSpan={colSpan}>
        <div className="chain">
          {[...bits].sort((a, b) => b.bit - a.bit).map((bit) => {
            const outputNames = aliasesForBit(aliases, bit.bit)
            return (
              <button
                type="button"
                key={bit.bit}
                className="hop"
                title={`${openTitle} ${bitLabel(name, width, bit.bit)}`}
                onClick={() =>
                  onOpen({
                    node: bit.node_id,
                    dir: 'fanin',
                    label: `${bitLabel(name, width, bit.bit)} (fanin)`,
                  })
                }
              >
                <span className="t">{bitLabel(name, width, bit.bit)}</span>
                <span className="n">{depthLabel} {bit.depth}</span>
                {outputNames.length > 0 && (
                  <span className="n">output {outputNames.join(', ')}</span>
                )}
              </button>
            )
          })}
        </div>
      </td>
    </tr>
  )
}

function RegisterRow({
  endpoint,
  onOpen,
}: {
  endpoint: RegisterEndpoint
  onOpen: Opener
}) {
  const [open, setOpen] = useState(false)
  const worst = worstBit(endpoint.bits)
  const aliases = endpoint.output_aliases
  const name = registerDisplayName(endpoint)
  return (
    <>
      <tr
        className={`clickable${open ? ' expanded' : ''}`}
        onClick={() =>
          worst &&
          onOpen({
            node: worst.node_id,
            dir: 'fanin',
            label: `${bitLabel(name, endpoint.width, worst.bit)} (fanin)`,
          })
        }
        title="Open the D-input fanin cone of the deepest register bit"
      >
        <td>
          <span className="mono">{name}</span>
          <ExpandButton open={open} onToggle={() => setOpen((value) => !value)} />
          {aliases.map((alias) => (
            <div key={alias.name} className="faint" style={{ fontSize: 10 }}>
              top-level output <span className="mono">{aliasLabel(alias)}</span>
            </div>
          ))}
        </td>
        <td>
          <span className="tag">Register</span>{' '}
          {aliases.length > 0 && <span className="tag">Registered output</span>}
        </td>
        <td className="num">{endpoint.width}</td>
        <td>
          <span className="tag">{displayCellType(endpoint.cell_type)}</span>
          <div className="mono faint" style={{ fontSize: 10, marginTop: 2 }}>
            clk {endpoint.clock ? shortNetName(endpoint.clock) : 'unknown'}
          </div>
        </td>
        <td className="num" title="Worst structural depth into the register D input">
          <span className="depth-chip">{endpoint.worst_depth}</span>
        </td>
        <td>
          <SrcLink src={endpoint.src} />
        </td>
      </tr>
      {open && (
        <BitsRow
          name={name}
          width={endpoint.width}
          bits={endpoint.bits}
          aliases={aliases}
          colSpan={6}
          onOpen={onOpen}
        />
      )}
    </>
  )
}

function OutputRow({
  endpoint,
  onOpen,
}: {
  endpoint: OutputEndpoint
  onOpen: Opener
}) {
  const [open, setOpen] = useState(false)
  const worst = worstBit(endpoint.bits)
  const reportedBits = endpoint.bits.length
  return (
    <>
      <tr
        className={`clickable${open ? ' expanded' : ''}`}
        onClick={() =>
          worst &&
          onOpen({
            node: worst.node_id,
            dir: 'fanin',
            label: `${bitLabel(endpoint.name, endpoint.width, worst.bit)} (fanin)`,
          })
        }
        title="Open the fanin cone of the deepest combinational output bit"
      >
        <td>
          <span className="mono">{endpoint.name}</span>
          <ExpandButton open={open} onToggle={() => setOpen((value) => !value)} />
        </td>
        <td>
          <span className="tag">Combinational output</span>
        </td>
        <td
          className="num"
          title={
            reportedBits === endpoint.width
              ? undefined
              : `${reportedBits} combinational bits of ${endpoint.width}; other bits are registered-output aliases`
          }
        >
          {reportedBits === endpoint.width ? endpoint.width : `${reportedBits} / ${endpoint.width}`}
        </td>
        <td className="faint">Top-level output</td>
        <td className="num" title="Worst structural depth into this top-level output">
          <span className="depth-chip">{endpoint.worst_depth}</span>
        </td>
        <td>—</td>
      </tr>
      {open && (
        <BitsRow
          name={endpoint.name}
          width={endpoint.width}
          bits={endpoint.bits}
          depthLabel="Output-cone depth"
          openTitle="Open output fanin for"
          colSpan={6}
          onOpen={onOpen}
        />
      )}
    </>
  )
}
