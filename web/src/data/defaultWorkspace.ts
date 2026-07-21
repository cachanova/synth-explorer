import type { DesignFile, Mode } from '../types'
import { flagsForVivadoChange } from '../lib/flagRegistry'
import defaultSource from './default.sv?raw'

export const DEFAULT_FILE: DesignFile = {
  name: 'design.sv',
  content: defaultSource,
}

export function defaultWorkspace() {
  return {
    files: [{ ...DEFAULT_FILE }],
    activeFileName: DEFAULT_FILE.name,
    top: '',
    mode: 'gates' as Mode,
    extraArgs: '',
    vivadoExtraArgs: flagsForVivadoChange(''),
  }
}
