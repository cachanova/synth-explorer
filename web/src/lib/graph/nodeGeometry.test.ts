import { describe, expect, it } from 'vitest'
import type { GraphNode } from '../../types'
import { controlRoleForPin, nodeDimensions } from './nodeGeometry'

const node = (id: number, cellType: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  id,
  kind: 'cell',
  name: `u${id}`,
  cell_type: cellType,
  ...extra,
})

describe('schematic layout sizing', () => {
  it('classifies vendor memory clock pin spellings as clocks', () => {
    for (const pin of ['WCLK', 'RCLK', 'CLKA', 'CLKB', 'CLKARDCLK']) {
      expect(controlRoleForPin(pin)).toBe('clock')
    }
  })

  it('gives gates compact schematic proportions', () => {
    expect(nodeDimensions(node(1, '$_AND_'))).toEqual({ width: 76, height: 52 })
  })

  it('gives carry and DSP primitives distinct hard-block proportions', () => {
    expect(nodeDimensions(node(1, 'CARRY8'))).toEqual({ width: 98, height: 58 })
    expect(nodeDimensions(node(2, 'DSP48E2'))).toEqual({ width: 112, height: 62 })
    expect(nodeDimensions(node(3, 'SB_MAC16'))).toEqual({ width: 112, height: 62 })
  })

  it('sizes Vivado implementation cells from the readable RTL-facing name', () => {
    expect(nodeDimensions(node(1, 'LUT1', {
      name: 'one_hot_OBUF[23]_inst_i_6_2',
    }))).toEqual({ width: 103, height: 54 })
  })

  it('reserves register space for compact control-net labels', () => {
    const plain = nodeDimensions(node(1, 'FDRE'))
    const controlledNode = node(2, 'FDRE')
    controlledNode.controls = [
      { role: 'clock', pin: 'C', net_name: 'sys_clk', driver_id: 8, fanout: 2 },
      { role: 'reset', pin: 'R', net_name: 'rst_n', driver_id: 9, fanout: 2 },
    ]
    const controlled = nodeDimensions(controlledNode)
    expect(controlled.height).toBeGreaterThan(plain.height)
    expect(controlled.width).toBeGreaterThanOrEqual(plain.width)
  })

  it('adds a badge row and width for grouped vector nodes', () => {
    const plain = nodeDimensions(node(1, 'FDRE'))
    const grouped = nodeDimensions(
      node(2, 'FDRE', { width: 8, members: [1, 2, 3, 4, 5, 6, 7, 8] }),
    )
    // A grouped node reserves an extra row for its "×N" badge.
    expect(grouped.height).toBe(plain.height + 14)
    expect(grouped.width).toBeGreaterThanOrEqual(plain.width)
    // A single-bit node (width 1) is not treated as grouped.
    expect(nodeDimensions(node(3, 'FDRE', { width: 1 }))).toEqual(plain)
  })

  it('reserves one row for every label-connected control', () => {
    const controlledNode = node(2, 'FDRE', {
      controls: [
        { role: 'clock', pin: 'C', net_name: 'clk', driver_id: 8, fanout: 2 },
        { role: 'reset', pin: 'R', net_name: 'rst', driver_id: 9, fanout: 2 },
        { role: 'enable', pin: 'CE', net_name: 'ce', driver_id: 10, fanout: 2 },
        { role: 'set', pin: 'S', net_name: 'set', driver_id: 11, fanout: 2 },
      ],
    })

    expect(nodeDimensions(controlledNode).height).toBe(58 + 4 * 13)

    const controlledSrl = node(3, 'SRL16E', {
      register: false,
      seq: true,
      controls: [
        { role: 'clock', pin: 'CLK', net_name: 'clk', driver_id: 8, fanout: 2 },
      ],
    })
    expect(nodeDimensions(controlledSrl).height).toBe(62 + 13)
  })

  it('reserves one row for a compact multi-net grouped control', () => {
    const groupedMemory = node(4, '$mem_v2', {
      member_count: 1_024,
      controls: [
        { role: 'clock', pin: 'CLK', net_name: 'clk', driver_id: 8, fanout: 1_024 },
        {
          role: 'enable',
          pin: 'EN',
          net_name: 'row_en[0]',
          driver_id: 9,
          driver_ids: Array.from({ length: 64 }, (_, index) => index + 9),
          net_count: 64,
          fanout: 1_024,
        },
      ],
    })

    expect(nodeDimensions(groupedMemory).height).toBe(62 + 2 * 13 + 14)
  })

})
