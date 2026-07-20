import { useEffect, useMemo, useState } from 'react'
import { getPaths } from '../../api'
import { formatBitRanges } from '../../lib/bitRanges'
import { useDesignData } from '../../lib/useDesignData'
import {
  displayCellType,
  displayNodeName,
  isHiddenName,
  nodeSublabel,
  shortNetName,
} from '../../lib/prettyType'
import {
  loadTimingSettings,
  resolveTimingView,
  timingRequestForView,
} from '../../lib/timingSettings'
import type {
  EndpointKind,
  NodeRef,
  OutputAlias,
  PathClass,
  TimingPath,
} from '../../types'
import { shallowEqual, useStore } from '../../useStore'
import { SrcLink } from '../SrcLink'
import { VirtualTable } from '../VirtualTable'
import {
  nextPathSort,
  sortDirectionArrow,
  sortDirectionLabel,
  sortPaths,
  type PathSortKey,
  type PathSortState,
} from './pathSorting'

interface RouteVariant {
  index: number
  total: number
}

export function Paths() {
  const store = useStore(
    ({ design, showPathInGraph }) => ({ design, showPathInGraph }),
    shallowEqual,
  )
  const id = store.design?.design_id ?? null
  const designMode = store.design?.mode
  const resolvedProfile = store.design?.delay_profile
  const [sort, setSort] = useState<PathSortState>({
    key: 'depth',
    direction: 'desc',
  })
  // Cost per-path delays from the same per-design resolved view as the timing
  // panel. The tab remounts on switch, so persisted settings are read here.
  const timing = useMemo(() => {
    const settings = loadTimingSettings()
    if (!resolvedProfile) return null
    const view = resolveTimingView(settings, designMode, resolvedProfile)
    return {
      request: timingRequestForView(settings, view),
      hidden: !view.showTiming,
    }
  }, [designMode, resolvedProfile])
  const timingHidden = timing?.hidden ?? true
  const { data, loading, error } = useDesignData(
    id,
    // Keep route reconstruction independent of the table's presentation sort.
    // Otherwise switching columns changes which path variants the analysis
    // returns instead of reordering one complete result set.
    (designId) => getPaths(designId, { sort: 'depth', ...timing?.request }),
    JSON.stringify({ sort: 'depth', ...timing?.request }),
  )
  const [open, setOpen] = useState<number | null>(null)
  useEffect(() => setOpen(null), [id])
  const sortedPaths = useMemo(
    () => sortPaths(data?.paths ?? [], sort),
    [data, sort],
  )
  const variants = useMemo(() => routeVariants(sortedPaths), [sortedPaths])

  const selectSort = (key: PathSortKey) => {
    setSort((current) => nextPathSort(current, key))
    setOpen(null)
  }

  if (!store.design) return <div className="empty-state">No design yet.</div>
  if (loading && !data) return <div className="empty-state">Loading paths…</div>
  if (error) return <div className="empty-state">Failed to load paths: {error}</div>
  if (!data || data.paths.length === 0) {
    return <div className="empty-state">No structural paths reported.</div>
  }

  return (
    <div className="bounded-results-tab">
      {data.comb_loops.length > 0 && (
        <ul className="warn-list" style={{ marginBottom: 10 }}>
          <li>
            Combinational loops excluded:{' '}
            {data.comb_loops.map(readableLoopName).join(', ')}
          </li>
        </ul>
      )}
      {data.truncated && (
        <div className="caveat" style={{ marginBottom: 10 }}>
          Additional endpoint bits or structural route variants were omitted by the
          bounded path-analysis work budget.
        </div>
      )}
      <div className="section-title">
        Longest logical path variants ({data.paths.length})
      </div>
      <VirtualTable
        rowCount={sortedPaths.length}
        columnWidths={
          timingHidden
            ? ['4%', '8%', '15%', '19%', '20%', '22%', '12%']
            : ['4%', '7%', '10%', '14%', '18%', '18%', '18%', '11%']
        }
        getRowKey={(index) => pathKey(sortedPaths[index])}
        resetKey={`${sort.key}:${sort.direction}`}
        header={
          <>
            <th role="columnheader" className="num">#</th>
            <th
              role="columnheader"
              className="num sortable"
              aria-sort={sort.key === 'depth' ? sortDirectionLabel(sort.direction) : 'none'}
              onClick={() => selectSort('depth')}
              title="Sort by structural depth"
            >
              Depth{sort.key === 'depth' ? sortDirectionArrow(sort.direction) : ''}
            </th>
            {!timingHidden && (
              <th
                role="columnheader"
                className="num sortable"
                aria-sort={sort.key === 'delay' ? sortDirectionLabel(sort.direction) : 'none'}
                onClick={() => selectSort('delay')}
                title="Sort by estimated delay"
              >
                Est. delay{sort.key === 'delay' ? sortDirectionArrow(sort.direction) : ''}
              </th>
            )}
            <th role="columnheader">Class</th>
            <th role="columnheader">Startpoint</th>
            <th role="columnheader">Logical endpoint</th>
            <th role="columnheader">Bit / route cohort</th>
            <th role="columnheader"></th>
          </>
        }
        renderRow={(index) => {
          const path = sortedPaths[index]
          return (
            <PathRow
              index={index}
              path={path}
              variant={variants[index]}
              showTiming={!timingHidden}
              open={open === index}
              onToggle={() => setOpen(open === index ? null : index)}
              onShow={() => store.showPathInGraph(path)}
            />
          )
        }}
      />
    </div>
  )
}

function pathKey(path: TimingPath): string {
  return [
    path.endpoint_kind,
    path.endpoint_group,
    path.class,
    path.bits.join(','),
    path.depth,
    path.endpoint_port,
    path.nodes.map((node) => node.id).join(','),
  ].join(':')
}

