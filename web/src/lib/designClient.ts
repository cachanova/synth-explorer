// Browser-local design client. Yosys and all analysis stay in browser workers.
// The optional Vivado path talks only to the explicitly started loopback connector.

import type {
  EndpointsResponse,
  ExamplesResponse,
  FanoutResponse,
  GroupExpansion,
  GroupExpansionOptions,
  NetlistOptions,
  PathsOptions,
  PathsResponse,
  ConeOptions,
  Subgraph,
  SynthesizeRequest,
  SynthesizeResponse,
  TimingRequest,
  TimingResponse,
} from '../types'
import { EngineLoadError } from './synthesis/engineLoad'
import { bundledExamples } from './examples'
import { DEFAULT_GRAPH_MAX_NODES } from './graph/graphLimits'
import {
  localCone,
  localEndpoints,
  localExpandGroup,
  localFanout,
  localNetlist,
  localPaths,
  localTiming,
  synthesizeLocally,
} from './synthesis/localEngine'
import { LocalSynthesisError, type SynthesisFailureKind } from './synthesis/synthesisError'

export type DesignRequestFailureKind = SynthesisFailureKind | 'synthesis' | 'validation'

export class DesignRequestError extends Error {
  readonly kind: DesignRequestFailureKind
  readonly log?: string

  constructor(message: string, kind: DesignRequestFailureKind, log?: string) {
    super(message)
    this.name = 'DesignRequestError'
    this.kind = kind
    this.log = log
  }
}

export async function synthesize(
  request: SynthesizeRequest,
  signal?: AbortSignal,
): Promise<SynthesizeResponse> {
  try {
    return await synthesizeLocally(request, signal)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    if (error instanceof DesignRequestError) throw error
    if (error instanceof LocalSynthesisError) {
      throw new DesignRequestError(error.message, error.kind ?? 'synthesis', error.log)
    }
    if (error instanceof EngineLoadError) {
      throw new DesignRequestError(error.message, 'load')
    }
    throw new DesignRequestError(
      error instanceof Error ? error.message : String(error),
      'validation',
    )
  }
}

export function retuneTiming(_id: string, request: TimingRequest): Promise<TimingResponse> {
  return localTiming(request)
}

export function getEndpoints(_id: string): Promise<EndpointsResponse> {
  return localEndpoints()
}

export function getPaths(_id: string, options: PathsOptions = {}): Promise<PathsResponse> {
  return localPaths(options)
}

export function getCone(
  _id: string,
  options: ConeOptions,
  signal?: AbortSignal,
): Promise<Subgraph> {
  return localCone(options, signal)
}

export function getFanout(_id: string, limit = 50): Promise<FanoutResponse> {
  return localFanout(limit)
}

export function getNetlist(
  _id: string,
  options: NetlistOptions = {},
  signal?: AbortSignal,
): Promise<Subgraph> {
  return localNetlist(
    {
      max_nodes: options.max_nodes ?? DEFAULT_GRAPH_MAX_NODES,
      show_infrastructure: options.show_infrastructure ?? false,
      group_vectors: options.group_vectors ?? false,
      group_memories: options.group_memories ?? false,
      hide_control: options.hide_control ?? true,
      hide_const: options.hide_const ?? false,
      around: options.around,
    },
    signal,
  )
}

export function expandGroup(
  _id: string,
  options: GroupExpansionOptions,
  signal?: AbortSignal,
): Promise<GroupExpansion> {
  return localExpandGroup(
    {
      ...options,
      max_nodes: options.max_nodes ?? 4_096,
      hide_control: options.hide_control ?? true,
      hide_const: options.hide_const ?? true,
      group_vectors: options.group_vectors ?? false,
      group_memories: options.group_memories ?? false,
    },
    signal,
  )
}

export function getExamples(): Promise<ExamplesResponse> {
  return Promise.resolve(bundledExamples())
}
