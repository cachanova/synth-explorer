// Typed API client mirroring docs/API.md. All calls go through the /api proxy.

import { DEFAULT_GRAPH_MAX_NODES } from './lib/graphLimits'
import type {
  DelayModel,
  EndpointsResponse,
  ExamplesResponse,
  FanoutResponse,
  HealthResponse,
  LineConeResponse,
  Mode,
  NodesResponse,
  PathsResponse,
  SourceMapResponse,
  Subgraph,
  SynthTool,
  SynthesizeRequest,
  SynthesizeResponse,
  TimingRequest,
  TimingResponse,
  XilinxFamily,
} from './types'

export class ApiRequestError extends Error {
  status: number
  log?: string
  constructor(message: string, status: number, log?: string) {
    super(message)
    this.name = 'ApiRequestError'
    this.status = status
    this.log = log
  }
}

async function parseError(res: Response): Promise<ApiRequestError> {
  let message = `${res.status} ${res.statusText}`
  let log: string | undefined
  try {
    const body = await res.json()
    if (body && typeof body === 'object') {
      if (typeof body.error === 'string') message = body.error
      if (typeof body.log === 'string') log = body.log
    }
  } catch {
    // non-JSON error body; keep status text
  }
  return new ApiRequestError(message, res.status, log)
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = signal ? await fetch(url, { signal }) : await fetch(url)
  if (!res.ok) throw await parseError(res)
  return (await res.json()) as T
}

