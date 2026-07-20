import type { DesignFile, Mode, SynthesizeRequest } from '../types'
import {
  isVerilogCompilationUnit,
  isVhdlSource,
  validateSourceFilename,
} from './sourceFiles'

export const YOSYS_VERSION = '0.67-2d1509d1b'
// Upstream version plus SHA-256 prefixes for ghdl-synth.wasm and the compiled
// standard-library archive. Either artifact can change synthesis output.
export const GHDL_VERSION = '5.0.1-37ad91899ea3-245664fc-2cdbaa33'
export const YOSYS_CACHE_SCHEMA = 2

export type MemoryHandling = 'map' | 'abstract'
export type SourceLanguage = 'verilog' | 'vhdl'

export interface ValidatedSynthesis {
  files: DesignFile[]
  top?: string
  tool?: 'vivado'
  mode: Mode
  extraArgs: string[]
  language: SourceLanguage
  target?: string
  vivadoFamily?: string
  vivadoSpeed?: string
  vivadoVersion?: string
}

export function validateSynthesisRequest(
  request: SynthesizeRequest,
): ValidatedSynthesis {
  if (request.files.length === 0) {
    throw new Error('at least one source file is required')
  }
  for (const file of request.files) validateSourceFilename(file.name)
  const languages = new Set(
    request.files.map((file) => (isVhdlSource(file.name) ? 'vhdl' : 'verilog')),
  )
  if (languages.size !== 1) {
    throw new Error('mixed Verilog and VHDL workspaces are not supported')
  }
  const language = languages.values().next().value as SourceLanguage
  // VHDL analysis is order-sensitive (packages before their users), so retain
  // the tab/import order. Verilog keeps its historical canonical ordering.
  const files = language === 'vhdl'
    ? [...request.files]
    : [...request.files].sort((left, right) => left.name.localeCompare(right.name))
  if (language === 'verilog' && !files.some((file) => isVerilogCompilationUnit(file.name))) {
    throw new Error('at least one .v or .sv source file is required')
  }
  const top = request.top?.trim() || undefined
  if (top && !/^[A-Za-z0-9_$]+$/.test(top)) {
    throw new Error(`invalid top module name: ${top}`)
  }
  if (language === 'vhdl' && !top) {
    throw new Error('VHDL synthesis requires an explicit top entity')
  }
  const extraArgs = parseExtraArgs(request.extra_args)
  validateNarrowCarry(request.mode, extraArgs)
  const tool = request.tool ?? 'yosys'
  if (tool === 'vivado') {
    if (!top) throw new Error('Vivado synthesis requires an explicit top module or entity')
    if (!request.target || !validVivadoField(request.target, 128)) {
      throw new Error('Vivado synthesis requires a valid installed target')
    }
    if (!request.vivado_family || !validVivadoField(request.vivado_family, 128)) {
      throw new Error('Vivado synthesis requires the target family')
    }
    if (!request.vivado_speed || !validVivadoField(request.vivado_speed, 32)) {
      throw new Error('Vivado synthesis requires the target speed grade')
    }
    if (!request.vivado_version?.trim()) {
      throw new Error('Vivado synthesis requires the paired tool version')
    }
    if (extraArgs.some((arg) => arg === '-top' || arg === '-part' || arg.startsWith('-top=') || arg.startsWith('-part='))) {
      throw new Error('Vivado top and part must use the dedicated fields')
    }
  }
  return {
    files,
    top,
    tool: tool === 'vivado' ? 'vivado' : undefined,
    mode: request.mode,
    extraArgs,
    language,
    target: tool === 'vivado' ? request.target : undefined,
    vivadoFamily: tool === 'vivado' ? request.vivado_family : undefined,
    vivadoSpeed: tool === 'vivado' ? request.vivado_speed : undefined,
    vivadoVersion: tool === 'vivado' ? request.vivado_version : undefined,
  }
}

