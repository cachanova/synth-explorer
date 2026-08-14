import type { ControlRole, GraphNode } from '../../types'
import { groupBadgeText, nodeLabel, nodeSublabel } from './prettyType'
import { controlCaption, controlsFor, symbolKind } from './symbols'

const CHAR_WIDTH = 7.2
const PAD_X = 24

function textWidth(node: GraphNode): number {
  const label = nodeLabel(node)
  const name = nodeSublabel(node) ?? ''
  const longest = Math.max(label.length, Math.min(name.length, 22))
  return Math.round(longest * CHAR_WIDTH + PAD_X)
}

export function nodeDimensions(node: GraphNode): { width: number; height: number } {
  const kind = symbolKind(node)
  const contentWidth = textWidth(node)

  const base = (() => {
    switch (kind) {
      case 'and':
      case 'nand':
      case 'or':
      case 'nor':
      case 'xor':
      case 'xnor':
        return { width: Math.max(76, contentWidth), height: 52 }
      case 'not':
      case 'buf':
        return { width: Math.max(62, contentWidth), height: 46 }
      case 'mux':
      case 'nmux':
        return { width: Math.max(70, contentWidth), height: 58 }
      case 'port-in':
      case 'port-out':
        return { width: Math.max(74, contentWidth), height: 34 }
      case 'reg':
      case 'latch':
        return { width: Math.max(92, contentWidth), height: 58 }
      case 'lut':
        return { width: Math.max(78, contentWidth), height: 54 }
      case 'carry':
        return { width: Math.max(98, contentWidth), height: 58 }
      case 'dsp':
        return { width: Math.max(112, contentWidth), height: 62 }
      case 'arith':
        return { width: Math.max(72, contentWidth), height: 54 }
      case 'memory':
        return { width: Math.max(112, contentWidth), height: 62 }
      case 'const':
        return { width: Math.max(58, contentWidth), height: 32 }
      case 'box':
        return { width: Math.max(96, contentWidth), height: 58 }
    }
  })()
  const controls = controlsFor(node)
  let width = base.width
  let height = base.height
  if (controls.length > 0) {
    const controlWidth = controls.reduce(
      (max, control) => Math.max(max, controlCaption(control).length * 6.2 + PAD_X),
      0,
    )
    width = Math.max(width, Math.round(controlWidth))
    height = base.height + controls.length * 13
  }
  // Reserve a row and width only when a separate "×N" member badge renders.
  const badge = groupBadgeText(node)
  if (badge) {
    width = Math.max(width, Math.round(badge.length * CHAR_WIDTH + PAD_X))
    height += 14
  }
  return { width, height }
}

export const REG_BODY_HEIGHT = 58
export const REG_DATA_IN_Y_FRAC = 0.32
export const REG_DATA_OUT_Y_FRAC = 0.5
export const REG_CLOCK_Y_FRAC = 0.72
export const REG_RESET_Y_FRAC = 0.5
export const REG_SET_Y_FRAC = 0.14
export const REG_ENABLE_Y_FRAC = 0.88
export const PIN_ROW_HEIGHT = 14
export const CONTROL_ROW_HEIGHT = 13

/** Fixed schematic position for a register's non-data input pin. */
export function registerControlYFraction(role: ControlRole): number {
  switch (role) {
    case 'clock':
      return REG_CLOCK_Y_FRAC
    case 'reset':
      return REG_RESET_Y_FRAC
    case 'set':
      return REG_SET_Y_FRAC
    case 'enable':
      return REG_ENABLE_Y_FRAC
    case 'other':
      return 0.6
  }
}

export function controlRoleForPin(pin: string): ControlRole {
  const upper = pin.toUpperCase()
  if (upper.startsWith('CLK') || upper.endsWith('CLK')) return 'clock'
  switch (upper) {
    case 'CLK':
    case 'C':
      return 'clock'
    case 'R':
    case 'RST':
    case 'ARST':
    case 'SRST':
    case 'CLR':
    case 'LSR':
      return 'reset'
    case 'S':
    case 'SET':
    case 'PRE':
    case 'SR':
      return 'set'
    case 'E':
    case 'EN':
    case 'CE':
    case 'G':
    case 'GE':
      return 'enable'
    default:
      return 'other'
  }
}

/** True when a register input names a physical clock/reset/set/enable pin. */
export function isRegisterControlPin(pin: string): boolean {
  return controlRoleForPin(pin) !== 'other'
}

export function canonicalPinNames(pins: Iterable<string>): string[] {
  return [...new Set(pins)].sort()
}
