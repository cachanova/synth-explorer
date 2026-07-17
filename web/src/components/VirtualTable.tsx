import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useRef, type ReactNode } from 'react'

export function VirtualTable({
  rowCount,
  columnWidths,
  header,
  renderRow,
  getRowKey,
  estimateRowHeight = 32,
  resetKey,
}: {
  rowCount: number
  columnWidths: string[]
  header: ReactNode
  renderRow: (index: number) => ReactNode
  getRowKey?: (index: number) => string | number
  estimateRowHeight?: number
  resetKey?: unknown
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const rows = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateRowHeight,
    getItemKey: getRowKey,
    overscan: 12,
  })
  const previousResetKey = useRef(resetKey)

  useEffect(() => {
    if (Object.is(previousResetKey.current, resetKey)) return
    previousResetKey.current = resetKey
    rows.scrollToIndex(0)
  })

  const columns = () => (
    <colgroup>
      {columnWidths.map((width, index) => (
        <col key={index} style={{ width }} />
      ))}
    </colgroup>
  )

  return (
    <div
      ref={scrollRef}
      className="virtual-table-scroll"
      role="table"
    >
      <table className="grid virtual-grid-header" role="presentation">
        {columns()}
        <thead role="rowgroup">
          <tr role="row">{header}</tr>
        </thead>
      </table>
      <div
        className="virtual-table-spacer"
        role="rowgroup"
        style={{ height: rows.getTotalSize() }}
      >
        {rows.getVirtualItems().map((virtualRow) => (
          <div
            key={virtualRow.key}
            ref={rows.measureElement}
            data-index={virtualRow.index}
            className="virtual-table-item"
            style={{ transform: `translateY(${virtualRow.start}px)` }}
          >
            <table className="grid virtual-grid-row" role="presentation">
              {columns()}
              <tbody>{renderRow(virtualRow.index)}</tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  )
}
