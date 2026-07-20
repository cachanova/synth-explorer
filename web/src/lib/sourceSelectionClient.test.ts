import { beforeEach, describe, expect, it, vi } from 'vitest'

const { queryAnalysis } = vi.hoisted(() => ({ queryAnalysis: vi.fn() }))
vi.mock('./analysisClient', () => ({ queryAnalysis }))

import { analyzeSourceInBrowser } from './sourceSelectionClient'

describe('source selection analysis client', () => {
  beforeEach(() => queryAnalysis.mockReset())

  it('sends only the bounded source-selection query to the analysis worker', async () => {
    const response = {
      status: 'mapped',
      control: false,
      directIds: [1],
      graph: { nodes: [], edges: [], truncated: false },
    }
    queryAnalysis.mockResolvedValue(response)

    await expect(
      analyzeSourceInBrowser(
        'design',
        { file: 'top.sv', startLine: 4, endLine: 5 },
        { maxNodes: 400, hideControl: true, hideConst: false, groupVectors: true },
      ),
    ).resolves.toBe(response)

    expect(queryAnalysis).toHaveBeenCalledWith('source', {
      file: 'top.sv',
      start_line: 4,
      end_line: 5,
      max_nodes: 400,
      hide_control: true,
      hide_const: false,
      group_vectors: true,
    })
  })

  it('rejects an already-aborted request without changing the worker contract', async () => {
    queryAnalysis.mockResolvedValue({})
    const controller = new AbortController()
    controller.abort()

    await expect(
      analyzeSourceInBrowser(
        'design',
        { file: 'top.sv', startLine: 4, endLine: 4 },
        { maxNodes: 400, hideControl: true, hideConst: true, groupVectors: false },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})
