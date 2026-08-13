import { DEFAULT_GRAPH_MAX_NODES, MAX_GRAPH_RENDER_NODES } from './graphLimits'

const GRAPH_OPTIONS_KEY = 'synthexplorer.graphOptions.v1'

// The lower bound the graph toolbar's node stepper allows.
export const MIN_GRAPH_MAX_NODES = 50

export interface GraphOptions {
  maxDepth: number
  maxNodes: number
  hideControl: boolean
  hideConst: boolean
  focus: boolean
  groupVectors: boolean
  groupMemories: boolean
}

export const DEFAULT_GRAPH_OPTIONS: GraphOptions = {
  maxDepth: 64,
  maxNodes: DEFAULT_GRAPH_MAX_NODES,
  hideControl: true,
  hideConst: true,
  focus: true,
  groupVectors: true,
  groupMemories: true,
}

export function parseStoredGraphOptions(value: unknown): GraphOptions {
  if (!value || typeof value !== 'object') return DEFAULT_GRAPH_OPTIONS
  const record = value as Record<string, unknown>
  if (
    typeof record.hideControl !== 'boolean' ||
    typeof record.hideConst !== 'boolean' ||
    typeof record.focus !== 'boolean' ||
    typeof record.groupVectors !== 'boolean' ||
    typeof record.groupMemories !== 'boolean' ||
    typeof record.maxDepth !== 'number' ||
    !Number.isFinite(record.maxDepth) ||
    typeof record.maxNodes !== 'number' ||
    !Number.isFinite(record.maxNodes)
  ) {
    return DEFAULT_GRAPH_OPTIONS
  }

  return {
    maxDepth: Math.max(1, Math.round(record.maxDepth)),
    maxNodes: Math.min(
      MAX_GRAPH_RENDER_NODES,
      Math.max(MIN_GRAPH_MAX_NODES, Math.round(record.maxNodes)),
    ),
    hideControl: record.hideControl,
    hideConst: record.hideConst,
    focus: record.focus,
    groupVectors: record.groupVectors,
    groupMemories: record.groupMemories,
  }
}

export function loadGraphOptions(): GraphOptions {
  try {
    const stored = localStorage.getItem(GRAPH_OPTIONS_KEY)
    return stored == null
      ? DEFAULT_GRAPH_OPTIONS
      : parseStoredGraphOptions(JSON.parse(stored))
  } catch {
    return DEFAULT_GRAPH_OPTIONS
  }
}

export function saveGraphOptions(options: GraphOptions): void {
  try {
    localStorage.setItem(GRAPH_OPTIONS_KEY, JSON.stringify(options))
  } catch {
    // Keep the options for this session when local storage is unavailable.
  }
}
