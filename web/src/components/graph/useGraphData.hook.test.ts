import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphOptions } from '../../lib/graph/graphSettings'
import type { SourceGraphRequest } from '../../store'
import type { Subgraph, SynthesizeResponse } from '../../types'

const hookRuntime = vi.hoisted(() => {
  interface StateSlot {
    kind: 'state'
    value: unknown
    set: (next: unknown) => void
  }
  interface RefSlot {
    kind: 'ref'
    value: { current: unknown }
  }
  type Slot = StateSlot | RefSlot | { kind: 'other' }

  let slots: Slot[] = []
  let cursor = 0
  let cleanups: Array<() => void> = []

  return {
    reset() {
      slots = []
      cursor = 0
      cleanups = []
    },
    beginRender() {
      cursor = 0
      cleanups = []
    },
    useState(initial: unknown) {
      const index = cursor++
      if (slots[index]?.kind !== 'state') {
        const slot: StateSlot = {
          kind: 'state',
          value: typeof initial === 'function'
            ? (initial as () => unknown)()
            : initial,
          set(next) {
            slot.value = typeof next === 'function'
              ? (next as (current: unknown) => unknown)(slot.value)
              : next
          },
        }
        slots[index] = slot
      }
      const slot = slots[index] as StateSlot
      return [slot.value, slot.set]
    },
    useRef(initial: unknown) {
      const index = cursor++
      if (slots[index]?.kind !== 'ref') {
        slots[index] = { kind: 'ref', value: { current: initial } }
      }
      return (slots[index] as RefSlot).value
    },
    useEffect(effect: () => void | (() => void)) {
      cursor += 1
      slots[cursor - 1] = { kind: 'other' }
      const cleanup = effect()
      if (cleanup) cleanups.push(cleanup)
    },
    useMemo(factory: () => unknown) {
      cursor += 1
      slots[cursor - 1] = { kind: 'other' }
      return factory()
    },
    useCallback<T>(callback: T) {
      cursor += 1
      slots[cursor - 1] = { kind: 'other' }
      return callback
    },
    cleanup() {
      for (const cleanup of cleanups.reverse()) cleanup()
      cleanups = []
    },
  }
})

const clients = vi.hoisted(() => ({
  analyzeSourceInBrowser: vi.fn(),
  getNetlist: vi.fn(),
  prewarmLayoutWorker: vi.fn(),
}))

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useCallback: hookRuntime.useCallback,
  useEffect: hookRuntime.useEffect,
  useMemo: hookRuntime.useMemo,
  useRef: hookRuntime.useRef,
  useState: hookRuntime.useState,
}))

vi.mock('../../lib/designClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/designClient')>()),
  getNetlist: clients.getNetlist,
}))

vi.mock('../../lib/source/sourceSelectionClient', () => ({
  analyzeSourceInBrowser: clients.analyzeSourceInBrowser,
}))

vi.mock('../../lib/graph/layoutClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/graph/layoutClient')>()),
  prewarmLayoutWorker: clients.prewarmLayoutWorker,
}))

import { useGraphData } from './useGraphData'

const options: GraphOptions = {
  maxDepth: 7,
  maxNodes: 900,
  hideControl: true,
  hideConst: false,
  groupVectors: true,
  groupMemories: false,
  focus: false,
}
const design = { design_id: 'design-1' } as SynthesizeResponse
const emptyGraph: Subgraph = { nodes: [], edges: [], truncated: false }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function GraphDataHarness(coneReq: SourceGraphRequest | null = null) {
  const clearGraphSelection = vi.fn()
  const selectGraphNode = vi.fn()
  hookRuntime.beginRender()
  const result = useGraphData({
    active: true,
    analysisState: 'current',
    design,
    designRevision: 1,
    coneReq,
    graphOptions: options,
    clearGraphSelection,
    selectGraphNode,
  })
  return { clearGraphSelection, result }
}

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  hookRuntime.reset()
  vi.clearAllMocks()
})

describe('useGraphData async ownership', () => {
  it('reuses one in-flight full graph and aborts it on unmount', async () => {
    const full = deferred<Subgraph>()
    clients.getNetlist.mockReturnValue(full.promise)

    GraphDataHarness()
    GraphDataHarness()
    await flushPromises()

    expect(clients.getNetlist).toHaveBeenCalledTimes(1)
    const signal = clients.getNetlist.mock.calls[0][1] as AbortSignal
    expect(signal.aborted).toBe(false)

    hookRuntime.cleanup()

    expect(signal.aborted).toBe(true)
  })

  it('drops a source result that resolves after its request is aborted', async () => {
    const full = deferred<Subgraph>()
    const source = deferred<{
      graph: Subgraph
      status: 'unmapped'
      control: boolean
      directIds: number[]
      directBits: number[]
    }>()
    clients.getNetlist.mockReturnValue(full.promise)
    clients.analyzeSourceInBrowser.mockReturnValue(source.promise)
    const request: SourceGraphRequest = {
      kind: 'source',
      file: 'top.sv',
      startLine: 8,
      endLine: 8,
      selectionTruncated: false,
      label: 'counter',
      highlight: [],
      nonce: 3,
    }

    const { clearGraphSelection } = GraphDataHarness(request)
    const signal = clients.analyzeSourceInBrowser.mock.calls[0][3] as AbortSignal
    hookRuntime.cleanup()
    source.resolve({
      graph: emptyGraph,
      status: 'unmapped',
      control: false,
      directIds: [],
      directBits: [],
    })
    await flushPromises()

    expect(signal.aborted).toBe(true)
    expect(clearGraphSelection).not.toHaveBeenCalled()
  })
})
