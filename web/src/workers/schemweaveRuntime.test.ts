import { expect, it, vi } from 'vitest'
import {
  toSchemWeaveLayoutRequest,
  type LayoutInput,
  type SchemWeaveExpansionRequest,
  type SchemWeaveLayoutRequest,
} from '../lib/layout'
import {
  initSync,
  layout_json as wasmLayoutJson,
} from '../wasm/layout/schemweave'
import {
  SCHEMWEAVE_BOUNDARY_BUNDLE_FALLBACK,
  SCHEMWEAVE_BOUNDARY_BUNDLE_ERROR_NAME,
  runSchemWeaveRequest,
} from './schemweaveRuntime'

const input: LayoutInput = {
  nodes: [
    {
      id: 1,
      baseWidth: 62,
      baseHeight: 46,
      controlHeight: 0,
      register: false,
      boundary: 'input',
      boundaryWidth: 8,
      boundaryMembers: [
        { member: 10, bit: 0 },
        { member: 17, bit: 7 },
      ],
    },
    {
      id: 2,
      baseWidth: 62,
      baseHeight: 46,
      controlHeight: 0,
      register: false,
      boundary: 'output',
    },
  ],
  edges: [{
    from: 1,
    to: 2,
    fromPort: 'Y',
    toPort: 'A',
    control: false,
    net: 0,
    sourceBoundaryMembers: [
      { member: 10, net_bits: [100] },
      { member: 17, net_bits: [107] },
    ],
  }],
}

it('dispatches incremental group expansion through the dedicated WASM API', () => {
  const expansion: SchemWeaveExpansionRequest = {
    compact_graph: { nodes: [], edges: [] },
    compact_layout: { nodes: [], edges: [], width: 0, height: 0 },
    expanded_graph: { nodes: [], edges: [] },
    reference_height: 100,
    expansion: {
      anchor: 10,
      members: [1, 2],
      boundary_trunks: [],
    },
    constraints: { inputs: [], outputs: [] },
  }
  const expand_group_json = vi.fn().mockReturnValue(JSON.stringify({
    status: 'needs_full_relayout',
    reason: 'geometry',
  }))

  expect(runSchemWeaveRequest(
    {
      layout_json: vi.fn(),
      expand_group_json,
    },
    { id: 51, kind: 'expand', request: expansion },
  )).toEqual({
    id: 51,
    ok: true,
    result: {
      status: 'needs_full_relayout',
      reason: 'geometry',
    },
  })
  expect(JSON.parse(expand_group_json.mock.calls[0][0])).toEqual(expansion)
})

it('serializes exact boundary constraints and returns raw bundle geometry', () => {
  const layout_json = vi.fn().mockReturnValue(JSON.stringify({
    nodes: [
      { id: 1, x: 0, y: 0, width: 62, height: 46 },
      { id: 2, x: 128, y: 0, width: 62, height: 46 },
    ],
    edges: [
      { id: 0, points: [{ x: 72, y: 20 }, { x: 128, y: 20 }] },
      { id: 1, points: [{ x: 72, y: 26 }, { x: 128, y: 26 }] },
    ],
    boundary_bundles: [{
      id: 0,
      endpoint: { node: 1, port: 0 },
      role: 'input',
      width: 8,
      collector: {
        start: { x: 72, y: 23 },
        end: { x: 72, y: 23 },
      },
      spine: {
        start: { x: 62, y: 23 },
        end: { x: 72, y: 23 },
      },
      members: [
        { edge: 0, slots: [0], tap: { x: 72, y: 20 } },
        { edge: 1, slots: [7], tap: { x: 72, y: 26 } },
      ],
    }],
    width: 190,
    height: 46,
  }))

  const request = toSchemWeaveLayoutRequest(input)
  expect(runSchemWeaveRequest({ layout_json }, { id: 41, request })).toEqual({
    id: 41,
    ok: true,
    result: {
      nodes: [
        { id: 1, x: 0, y: 0, width: 62, height: 46 },
        { id: 2, x: 128, y: 0, width: 62, height: 46 },
      ],
      edges: [
        { id: 0, points: [{ x: 72, y: 20 }, { x: 128, y: 20 }] },
        { id: 1, points: [{ x: 72, y: 26 }, { x: 128, y: 26 }] },
      ],
      boundary_bundles: [{
        id: 0,
        endpoint: { node: 1, port: 0 },
        role: 'input',
        width: 8,
        collector: {
          start: { x: 72, y: 23 },
          end: { x: 72, y: 23 },
        },
        spine: {
          start: { x: 62, y: 23 },
          end: { x: 72, y: 23 },
        },
        members: [
          { edge: 0, slots: [0], tap: { x: 72, y: 20 } },
          { edge: 1, slots: [7], tap: { x: 72, y: 26 } },
        ],
      }],
      width: 190,
      height: 46,
    },
  })

  const serialized = JSON.parse(layout_json.mock.calls[0][0])
  expect(serialized.constraints.boundary_bundles).toEqual([{
    id: 0,
    endpoint: { node: 1, port: 0 },
    width: 8,
    members: [
      { edge: 0, slots: [0] },
      { edge: 1, slots: [7] },
    ],
  }])
})

