import type { DesignFile } from '../types'
import type { ValidatedSynthesis } from './yosysScript'

const locationComment = /^(\s*)\/\*\s*([^\s:*][^:*]*):(\d+):(\d+)\s*\*\/\s*$/

export interface VhdlTranslation {
  verilog: string
  log: string
}

export interface VhdlWorkerRequest {
  files: DesignFile[]
  top: string
}

export type VhdlWorkerResponse =
  | { ok: true; result: VhdlTranslation }
  | { ok: false; error: string; kind?: 'load'; log?: string }

export function rewriteVhdlSourceLocations(verilog: string): {
  verilog: string
  rewritten: number
} {
  let rewritten = 0
  const lines = verilog.split('\n').map((line) => {
    const match = locationComment.exec(line)
    if (!match) return line
    rewritten += 1
    return `\`line ${match[3]} "${match[2]}" 0`
  })
  return { verilog: lines.join('\n'), rewritten }
}

export function translatedYosysInput(
  input: ValidatedSynthesis,
  translation: VhdlTranslation,
): ValidatedSynthesis {
  if (input.language !== 'vhdl' || !input.top) {
    throw new Error('expected validated VHDL input with an explicit top entity')
  }
  const { verilog, rewritten } = rewriteVhdlSourceLocations(translation.verilog)
  if (rewritten === 0) {
    throw new Error('GHDL emitted no VHDL source locations')
  }
  return {
    ...input,
    files: [{ name: `ghdl-${input.top.toLowerCase()}.v`, content: verilog }],
    language: 'verilog',
  }
}
