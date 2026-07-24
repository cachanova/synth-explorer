import { LocalSynthesisError } from '../synthesisError'
import {
  VivadoBridgeError,
  synthesizeWithVivadoBridge,
} from '../vivadoBridge'
import type { SynthEngine } from './types'
import { runVivadoNormalizer, runYosys } from './yosysWorkerClient'

export const vivadoEngine: SynthEngine = {
  async produce({ input, yosysInput, ghdlLog }, signal) {
    const source = await runYosys(
      { ...yosysInput, tool: undefined, mode: 'rtl', extraArgs: [] },
      'map',
      signal,
    )
    try {
      // Vivado consumes the submitted sources directly: it reads VHDL
      // natively, so only the Yosys RTL snapshot uses the GHDL translation.
      const vivado = await synthesizeWithVivadoBridge(
        {
          files: input.files,
          top: input.top!,
          target: input.target!,
          extraArgs: input.extraArgs,
        },
        signal,
      )
      let output = await runVivadoNormalizer(
        vivado.netlist,
        vivado.top,
        source.sourceNetlistJson,
        signal,
      )
      output = {
        ...output,
        vivadoTiming: vivado.timing,
        log: joinLogs(
          ghdlLog ? `GHDL:\n${ghdlLog}` : '',
          `Vivado:\n${vivado.log}`,
          `Yosys normalizer:\n${output.log}`,
        ),
      }
      return { output, memoriesAbstracted: false }
    } catch (error) {
      if (error instanceof VivadoBridgeError) {
        throw new LocalSynthesisError(
          error.message,
          error.log ?? '',
          error.status === 0 ? 'bridge' : undefined,
        )
      }
      throw error
    }
  },
}

function joinLogs(...logs: string[]): string {
  return logs.filter(Boolean).join('\n\n')
}