export function buildYosysScript(
  input: ValidatedSynthesis,
  memory: MemoryHandling = 'map',
): string {
  let script = readVerilog(input)
  script += `hierarchy ${topArgs(input.top)}\nproc\nwrite_json source-netlist.json\ndesign -reset\n`
  script += readVerilog(input)
  const extra = input.extraArgs.length ? ` ${input.extraArgs.join(' ')}` : ''

  switch (input.mode) {
    case 'rtl':
      script += `prep ${topArgs(input.top)}${extra}\nflatten\n`
      break
    case 'gates':
    case 'lut4':
    case 'lut6': {
      const lut = input.mode === 'lut4' ? ' -lut 4' : input.mode === 'lut6' ? ' -lut 6' : ''
      if (memory === 'map') {
        script += `synth ${topArgs(input.top)} -flatten${lut}${extra}\n`
      } else {
        script += `synth ${topArgs(input.top)} -flatten${lut}${extra} -run begin:fine\n`
        script += 'opt -fast -full\ntechmap\nopt -fast\n'
        if (!input.extraArgs.includes('-noabc')) {
          script += lut ? `abc${lut}\n` : 'abc\n'
          script += 'opt -fast\n'
        }
      }
      break
    }
    case 'ice40':
      if (!input.top) script += 'hierarchy -auto-top\n'
      script += `synth_ice40 ${topOnly(input.top)} -flatten${extra}\n`
      break
    case 'ecp5':
      if (!input.top) script += 'hierarchy -auto-top\n'
      script += `synth_ecp5 ${topOnly(input.top)} -flatten${extra}\n`
      break
    case 'xilinx': {
      if (!input.top) script += 'hierarchy -auto-top\n'
      const { width, args } = splitNarrowCarry(input.extraArgs)
      const xilinxExtra = args.length ? ` ${args.join(' ')}` : ''
      const synth = `synth_xilinx ${topOnly(input.top)} -flatten${xilinxExtra}`
      if (width == null) {
        script += `${synth}\n`
      } else {
        script += `${synth} -run begin:fine\n`
        script += `select -set narrow_alu t:$alu r:Y_WIDTH<=${width} %i\n`
        script += 'techmap @narrow_alu\n'
        script += `select -set narrow_lcu t:$lcu r:WIDTH<=${width} %i\n`
        script += 'techmap @narrow_lcu\n'
        script += `${synth} -run fine:\n`
      }
      break
    }
  }
  return `${script}write_json netlist.json\n`
}

export function defaultDelayProfile(input: ValidatedSynthesis): string {
  if (input.tool === 'vivado') {
    const family = input.vivadoFamily?.toLowerCase() ?? ''
    if (family.includes('uplus')) return 'ultrascale_plus'
    if (family.endsWith('u')) return 'ultrascale'
    if (family.endsWith('7') || family.endsWith('7l') || family === 'zynq') {
      return 'series7'
    }
    return 'generic'
  }
  if (input.mode === 'ice40' || input.mode === 'ecp5') return input.mode
  if (input.mode !== 'xilinx') return 'generic'
  const familyIndex = input.extraArgs.indexOf('-family')
  const family = familyIndex >= 0 ? input.extraArgs[familyIndex + 1]?.toLowerCase() : undefined
  if (family === 'xcup') return 'ultrascale_plus'
  if (family === 'xcu') return 'ultrascale'
  return 'series7'
}

export function buildVivadoNormalizeScript(top: string): string {
  if (!/^[A-Za-z0-9_$]+$/.test(top)) throw new Error(`invalid top module name: ${top}`)
  return (
    'read_verilog -lib /share/xilinx/cells_sim.v\n' +
    'read_verilog -lib /share/xilinx/cells_xtra.v\n' +
    'read_verilog vivado-netlist.v\n' +
    `hierarchy -check -top ${top}\n` +
    'flatten\nselect -clear\n' +
    `select ${top}\n` +
    'write_json -selected netlist.json\n'
  )
}

function validVivadoField(value: string, limit: number): boolean {
  return value.length <= limit && /^[A-Za-z0-9_.-]+$/.test(value)
}

function readVerilog(input: ValidatedSynthesis): string {
  if (input.language !== 'verilog') {
    throw new Error('Yosys requires VHDL to be translated before script generation')
  }
  const compilationUnits = input.files
    .filter((file) => isVerilogCompilationUnit(file.name))
    .map((file) => file.name)
  return `read_verilog -sv ${compilationUnits.join(' ')}\n`
}

function topArgs(top?: string): string {
  return top ? `-top ${top}` : '-auto-top'
}

function topOnly(top?: string): string {
  return top ? `-top ${top}` : ''
}

function parseExtraArgs(extraArgs?: string): string[] {
  if (!extraArgs) return []
  return extraArgs.trim().split(/\s+/).map((token) => {
    if (!/^[A-Za-z0-9_+=.,:-]+$/.test(token)) {
      throw new Error(`invalid extra_args token: ${token}`)
    }
    return token
  })
}

function validateNarrowCarry(mode: Mode, args: string[]) {
  const indices = args.flatMap((arg, index) => (arg === '-narrowcarry' ? [index] : []))
  if (indices.length === 0) return
  if (mode !== 'xilinx') {
    throw new Error('-narrowcarry is only supported in xilinx mode')
  }
  if (indices.length > 1) {
    throw new Error('-narrowcarry may only be given once')
  }
  if (args.includes('-run')) {
    throw new Error(
      '-narrowcarry cannot be combined with -run: a caller-supplied pipeline slice runs as one untouched invocation',
    )
  }
  const width = Number(args[indices[0] + 1])
  if (!Number.isInteger(width) || width < 1 || width > 64) {
    throw new Error('-narrowcarry takes a width between 1 and 64')
  }
}

function splitNarrowCarry(args: string[]): { width?: number; args: string[] } {
  const index = args.indexOf('-narrowcarry')
  if (index < 0) return { args }
  return {
    width: Number(args[index + 1]),
    args: [...args.slice(0, index), ...args.slice(index + 2)],
  }
}
