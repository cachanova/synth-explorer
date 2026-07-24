// Browser-local analysis facade. Yosys and all analysis stay in browser workers.
// The optional Vivado path talks only to the explicitly started loopback connector.

import { DEFAULT_GRAPH_MAX_NODES } from './lib/graphLimits'
import { bundledExamples } from './lib/examples'
import { EngineLoadError } from './lib/engineLoad'
import {
  localCone,
  localExpandGroup,
  localEndpoints,
  localFanout,
  localNetlist,
  localNodes,
  localPaths,
  localSourceMap,
  localTiming,
  synthesizeLocally,
} from './lib/localEngine'
import {
  LocalSynthesisError,
  type SynthesisFailureKind,
} from './lib/synthesisError'
import type {
  DelayModel,
  EndpointsResponse,
  ExamplesResponse,
  FanoutResponse,
  Mode,
  NodesResponse,
  PathsResponse,
  SourceMapResponse,
  GroupExpansion,
  Subgraph,
  SynthesizeRequest,
  SynthesizeResponse,
  TimingRequest,
  TimingResponse,
  SynthTool,
  XilinxFamily,
} from './types'

export class ApiRequestError extends Error {
  status: number
  log?: string
  kind?: SynthesisFailureKind
  constructor(message: string, status: number, log?: string, kind?: SynthesisFailureKind) {
    super(message)
    this.name = 'ApiRequestError'
    this.status = status
    this.log = log
    this.kind = kind
  }
}

export async function synthesize(
  req: SynthesizeRequest,
  signal?: AbortSignal,
): Promise<SynthesizeResponse> {
  try {
    return await synthesizeLocally(req, signal)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    if (error instanceof ApiRequestError) throw error
    if (error instanceof LocalSynthesisError) {
      throw new ApiRequestError(
        error.message,
        statusForFailureKind(error.kind),
        error.log,
        error.kind,
      )
    }
    if (error instanceof EngineLoadError) {
      throw new ApiRequestError(error.message, statusForFailureKind('load'))
    }
    throw new ApiRequestError(error instanceof Error ? error.message : String(error), 422)
  }
}

function statusForFailureKind(kind: SynthesisFailureKind | undefined): number {
  if (kind === 'load') return 503
  if (kind === 'timeout') return 504
  if (kind === 'bridge') return 503
  return 400
}

export async function retuneTiming(
  id: string,
  req: TimingRequest,
): Promise<TimingResponse> {
  return localTiming(id, req)
}

export function getEndpoints(id: string): Promise<EndpointsResponse> {
  return localEndpoints(id)
}

export function getPaths(
  id: string,
  opts: {
    limit?: number
    to?: number
    sort?: 'depth' | 'delay'
    // Timing model so per-path delays track the client's retune settings.
    profile?: string
    speed_grade?: string
    model?: DelayModel
  } = {},
): Promise<PathsResponse> {
  return localPaths(id, opts)
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
  group_memories?: boolean
  // Restrict the first hop of a single-root cone to one physical sink pin.
  root_port?: string
  root_port_bit?: number
  root_port_bits?: number[]
}

export function getCone(
  id: string,
  opts: ConeOptions,
  signal?: AbortSignal,
): Promise<Subgraph> {
  return localCone(id, opts, signal)
}

export function getFanout(id: string, limit = 50): Promise<FanoutResponse> {
  return localFanout(id, limit)
}

export interface NetlistOptions {
  max_nodes?: number
  show_infrastructure?: boolean
  group_vectors?: boolean
  group_memories?: boolean
  hide_control?: boolean
  hide_const?: boolean
  around?: number[]
}

export function getNetlist(
  id: string,
  opts: NetlistOptions = {},
  signal?: AbortSignal,
): Promise<Subgraph> {
  return localNetlist(
    id,
    {
      max_nodes: opts.max_nodes ?? DEFAULT_GRAPH_MAX_NODES,
      show_infrastructure: opts.show_infrastructure ?? false,
      group_vectors: opts.group_vectors ?? false,
      group_memories: opts.group_memories ?? false,
      hide_control: opts.hide_control ?? true,
      hide_const: opts.hide_const ?? false,
      around: opts.around,
    },
    signal,
  )
}

export interface GroupExpansionOptions {
  node: number
  expanded_nodes: number[]
  max_nodes?: number
  hide_control?: boolean
  hide_const?: boolean
  group_vectors?: boolean
  group_memories?: boolean
}

export function expandGroup(
  id: string,
  opts: GroupExpansionOptions,
  signal?: AbortSignal,
): Promise<GroupExpansion> {
  return localExpandGroup(id, {
    ...opts,
    max_nodes: opts.max_nodes ?? 4_096,
    hide_control: opts.hide_control ?? true,
    hide_const: opts.hide_const ?? true,
    group_vectors: opts.group_vectors ?? false,
    group_memories: opts.group_memories ?? false,
  }, signal)
}

export function getSourceMap(id: string): Promise<SourceMapResponse> {
  return localSourceMap(id)
}

/** Resolve node ids to display metadata. Caps at the contract's 200-id limit. */
export function getNodes(id: string, ids: number[]): Promise<NodesResponse> {
  return localNodes(id, ids)
}

export function getExamples(): Promise<ExamplesResponse> {
  return Promise.resolve(bundledExamples())
}

export const PLATFORM_LABELS: { value: Mode; label: string }[] = [
  { value: 'rtl', label: 'RTL (word-level)' },
  { value: 'gates', label: 'Generic gates' },
  { value: 'lut4', label: 'Generic LUT4 metric' },
  { value: 'lut6', label: 'Generic LUT6 metric' },
  { value: 'ice40', label: 'iCE40' },
  { value: 'ecp5', label: 'ECP5' },
  { value: 'xilinx', label: 'Xilinx' },
]

export const SYNTH_TOOL_LABELS: { value: SynthTool; label: string }[] = [
  { value: 'yosys', label: 'Yosys' },
  { value: 'vivado', label: 'Vivado' },
]

// Xilinx target families (synth_xilinx -family). Determines carry (CARRY4 vs
// CARRY8), BRAM, and DSP primitives, so it makes the netlist match the vendor
// flow for that device. Default xc7 matches yosys's own default.
export const XILINX_FAMILY_LABELS: { value: XilinxFamily; label: string }[] = [
  { value: 'xc7', label: 'Series 7' },
  { value: 'xcup', label: 'UltraScale+' },
  { value: 'xcu', label: 'UltraScale' },
  { value: 'xc6s', label: 'Spartan-6' },
  { value: 'xc6v', label: 'Virtex-6' },
]
