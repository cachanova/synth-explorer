import { useEffect, useMemo, useState } from 'react'
import { getEndpoints } from '../../api'
import { formatBitRanges } from '../../lib/bitRanges'
import { fuzzyFilter } from '../../lib/fuzzy'
import { boundaryFaninRequest } from '../../lib/endpointCone'
import {
  displayCellType,
  isHiddenName,
  shortNetName,
} from '../../lib/prettyType'
import { useDesignData } from '../../lib/useDesignData'
import { symbolKind } from '../../lib/symbols'
import type { Store } from '../../store'
import type {
  BoundaryEndpoint,
  EndpointBit,
  OutputAlias,
  OutputEndpoint,
  RegisterEndpoint,
} from '../../types'
import { shallowEqual, useStore } from '../../useStore'
import { SrcLink } from '../SrcLink'
import { StaleResultsChip } from '../StaleResultsChip'
import { VirtualTable } from '../VirtualTable'

type EndpointFilter = 'all' | 'register' | 'registered_output' | 'output' | 'boundary'

type LogicalEndpoint =
  | { kind: 'register'; endpoint: RegisterEndpoint }
  | { kind: 'output'; endpoint: OutputEndpoint }
  | { kind: 'boundary'; endpoint: BoundaryEndpoint }

const BIT_PAGE_SIZE = 64

