import { useMemo, useState } from 'react'
import { getPaths } from '../../api'
import { STRUCTURAL_DEPTH_CAVEAT } from '../../lib/depth'
import { useDesignData } from '../../lib/useDesignData'
import {
  displayCellType,
  displayNodeName,
  isHiddenName,
  nodeSublabel,
  shortNetName,
} from '../../lib/prettyType'
import { useStore } from '../../store'
import type {
  EndpointKind,
  NodeRef,
  OutputAlias,
  PathClass,
  TimingPath,
} from '../../types'
import { SrcLink } from '../SrcLink'

interface RouteVariant {
  index: number
  total: number
}

export function Paths() {
  const store = useStore()
  const id = store.design?.design_id ?? null
  const { data, loading, error } = useDesignData(id, (designId) =>
    getPaths(designId, { limit: 25 }),
  )
  const [open, setOpen] = useState<number | null>(null)
  const variants = useMemo(() => routeVariants(data?.paths ?? []), [data])

  if (!store.design) return <div className="empty-state">No design yet.</div>
  if (loading && !data) return <div className="empty-state">Loading paths…</div>
  if (error) return <div className="empty-state">Failed to load paths: {error}</div>
  if (!data || data.paths.length === 0) {
    return <div className="empty-state">No structural paths reported.</div>
  }

  return (
    <div>
      <div className="caveat" style={{ marginTop: 0, marginBottom: 10 }}>
        {STRUCTURAL_DEPTH_CAVEAT}
      </div>

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
          bounded path-analysis limit.
        </div>
      )}
      <div className="section-title">
        Longest logical path variants ({data.paths.length})
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th className="num">#</th>
            <th className="num">Depth</th>
            <th className="num">Est. delay</th>
            <th>Class</th>
            <th>Startpoint</th>
            <th>Logical endpoint</th>
            <th>Bit / route cohort</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {data.paths.map((path, index) => (
            <PathRow
              key={pathKey(path, index)}
              index={index}
              path={path}
              variant={variants[index]}
              open={open === index}
              onToggle={() => setOpen(open === index ? null : index)}
              onShow={() => store.showPathInGraph(path)}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function pathKey(path: TimingPath, index: number): string {
  return [
    path.endpoint_kind,
    path.endpoint_group,
    path.class,
    path.bits.join(','),
    path.depth,
    index,
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
  const sorted = [...new Set(bits)].sort((a, b) => a - b)
  if (sorted.length === 0) return '—'
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
  open,
  onToggle,
  onShow,
}: {
  index: number
  path: TimingPath
  variant: RouteVariant
  open: boolean
  onToggle: () => void
  onShow: () => void
}) {
  return (
    <>
      <tr className={`clickable${open ? ' expanded' : ''}`} onClick={onToggle}>
        <td className="num faint">{index + 1}</td>
        <td className="num">
          <span className="depth-chip">{path.depth}</span>
        </td>
        <td className="num mono">
          {path.estimated_delay_ns != null
            ? `${path.estimated_delay_ns.toFixed(2)} ns`
            : '—'}
        </td>
        <td>
          <span className="tag">{pathClassLabel(path.class)}</span>
        </td>
        <td>
          <span className="tag">{startpointKind(path.startpoint)}</span>{' '}
          <span className="mono">{displayNodeName(path.startpoint)}</span>
        </td>
        <td>
          <span className="tag">{endpointKindLabel(path.endpoint_kind)}</span>{' '}
          <span className="mono"><PathEndpointName path={path} /></span>
          {path.output_aliases.map((alias) => (
            <div key={alias.name} className="faint" style={{ fontSize: 10 }}>
              top-level output <span className="mono">{outputAliasLabel(alias)}</span>
            </div>
          ))}
        </td>
        <td>
          <span className="mono">bits {formatBitCohort(path.bits)}</span>
          <div className="faint" style={{ fontSize: 10 }}>
            {variant.total === 1
              ? 'one structural route'
              : `route ${variant.index} of ${variant.total}`}
          </div>
        </td>
        <td>
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
        <tr className="expanded">
          <td colSpan={8}>
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
