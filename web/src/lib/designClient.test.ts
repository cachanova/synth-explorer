import { beforeEach, describe, expect, it, vi } from 'vitest'

const engine = vi.hoisted(() => ({
  localCone: vi.fn(),
  localEndpoints: vi.fn(),
  localExpandGroup: vi.fn(),
  localFanout: vi.fn(),
  localNetlist: vi.fn(),
  localPaths: vi.fn(),
  localTiming: vi.fn(),
  synthesizeLocally: vi.fn(),
}))

vi.mock('./synthesis/localEngine', () => engine)

import { expandGroup, getNetlist, synthesize } from './designClient'
import {
  DEFAULT_GRAPH_MAX_NODES,
  MAX_GROUP_EXPANSION_RENDER_NODES,
} from './graph/graphLimits'
import { EngineLoadError } from './synthesis/engineLoad'
import {
  LocalSynthesisError,
  RequestValidationError,
} from './synthesis/synthesisError'

const request = {
  files: [{ name: 'top.sv', content: 'module top; endmodule' }],
  mode: 'gates' as const,
}

beforeEach(() => vi.clearAllMocks())

describe('browser-local design client errors', () => {
  it('classifies an analysis engine load failure', async () => {
    engine.synthesizeLocally.mockRejectedValue(
      new EngineLoadError('failed to load the analysis engine: aborted'),
    )

    await expect(synthesize(request)).rejects.toMatchObject({
      name: 'DesignRequestError',
      kind: 'load',
    })
  })

  it('classifies a Yosys engine load failure from its kind rather than its text', async () => {
    engine.synthesizeLocally.mockRejectedValue(
      new LocalSynthesisError('failed to load Yosys: The request timed out.', '', 'load'),
    )

    await expect(synthesize(request)).rejects.toMatchObject({ kind: 'load' })
  })

  it('keeps timeouts distinct from synthesis failures', async () => {
    engine.synthesizeLocally.mockRejectedValue(
      new LocalSynthesisError('yosys timed out', '', 'timeout'),
    )
    await expect(synthesize(request)).rejects.toMatchObject({ kind: 'timeout' })

    engine.synthesizeLocally.mockRejectedValue(new LocalSynthesisError('yosys failed', 'log'))
    await expect(synthesize(request)).rejects.toMatchObject({
      kind: 'synthesis',
      log: 'log',
    })
  })

  it('classifies unexpected failures as internal errors', async () => {
    engine.synthesizeLocally.mockRejectedValue(new Error('unexpected'))

    await expect(synthesize(request)).rejects.toMatchObject({ kind: 'internal' })
  })

  it('keeps genuine request-validation failures distinct', async () => {
    engine.synthesizeLocally.mockRejectedValue(
      new RequestValidationError('invalid top module name: top; exec'),
    )

    await expect(synthesize(request)).rejects.toMatchObject({ kind: 'validation' })
  })
})

describe('browser-local design client defaults', () => {
  it('fills the bounded netlist defaults', async () => {
    await getNetlist()

    expect(DEFAULT_GRAPH_MAX_NODES).toBe(400)
    expect(engine.localNetlist).toHaveBeenCalledWith(
      {
        max_nodes: DEFAULT_GRAPH_MAX_NODES,
        show_infrastructure: false,
        group_vectors: false,
        group_memories: false,
        hide_control: true,
        hide_const: false,
        around: undefined,
      },
      undefined,
    )
  })

  it('fills the bounded group-expansion defaults', async () => {
    await expandGroup({ node: 7, expanded_nodes: [7] })

    expect(MAX_GROUP_EXPANSION_RENDER_NODES).toBe(4_096)
    expect(engine.localExpandGroup).toHaveBeenCalledWith(
      {
        node: 7,
        expanded_nodes: [7],
        max_nodes: MAX_GROUP_EXPANSION_RENDER_NODES,
        hide_control: true,
        hide_const: true,
        group_vectors: false,
        group_memories: false,
      },
      undefined,
    )
  })
})