export async function synthesize(req: SynthesizeRequest): Promise<SynthesizeResponse> {
  const res = await fetch('/api/synthesize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
  if (!res.ok) throw await parseError(res)
  return (await res.json()) as SynthesizeResponse
}

export function getDesign(id: string): Promise<SynthesizeResponse> {
  return getJson<SynthesizeResponse>(`/api/design/${encodeURIComponent(id)}`)
}

export async function retuneTiming(
  id: string,
  req: TimingRequest,
): Promise<TimingResponse> {
  const res = await fetch(`/api/design/${encodeURIComponent(id)}/timing`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
  if (!res.ok) throw await parseError(res)
  return (await res.json()) as TimingResponse
}

export function getEndpoints(id: string): Promise<EndpointsResponse> {
  return getJson<EndpointsResponse>(`/api/design/${encodeURIComponent(id)}/endpoints`)
}

export function getPaths(
  id: string,
  opts: {
    limit?: number
    to?: number
    // Timing model so per-path delays track the client's retune settings.
    profile?: string
    speed_grade?: string
    model?: DelayModel
  } = {},
): Promise<PathsResponse> {
  const p = new URLSearchParams()
  if (opts.limit != null) p.set('limit', String(opts.limit))
  if (opts.to != null) p.set('to', String(opts.to))
  if (opts.profile != null) p.set('profile', opts.profile)
  if (opts.speed_grade != null) p.set('speed_grade', opts.speed_grade)
  if (opts.model != null) p.set('model', JSON.stringify(opts.model))
  const qs = p.toString()
  return getJson<PathsResponse>(
    `/api/design/${encodeURIComponent(id)}/paths${qs ? `?${qs}` : ''}`,
  )
}

export interface ConeOptions {
  node: number
  // Multi-root cone: when present (and non-empty) overrides `node`, unioning
  // every root's cone under one budget. Serialized as nodes=1,2,3.
  nodes?: number[]
  dir: 'fanin' | 'fanout'
  max_depth?: number
  max_nodes?: number
  hide_control?: boolean
  hide_const?: boolean
  show_infrastructure?: boolean
  group_vectors?: boolean
}

export function getCone(
  id: string,
  opts: ConeOptions,
  signal?: AbortSignal,
): Promise<Subgraph> {
  const p = new URLSearchParams()
  if (opts.nodes && opts.nodes.length > 0) {
    p.set('nodes', opts.nodes.join(','))
  } else {
    p.set('node', String(opts.node))
  }
  p.set('dir', opts.dir)
  if (opts.max_depth != null) p.set('max_depth', String(opts.max_depth))
  if (opts.max_nodes != null) p.set('max_nodes', String(opts.max_nodes))
  if (opts.hide_control != null) p.set('hide_control', String(opts.hide_control))
  if (opts.hide_const != null) p.set('hide_const', String(opts.hide_const))
  if (opts.show_infrastructure != null) {
    p.set('show_infrastructure', String(opts.show_infrastructure))
  }
  if (opts.group_vectors != null) p.set('group_vectors', String(opts.group_vectors))
  return getJson<Subgraph>(
    `/api/design/${encodeURIComponent(id)}/cone?${p.toString()}`,
    signal,
  )
}

export interface LineConeOptions {
  file: string
  start_line: number
  end_line: number
  max_nodes?: number
  hide_control?: boolean
  hide_const?: boolean
  show_infrastructure?: boolean
  group_vectors?: boolean
}

export function getLineCone(
  id: string,
  opts: LineConeOptions,
  signal?: AbortSignal,
): Promise<LineConeResponse> {
  const p = new URLSearchParams()
  p.set('file', opts.file)
  p.set('start_line', String(opts.start_line))
  p.set('end_line', String(opts.end_line))
  if (opts.max_nodes != null) p.set('max_nodes', String(opts.max_nodes))
  if (opts.hide_control != null) p.set('hide_control', String(opts.hide_control))
  if (opts.hide_const != null) p.set('hide_const', String(opts.hide_const))
  if (opts.show_infrastructure != null) {
    p.set('show_infrastructure', String(opts.show_infrastructure))
  }
  if (opts.group_vectors != null) p.set('group_vectors', String(opts.group_vectors))
  return getJson<LineConeResponse>(
    `/api/design/${encodeURIComponent(id)}/line-cone?${p.toString()}`,
    signal,
  )
}

export function getFanout(id: string, limit = 50): Promise<FanoutResponse> {
  return getJson<FanoutResponse>(
    `/api/design/${encodeURIComponent(id)}/fanout?limit=${limit}`,
  )
}

export function getNetlist(
  id: string,
  maxNodes = DEFAULT_GRAPH_MAX_NODES,
  showInfrastructure = false,
  groupVectors = false,
  hideControl = true,
  hideConst = false,
  signal?: AbortSignal,
): Promise<Subgraph> {
  return getJson<Subgraph>(
    `/api/design/${encodeURIComponent(id)}/netlist?max_nodes=${maxNodes}&show_infrastructure=${showInfrastructure}&group_vectors=${groupVectors}&hide_control=${hideControl}&hide_const=${hideConst}`,
    signal,
  )
}

export function getSourceMap(id: string): Promise<SourceMapResponse> {
  return getJson<SourceMapResponse>(`/api/design/${encodeURIComponent(id)}/source-map`)
}

/** Resolve node ids to display metadata. Caps at the contract's 200-id limit. */
export function getNodes(id: string, ids: number[]): Promise<NodesResponse> {
  const capped = ids.slice(0, 200)
  return getJson<NodesResponse>(
    `/api/design/${encodeURIComponent(id)}/nodes?ids=${capped.join(',')}`,
  )
}

export function getExamples(): Promise<ExamplesResponse> {
  return getJson<ExamplesResponse>('/api/examples')
}

export function getHealth(): Promise<HealthResponse> {
  return getJson<HealthResponse>('/healthz')
}

export const MODE_LABELS: { value: Mode; label: string }[] = [
  { value: 'rtl', label: 'RTL (word-level)' },
  { value: 'gates', label: 'Generic gates' },
  { value: 'lut4', label: 'Generic LUT4 metric' },
  { value: 'lut6', label: 'Generic LUT6 metric' },
  { value: 'ice40', label: 'iCE40' },
  { value: 'ecp5', label: 'ECP5' },
  { value: 'xilinx', label: 'Xilinx — Yosys' },
]

export const SYNTH_TOOL_LABELS: { value: SynthTool; label: string }[] = [
  { value: 'yosys', label: 'Yosys' },
  { value: 'vivado', label: 'Vivado' },
]

export const VIVADO_TARGETS = [
  { value: 'xc7a35tcpg236-1', label: 'Artix-7 XC7A35T (xc7a35tcpg236-1)' },
] as const

// Xilinx target families (synth_xilinx -family). Determines carry (CARRY4 vs
// CARRY8), BRAM, and DSP primitives, so it makes the netlist match the vendor
// flow for that device. Default xc7 matches yosys's own default.
export const XILINX_FAMILY_LABELS: { value: XilinxFamily; label: string }[] = [
  { value: 'xc7', label: 'Series 7 — Artix/Kintex/Virtex-7, Zynq-7000' },
  { value: 'xcup', label: 'UltraScale+' },
  { value: 'xcu', label: 'UltraScale' },
  { value: 'xc6s', label: 'Spartan-6' },
  { value: 'xc6v', label: 'Virtex-6' },
]