it('returns an explicit protocol error when layout fails', () => {
  const layout_json = vi.fn(() => {
    throw new Error('layout failed')
  })

  expect(runSchemWeaveRequest(
    { layout_json },
    { id: 9, request: toSchemWeaveLayoutRequest(input) },
  )).toEqual({
    id: 9,
    ok: false,
    error: 'layout failed',
  })
})

it('retries one bundle geometry failure without bundles and preserves alignment', () => {
  const fallback = {
    nodes: [
      { id: 1, x: 0, y: 0, width: 62, height: 46 },
      { id: 2, x: 128, y: 0, width: 62, height: 46 },
    ],
    edges: [{ id: 0, points: [{ x: 62, y: 23 }, { x: 128, y: 23 }] }],
    width: 190,
    height: 46,
  }
  const boundaryFailure = new Error(
    'boundary bundle geometry does not satisfy the hard readability contract',
  )
  boundaryFailure.name = SCHEMWEAVE_BOUNDARY_BUNDLE_ERROR_NAME
  const layout_json = vi.fn()
    .mockImplementationOnce(() => {
      throw boundaryFailure
    })
    .mockReturnValueOnce(JSON.stringify(fallback))
  const request = toSchemWeaveLayoutRequest(input)

  expect(runSchemWeaveRequest({ layout_json }, { id: 12, request })).toEqual({
    id: 12,
    ok: true,
    result: fallback,
    fallback: SCHEMWEAVE_BOUNDARY_BUNDLE_FALLBACK,
  })
  expect(layout_json).toHaveBeenCalledTimes(2)
  expect(JSON.parse(layout_json.mock.calls[0][0]).constraints).toEqual(
    request.constraints,
  )
  expect(JSON.parse(layout_json.mock.calls[1][0]).constraints).toEqual({
    inputs: request.constraints.inputs,
    outputs: request.constraints.outputs,
  })
})

it('does not retry an unrelated layout failure', () => {
  const layout_json = vi.fn(() => {
    throw new Error('unrelated route contact failed')
  })

  expect(runSchemWeaveRequest(
    { layout_json },
    { id: 13, request: toSchemWeaveLayoutRequest(input) },
  )).toEqual({
    id: 13,
    ok: false,
    error: 'unrelated route contact failed',
  })
  expect(layout_json).toHaveBeenCalledOnce()
})

it('does not retry a bundle error when the request has no bundle constraints', () => {
  const boundaryFailure = new Error(
    'boundary bundle geometry does not satisfy the hard readability contract',
  )
  boundaryFailure.name = SCHEMWEAVE_BOUNDARY_BUNDLE_ERROR_NAME
  const layout_json = vi.fn(() => {
    throw boundaryFailure
  })
  const request = toSchemWeaveLayoutRequest(input)
  request.constraints.boundary_bundles = []

  expect(runSchemWeaveRequest(
    { layout_json },
    { id: 15, request },
  )).toEqual({
    id: 15,
    ok: false,
    error:
      'boundary bundle geometry does not satisfy the hard readability contract',
    kind: 'boundary-bundle-geometry-unsatisfied',
  })
  expect(layout_json).toHaveBeenCalledOnce()
})