function routeVariants(paths: TimingPath[]): RouteVariant[] {
  const totals = new Map<string, number>()
  for (const path of paths) {
    const key = logicalEndpointKey(path)
    totals.set(key, (totals.get(key) ?? 0) + 1)
  }
  const seen = new Map<string, number>()
  return paths.map((path) => {
    const key = logicalEndpointKey(path)
    const index = (seen.get(key) ?? 0) + 1
    seen.set(key, index)
    return { index, total: totals.get(key) ?? 1 }
  })
}

function logicalEndpointKey(path: TimingPath): string {
  return `${path.endpoint_kind}:${path.endpoint_group}`
}

function logicalEndpointName(path: TimingPath): string {
  return isHiddenName(path.endpoint_group)
    ? displayNodeName(path.endpoint)
    : path.endpoint_group
}

export function PathEndpointName({ path }: { path: TimingPath }) {
  return logicalEndpointName(path)
}

function readableLoopName(name: string): string {
  return isHiddenName(name) ? shortNetName(name) : name
}

function formatBitCohort(bits: number[]): string {
  return formatBitRanges(bits) || '—'
}

export function BitCohort({ bits }: { bits: number[] }) {
  return formatBitCohort(bits)
}

function pathClassLabel(pathClass: PathClass): string {
  switch (pathClass) {
    case 'input_to_register':
      return 'Input → register'
    case 'register_to_register':
      return 'Register → register'
    case 'register_to_output':
      return 'Register → output'
    case 'input_to_output':
      return 'Input → output'
    case 'other':
      return 'Other structural'
  }
}

export function PathClassName({ value }: { value: PathClass }) {
  return pathClassLabel(value)
}

function endpointKindLabel(kind: EndpointKind): string {
  switch (kind) {
    case 'register':
      return 'Register'
    case 'output':
      return 'Top-level output'
    case 'blackbox':
      return 'Boundary'
  }
}

function startpointKind(node: NodeRef): string {
  if (node.kind === 'port') return 'Input'
  if (node.kind === 'const') return 'Constant'
  if (node.register === true || (node.register == null && node.seq)) return 'Register'
  return 'Boundary'
}

function outputAliasLabel(alias: OutputAlias): string {
  const bits = alias.bits.map((bit) => bit.output_bit)
  if (alias.width === 1 && bits.length === 1 && bits[0] === 0) return alias.name
  return `${alias.name}${formatBitCohort(bits)}`
}

export function OutputAliasName({ alias }: { alias: OutputAlias }) {
  return outputAliasLabel(alias)
}

function PathRow({
  index,
  path,
  variant,
  showTiming,
  open,
  onToggle,
  onShow,
}: {
  index: number
  path: TimingPath
  variant: RouteVariant
  showTiming: boolean
  open: boolean
  onToggle: () => void
  onShow: () => void
}) {
  return (
    <>
      <tr role="row" className={`clickable${open ? ' expanded' : ''}`} onClick={onToggle}>
        <td role="cell" className="num faint">{index + 1}</td>
        <td role="cell" className="num">
          <span className="depth-chip">{path.depth}</span>
        </td>
        {showTiming && (
          <td role="cell" className="num mono">
            {path.estimated_delay_ns != null
              ? `${path.estimated_delay_ns.toFixed(2)} ns`
              : '—'}
          </td>
        )}
        <td role="cell">
          <span className="tag">{pathClassLabel(path.class)}</span>
        </td>
        <td role="cell">
          <span className="tag">{startpointKind(path.startpoint)}</span>{' '}
          <span className="mono">{displayNodeName(path.startpoint)}</span>
        </td>
        <td role="cell">
          <span className="tag">{endpointKindLabel(path.endpoint_kind)}</span>{' '}
          <span className="mono"><PathEndpointName path={path} /></span>
          {path.output_aliases.map((alias) => (
            <div key={alias.name} className="faint" style={{ fontSize: 10 }}>
              top-level output <span className="mono">{outputAliasLabel(alias)}</span>
            </div>
          ))}
        </td>
        <td role="cell">
          <span className="mono">bits {formatBitCohort(path.bits)}</span>
          <div className="faint" style={{ fontSize: 10 }}>
            {variant.total === 1
              ? 'one structural route'
              : `route ${variant.index} of ${variant.total}`}
          </div>
        </td>
        <td role="cell">
          <a
            onClick={(event) => {
              event.stopPropagation()
              onShow()
            }}
          >
            schematic
          </a>
        </td>
      </tr>
      {open && (
        <tr className="expanded" role="row">
          <td colSpan={showTiming ? 8 : 7} role="cell">
            <div className="chain">
              {path.nodes.map((node, nodeIndex) => (
                <Hop
                  key={`${node.id}:${nodeIndex}`}
                  node={node}
                  last={nodeIndex === path.nodes.length - 1}
                />
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function Hop({ node, last }: { node: NodeRef; last: boolean }) {
  const label =
    node.kind === 'cell'
      ? displayCellType(node.cell_type)
      : node.kind === 'port'
        ? 'PORT'
        : 'CONST'
  const name = nodeSublabel(node)
  return (
    <>
      <span className={`hop${node.register === true || (node.register == null && node.seq) ? ' seq' : ''}`}>
        <span className="t">{label}</span>
        {(name || node.src) && (
          <span className="n">
            {name}
            {name && node.src ? ' ' : ''}
            {node.src ? <SrcLink src={node.src} /> : null}
          </span>
        )}
      </span>
      {!last && <span className="arrow">→</span>}
    </>
  )
}
