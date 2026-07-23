import type { ElkNode } from 'elkjs/lib/elk-api'
import {
  interpretResult,
  toElkGraph,
  type LayoutGeometry,
  type LayoutInput,
  type NodePlacement,
} from '../lib/layout'

export interface ElkRequest {
  id: number
  input: LayoutInput
  placement: NodePlacement
}

export type ElkResponse =
  | { id: number; ok: true; result: LayoutGeometry }
  | { id: number; ok: false; error: string }

interface ElkLayoutEngine {
  layout(graph: ElkNode): Promise<ElkNode>
}

const warmupInput: LayoutInput = {
  nodes: [
    {
      id: 0,
      baseWidth: 62,
      baseHeight: 46,
      controlHeight: 0,
      register: false,
      boundary: 'input',
    },
    {
      id: 1,
      baseWidth: 62,
      baseHeight: 46,
      controlHeight: 0,
      register: false,
      boundary: 'output',
    },
  ],
  edges: [
    {
      from: 0,
      to: 1,
      fromPort: 'Y',
      toPort: 'A',
      control: false,
    },
  ],
}

/** Start the one-time layered-layout warmup and keep failure opportunistic. */
export function startElkWarmup(elk: ElkLayoutEngine): Promise<void> {
  return elk
    .layout(toElkGraph(warmupInput, 'BRANDES_KOEPF'))
    .then(() => undefined)
    .catch(() => undefined)
}

/** Wait for startup, then run one real compact-protocol layout request. */
export async function runElkRequest(
  elk: ElkLayoutEngine,
  ready: Promise<void>,
  request: ElkRequest,
): Promise<ElkResponse> {
  const { id, input, placement } = request
  try {
    await ready
    const graph = toElkGraph(input, placement)
    const laidOut = await elk.layout(graph)
    return { id, ok: true, result: interpretResult(input, laidOut) }
  } catch (err) {
    return { id, ok: false, error: String(err) }
  }
}
