import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 32,
    getVirtualItems: () =>
      Array.from({ length: Math.min(count, 20) }, (_, index) => ({
        index,
        key: index,
        start: index * 32,
      })),
    measureElement: vi.fn(),
    scrollToIndex: vi.fn(),
  }),
}))

import { VirtualTable } from './VirtualTable'

describe('VirtualTable', () => {
  it('mounts only the virtual window for a very large complete result set', () => {
    const renderRow = vi.fn((index: number) => (
      <tr role="row">
        <td role="cell">row-{index + 1}</td>
      </tr>
    ))

    const markup = renderToStaticMarkup(
      <VirtualTable
        rowCount={50_000}
        columnWidths={['100%']}
        header={<th role="columnheader">Result</th>}
        renderRow={renderRow}
      />,
    )

    expect(renderRow).toHaveBeenCalledTimes(20)
    expect(markup).toContain('row-20')
    expect(markup).not.toContain('row-21')
    expect(markup).toContain('height:1600000px')
    expect(markup.match(/role="table"/g)).toHaveLength(1)
    expect(markup.match(/role="rowgroup"/g)).toHaveLength(2)
    expect(markup).toContain('role="columnheader"')
    expect(markup).toContain('role="cell"')
  })
})