it('does not loop and reports both errors when the bundle-free retry fails', () => {
  const first = new Error(
    'boundary bundle geometry does not satisfy the hard readability contract',
  )
  first.name = SCHEMWEAVE_BOUNDARY_BUNDLE_ERROR_NAME
  const second = new Error('bundle-free layout also failed')
  const layout_json = vi.fn()
    .mockImplementationOnce(() => {
      throw first
    })
    .mockImplementationOnce(() => {
      throw second
    })

  expect(runSchemWeaveRequest(
    { layout_json },
    { id: 14, request: toSchemWeaveLayoutRequest(input) },
  )).toEqual({
    id: 14,
    ok: false,
    error:
      'boundary bundle layout failed: boundary bundle geometry does not satisfy the hard readability contract; bundle-free retry failed: bundle-free layout also failed',
  })
  expect(layout_json).toHaveBeenCalledTimes(2)
})

it('preserves a hard collector-contact error and real fallback across JavaScript/WASM', () => {
  const { readFileSync } = (
    globalThis as unknown as {
      process: {
        getBuiltinModule(name: 'fs'): {
          readFileSync(path: URL): Uint8Array
        }
      }
    }
  ).process.getBuiltinModule('fs')
  const wasmBytes = Uint8Array.from(
    readFileSync(new URL('../wasm/layout/schemweave_bg.wasm', import.meta.url)),
  )
  initSync({ module: wasmBytes.buffer })
  const request = {
    graph: {
      nodes: [
        {
          id: 1,
          width: 40,
          height: 30,
          cycle_breaker: false,
          // Two distinct valid ports intentionally occupy the same physical
          // point. Their independent collectors would overlap exactly, which
          // cannot satisfy the hard no-contact bundle contract.
          ports: [
            { id: 0, side: 'east' as const, offset: 15 },
            { id: 1, side: 'east' as const, offset: 15 },
          ],
        },
        {
          id: 2,
          width: 40,
          height: 30,
          cycle_breaker: false,
          ports: [
            { id: 0, side: 'west' as const, offset: 10 },
            { id: 1, side: 'west' as const, offset: 20 },
          ],
        },
      ],
      edges: [
        {
          id: 10,
          source: { node: 1, port: 0 },
          target: { node: 2, port: 0 },
          net: 10,
          participates_in_ranking: true,
        },
        {
          id: 11,
          source: { node: 1, port: 1 },
          target: { node: 2, port: 1 },
          // The two routes are one electrical net, so the bundle-free engine
          // may legitimately share their trunk even though two independent
          // collectors cannot occupy the same boundary geometry.
          net: 10,
          participates_in_ranking: true,
        },
      ],
    },
    constraints: {
      inputs: [1],
      outputs: [2],
      boundary_bundles: [
        {
          id: 0,
          endpoint: { node: 1, port: 0 },
          width: 1,
          members: [{ edge: 10, slots: [0] }],
        },
        {
          id: 1,
          endpoint: { node: 1, port: 1 },
          width: 1,
          members: [{ edge: 11, slots: [0] }],
        },
      ],
    },
  } satisfies SchemWeaveLayoutRequest

  let boundaryError: unknown
  try {
    wasmLayoutJson(JSON.stringify(request))
  } catch (error) {
    boundaryError = error
  }
  expect(boundaryError).toBeInstanceOf(Error)
  expect((boundaryError as Error).name).toBe(
    SCHEMWEAVE_BOUNDARY_BUNDLE_ERROR_NAME,
  )
  expect((boundaryError as Error).message).toBe(
    'boundary bundle geometry does not satisfy the hard readability contract',
  )

  const layoutJson = vi.fn(wasmLayoutJson)
  expect(runSchemWeaveRequest(
    { layout_json: layoutJson },
    { id: 20, request },
  )).toMatchObject({
    id: 20,
    ok: true,
    fallback: SCHEMWEAVE_BOUNDARY_BUNDLE_FALLBACK,
    result: {
      nodes: expect.any(Array),
      edges: expect.any(Array),
      width: expect.any(Number),
      height: expect.any(Number),
    },
  })
  expect(layoutJson).toHaveBeenCalledTimes(2)
  expect(
    JSON.parse(layoutJson.mock.calls[0][0]).constraints.boundary_bundles,
  ).toHaveLength(2)
  expect(
    JSON.parse(layoutJson.mock.calls[1][0]).constraints,
  ).toEqual({
    inputs: [1],
    outputs: [2],
  })

  expect(runSchemWeaveRequest(
    { layout_json: layoutJson },
    { id: 21, request: structuredClone(request) },
  )).toMatchObject({
    id: 21,
    ok: true,
    fallback: SCHEMWEAVE_BOUNDARY_BUNDLE_FALLBACK,
  })
  expect(layoutJson).toHaveBeenCalledTimes(4)
})