export function Endpoints() {
  const store = useStore(
    ({ design, analysisState, openCone }) => ({ design, analysisState, openCone }),
    shallowEqual,
  )
  const id = store.design?.design_id ?? null
  const { data, loading, error } = useDesignData(id, getEndpoints)
  const [filter, setFilter] = useState('')
  const [kindFilter, setKindFilter] = useState<EndpointFilter>('all')
  const [openRows, setOpenRows] = useState<Set<string>>(() => new Set())
  const [bitPages, setBitPages] = useState<Map<string, number>>(() => new Map())

  useEffect(() => {
    setOpenRows(new Set())
    setBitPages(new Map())
  }, [id])

  const rows = useMemo(() => {
    const all: LogicalEndpoint[] = [
      ...(data?.registers ?? []).map(
        (endpoint): LogicalEndpoint => ({ kind: 'register', endpoint }),
      ),
      ...(data?.outputs ?? []).map(
        (endpoint): LogicalEndpoint => ({ kind: 'output', endpoint }),
      ),
      ...(data?.boundaries ?? []).map(
        (endpoint): LogicalEndpoint => ({ kind: 'boundary', endpoint }),
      ),
    ]
    const byKind = all.filter((row) => {
      if (kindFilter === 'all') return true
      if (kindFilter === 'output') return row.kind === 'output'
      if (kindFilter === 'boundary') return row.kind === 'boundary'
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

  const total =
    (data?.registers.length ?? 0) +
    (data?.outputs.length ?? 0) +
    (data?.boundaries.length ?? 0)
  const toggleRow = (key: string) => {
    setOpenRows((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const setBitPage = (key: string, page: number) => {
    setBitPages((current) => {
      const next = new Map(current)
      next.set(key, page)
      return next
    })
  }

  return (
    <div className="bounded-results-tab">
      <StaleResultsChip state={store.analysisState} />
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
          <option value="boundary">Boundary inputs</option>
        </select>
      </div>

      <div className="section-title">
        Logical endpoints ({rows.length} matched / {total})
      </div>
      {data?.boundaries_truncated && (
        <div className="msg">
          Boundary inputs truncated to the analysis safety limit; refine the design to inspect omitted pins.
        </div>
      )}
      {rows.length === 0 ? (
        <div className="faint">No matching logical endpoints.</div>
      ) : (
        <VirtualTable
          rowCount={rows.length}
          columnWidths={['28%', '15%', '8%', '20%', '10%', '19%']}
          getRowKey={(index) => {
            const row = rows[index]
            return row.kind === 'boundary'
              ? `${row.kind}:${row.endpoint.node_id}:${row.endpoint.port}`
              : `${row.kind}:${row.endpoint.name}`
          }}
          resetKey={`${filter}:${kindFilter}`}
          header={
            <>
              <th role="columnheader">Endpoint</th>
              <th role="columnheader">Kind</th>
              <th role="columnheader" className="num">Bits</th>
              <th role="columnheader">Implementation</th>
              <th role="columnheader" className="num">Logic depth</th>
              <th role="columnheader">Source</th>
            </>
          }
          renderRow={(index) => {
            const row = rows[index]
            const key = row.kind === 'boundary'
              ? `${row.kind}:${row.endpoint.node_id}:${row.endpoint.port}`
              : `${row.kind}:${row.endpoint.name}`
            return (
              row.kind === 'register' ? (
                <RegisterRow
                  endpoint={row.endpoint}
                  onOpen={store.openCone}
                  open={openRows.has(key)}
                  onToggle={() => toggleRow(key)}
                  bitPage={bitPages.get(key) ?? 0}
                  onBitPageChange={(page) => setBitPage(key, page)}
                />
              ) : row.kind === 'output' ? (
                <OutputRow
                  endpoint={row.endpoint}
                  onOpen={store.openCone}
                  open={openRows.has(key)}
                  onToggle={() => toggleRow(key)}
                  bitPage={bitPages.get(key) ?? 0}
                  onBitPageChange={(page) => setBitPage(key, page)}
                />
              ) : (
                <BoundaryRow
                  endpoint={row.endpoint}
                  onOpen={store.openCone}
                  open={openRows.has(key)}
                  onToggle={() => toggleRow(key)}
                  bitPage={bitPages.get(key) ?? 0}
                  onBitPageChange={(page) => setBitPage(key, page)}
                />
              )
            )
          }}
        />
      )}
    </div>
  )
}

type Opener = Store['openCone']

function endpointSearchText(row: LogicalEndpoint): string {
  if (row.kind === 'output') return `${row.endpoint.name} combinational output`
  if (row.kind === 'boundary') {
    return `${row.endpoint.name} ${row.endpoint.port} ${row.endpoint.cell_type} boundary memory input`
  }
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

function boundaryDisplayName(endpoint: BoundaryEndpoint): string {
  const cellName = isHiddenName(endpoint.name)
    ? displayCellType(endpoint.cell_type)
    : endpoint.name
  return `${cellName}.${endpoint.port}`
}

function boundaryKind(endpoint: BoundaryEndpoint): string {
  return symbolKind({
    id: endpoint.node_id,
    kind: 'cell',
    name: endpoint.name,
    cell_type: endpoint.cell_type,
    seq: true,
    register: false,
  }) === 'memory'
    ? 'Memory input'
    : 'Boundary input'
}

function bitLabel(name: string, width: number, bit: number): string {
  return width > 1 ? `${name}[${bit}]` : name
}

function registerDisplayName(endpoint: RegisterEndpoint): string {
  return isHiddenName(endpoint.name)
    ? displayCellType(endpoint.cell_type)
    : endpoint.name
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
  page,
  onPageChange,
  rootPort,
}: {
  name: string
  width: number
  bits: EndpointBit[]
  aliases?: OutputAlias[]
  depthLabel?: string
  openTitle?: string
  colSpan: number
  onOpen: Opener
  page: number
  onPageChange: (page: number) => void
  rootPort?: string
}) {
  const sortedBits = useMemo(
    () => [...bits].sort((a, b) => b.bit - a.bit),
    [bits],
  )
  const lastPage = Math.max(0, Math.ceil(sortedBits.length / BIT_PAGE_SIZE) - 1)
  const currentPage = Math.min(page, lastPage)
  const start = currentPage * BIT_PAGE_SIZE
  const visibleBits = sortedBits.slice(start, start + BIT_PAGE_SIZE)
  const remaining = Math.max(0, sortedBits.length - start - visibleBits.length)

  return (
    <tr className="expanded" role="row">
      <td colSpan={colSpan} role="cell">
        <div className="chain">
          {visibleBits.map((bit) => {
            const outputNames = aliasesForBit(aliases, bit.bit)
            return (
              <button
                type="button"
                key={bit.bit}
                className="hop"
                title={`${openTitle} ${bitLabel(name, width, bit.bit)}`}
                onClick={() =>
                  onOpen({
                    ...(rootPort == null
                      ? {
                          node: bit.node_id,
                          dir: 'fanin' as const,
                          label: `${bitLabel(name, width, bit.bit)} (fanin)`,
                        }
                      : boundaryFaninRequest(
                          bit.node_id,
                          `${bitLabel(name, width, bit.bit)} (fanin)`,
                          rootPort,
                          bit.bit,
                        )),
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
          {currentPage > 0 && (
            <button
              type="button"
              className="hop pagination-button"
              onClick={() => onPageChange(currentPage - 1)}
            >
              <span className="t">Previous {Math.min(BIT_PAGE_SIZE, start)} bits</span>
            </button>
          )}
          {remaining > 0 && (
            <button
              type="button"
              className="hop pagination-button"
              onClick={() => onPageChange(currentPage + 1)}
            >
              <span className="t">
                Next {Math.min(BIT_PAGE_SIZE, remaining)} bits
              </span>
              <span className="n">{remaining} remaining</span>
            </button>
          )}
        </div>
      </td>
    </tr>
  )
}

function RegisterRow({
  endpoint,
  onOpen,
  open,
  onToggle,
  bitPage,
  onBitPageChange,
}: {
  endpoint: RegisterEndpoint
  onOpen: Opener
  open: boolean
  onToggle: () => void
  bitPage: number
  onBitPageChange: (page: number) => void
}) {
  const aliases = endpoint.output_aliases
  const name = registerDisplayName(endpoint)
  return (
    <>
      <tr
        className={`clickable${open ? ' expanded' : ''}`}
        role="row"
        onClick={() =>
          onOpen({
            nodes: endpoint.bits.map((bit) => bit.node_id),
            dir: 'fanin',
            highlight: endpoint.bits.map((bit) => bit.node_id),
            label: `${name} (fanin)`,
          })
        }
        title="Open the D-input fanin cone of the whole register"
      >
        <td role="cell">
          <span className="mono">{name}</span>
          <ExpandButton open={open} onToggle={onToggle} />
          {aliases.map((alias) => (
            <div key={alias.name} className="faint" style={{ fontSize: 10 }}>
              top-level output <span className="mono">{aliasLabel(alias)}</span>
            </div>
          ))}
        </td>
        <td role="cell">
          <span className="tag">Register</span>{' '}
          {aliases.length > 0 && <span className="tag">Registered output</span>}
        </td>
        <td role="cell" className="num">{endpoint.width}</td>
        <td role="cell">
          <span className="tag">{displayCellType(endpoint.cell_type)}</span>
          <div className="mono faint" style={{ fontSize: 10, marginTop: 2 }}>
            clk {endpoint.clock ? shortNetName(endpoint.clock) : 'unknown'}
          </div>
        </td>
        <td role="cell" className="num" title="Worst structural depth into the register D input">
          <span className="depth-chip">{endpoint.worst_depth}</span>
        </td>
        <td role="cell">
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
          page={bitPage}
          onPageChange={onBitPageChange}
        />
      )}
    </>
  )
}

function OutputRow({
  endpoint,
  onOpen,
  open,
  onToggle,
  bitPage,
  onBitPageChange,
}: {
  endpoint: OutputEndpoint
  onOpen: Opener
  open: boolean
  onToggle: () => void
  bitPage: number
  onBitPageChange: (page: number) => void
}) {
  const reportedBits = endpoint.bits.length
  return (
    <>
      <tr
        className={`clickable${open ? ' expanded' : ''}`}
        role="row"
        onClick={() =>
          endpoint.bits.length > 0 &&
          onOpen({
            nodes: endpoint.bits.map((bit) => bit.node_id),
            dir: 'fanin',
            highlight: endpoint.bits.map((bit) => bit.node_id),
            label: `${endpoint.name} (fanin)`,
          })
        }
        title="Open the fanin cone of the whole combinational output"
      >
        <td role="cell">
          <span className="mono">{endpoint.name}</span>
          <ExpandButton open={open} onToggle={onToggle} />
        </td>
        <td role="cell">
          <span className="tag">Combinational output</span>
        </td>
        <td
          role="cell"
          className="num"
          title={
            reportedBits === endpoint.width
              ? undefined
              : `${reportedBits} combinational bits of ${endpoint.width}; other bits are registered-output aliases`
          }
        >
          {reportedBits === endpoint.width ? endpoint.width : `${reportedBits} / ${endpoint.width}`}
        </td>
        <td role="cell" className="faint">Top-level output</td>
        <td role="cell" className="num" title="Worst structural depth into this top-level output">
          <span className="depth-chip">{endpoint.worst_depth}</span>
        </td>
        <td role="cell">—</td>
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
          page={bitPage}
          onPageChange={onBitPageChange}
        />
      )}
    </>
  )
}

function BoundaryRow({
  endpoint,
  onOpen,
  open,
  onToggle,
  bitPage,
  onBitPageChange,
}: {
  endpoint: BoundaryEndpoint
  onOpen: Opener
  open: boolean
  onToggle: () => void
  bitPage: number
  onBitPageChange: (page: number) => void
}) {
  const name = boundaryDisplayName(endpoint)
  return (
    <>
      <tr
        className={`clickable${open ? ' expanded' : ''}`}
        role="row"
        onClick={() =>
          onOpen({
            ...boundaryFaninRequest(endpoint.node_id, `${name} (fanin)`, endpoint.port),
            highlight: [endpoint.node_id],
          })
        }
        title={`Open the fanin cone of ${name}`}
      >
        <td role="cell">
          <span className="mono">{name}</span>
          {endpoint.bits.length > 0 && <ExpandButton open={open} onToggle={onToggle} />}
        </td>
        <td role="cell"><span className="tag">{boundaryKind(endpoint)}</span></td>
        <td
          role="cell"
          className="num"
          title={endpoint.bits_truncated ? 'Additional connected bits omitted by the safety limit' : undefined}
        >
          {endpoint.bits.length}{endpoint.bits_truncated ? '+' : ''}
        </td>
        <td role="cell"><span className="tag">{displayCellType(endpoint.cell_type)}</span></td>
        <td role="cell" className="num" title={`Worst structural depth into ${endpoint.port}`}>
          <span className="depth-chip">{endpoint.worst_depth}</span>
        </td>
        <td role="cell"><SrcLink src={endpoint.src} /></td>
      </tr>
      {open && (
        <BitsRow
          name={name}
          width={endpoint.width}
          bits={endpoint.bits}
          depthLabel="Input-cone depth"
          openTitle="Open boundary input fanin for"
          colSpan={6}
          onOpen={onOpen}
          page={bitPage}
          onPageChange={onBitPageChange}
          rootPort={endpoint.port}
        />
      )}
    </>
  )
}
