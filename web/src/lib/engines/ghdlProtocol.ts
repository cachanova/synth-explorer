import type { DesignFile } from '../../types'

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
