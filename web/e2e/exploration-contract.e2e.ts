import { expect, test, type APIRequestContext } from '@playwright/test'
import { analyzeSourceSelection, prepareExploration } from '../src/lib/exploration'
import type { ExplorationSnapshot, SourceSelectionResult } from '../src/types'

const selectionOptions = {
  maxNodes: 400,
  hideControl: true,
  hideConst: true,
  groupVectors: false,
}

async function synthesize(
  request: APIRequestContext,
  body: { files: Array<{ name: string; content: string }>; top: string; mode: string },
) {
  const response = await request.post('/api/synthesize', {
    data: { ...body, tool: 'yosys' },
  })
  if (!response.ok()) throw new Error(`synthesis failed: ${await response.text()}`)
  return await response.json() as { design_id: string }
}

function sourceLine(source: string, text: string): number {
  const index = source.split(/\r?\n/).findIndex((line) => line.trim() === text)
  if (index < 0) throw new Error(`missing source line ${JSON.stringify(text)}`)
  return index + 1
}

function rootIds(result: SourceSelectionResult): Set<number> {
  return new Set(
    result.graph.nodes.filter((node) => node.is_root === true).map((node) => node.id),
  )
}

test('real synthesis snapshot narrows procedural assignments in the TypeScript selector', async ({
  request,
}) => {
  const catalogResponse = await request.get('/api/examples')
  expect(catalogResponse.ok()).toBe(true)
  const catalog = await catalogResponse.json() as {
    examples: Array<{
      name: string
      top: string
      files: Array<{ name: string; content: string }>
    }>
  }
  const example = catalog.examples.find((candidate) => candidate.name === 'inferred_fifo')
  if (!example) throw new Error('inferred_fifo example is missing')
  const source = example.files[0].content
  const design = await synthesize(request, {
    files: example.files,
    top: example.top,
    mode: 'rtl',
  })
  const [snapshotResponse, endpointsResponse] = await Promise.all([
    request.get(`/api/design/${design.design_id}/exploration`),
    request.get(`/api/design/${design.design_id}/endpoints`),
  ])
  if (!snapshotResponse.ok()) throw new Error(`snapshot failed: ${await snapshotResponse.text()}`)
  if (!endpointsResponse.ok()) throw new Error(`endpoints failed: ${await endpointsResponse.text()}`)
  const snapshot = await snapshotResponse.json() as ExplorationSnapshot
  const endpoints = await endpointsResponse.json() as {
    registers: Array<{ name: string; bits: Array<{ node_id: number }> }>
  }
  const registerIds = (name: string) => new Set(
    endpoints.registers
      .find((register) => register.name === name)
      ?.bits.map((bit) => bit.node_id) ?? [],
  )
  const writePointerIds = registerIds('write_pointer')
  const countIds = registerIds('count')
  expect(writePointerIds.size).toBeGreaterThan(0)
  expect(countIds.size).toBeGreaterThan(0)

  const prepared = prepareExploration(snapshot)
  const writePointerLine = sourceLine(source, "write_pointer <= '0;")
  const single = analyzeSourceSelection(
    prepared,
    example.files[0].name,
    writePointerLine,
    writePointerLine,
    selectionOptions,
  )
  const singleRoots = rootIds(single)
  expect([...singleRoots].some((id) => writePointerIds.has(id))).toBe(true)
  expect([...singleRoots].every((id) => !countIds.has(id))).toBe(true)

  const resetLine = sourceLine(source, 'if (rst) begin')
  const countLine = sourceLine(source, "count <= '0;")
  const block = analyzeSourceSelection(
    prepared,
    example.files[0].name,
    resetLine,
    countLine,
    selectionOptions,
  )
  const blockRoots = rootIds(block)
  expect([...blockRoots].some((id) => writePointerIds.has(id))).toBe(true)
  expect([...blockRoots].some((id) => countIds.has(id))).toBe(true)
})

test('real synthesis snapshot preserves registered-output expansion and assignment direction', async ({
  request,
}) => {
  const source = `module selection_contract (
  input logic clk,
  input logic a,
  input logic b,
  input logic c,
  output logic y,
  output logic out
);
  logic x;
  always_ff @(posedge clk) y <= a & b;
  assign x = a & b;
  assign out = x | c;
endmodule
`
  const file = 'selection_contract.sv'
  const design = await synthesize(request, {
    files: [{ name: file, content: source }],
    top: 'selection_contract',
    mode: 'xilinx',
  })
  const snapshotResponse = await request.get(`/api/design/${design.design_id}/exploration`)
  if (!snapshotResponse.ok()) throw new Error(`snapshot failed: ${await snapshotResponse.text()}`)
  const prepared = prepareExploration(await snapshotResponse.json() as ExplorationSnapshot)

  const outputLine = sourceLine(source, 'output logic y,')
  const output = analyzeSourceSelection(
    prepared,
    file,
    outputLine,
    outputLine,
    selectionOptions,
  )
  expect(output.status).toBe('mapped')
  expect(output.graph.nodes.some((node) => node.name === 'y')).toBe(true)
  expect(output.graph.nodes.some((node) => node.register === true)).toBe(true)
  expect(output.graph.nodes.some((node) => node.name === 'a')).toBe(true)
  expect(output.graph.nodes.some((node) => node.name === 'b')).toBe(true)
  expect(output.graph.nodes.some((node) => node.cell_type?.startsWith('LUT'))).toBe(true)

  const assignmentLine = sourceLine(source, 'assign x = a & b;')
  const assignment = analyzeSourceSelection(
    prepared,
    file,
    assignmentLine,
    assignmentLine,
    selectionOptions,
  )
  expect(assignment.status).toBe('mapped')
  expect(assignment.graph.nodes.some((node) => node.name === 'a')).toBe(true)
  expect(assignment.graph.nodes.some((node) => node.name === 'b')).toBe(true)
  expect(assignment.graph.nodes.every((node) => node.name !== 'c')).toBe(true)
  expect(assignment.graph.nodes.every((node) => node.name !== 'out')).toBe(true)
})
