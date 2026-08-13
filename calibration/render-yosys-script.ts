import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { buildYosysScript, validateSynthesisRequest } from '../web/src/lib/synthesis/yosysScript'
import type { SynthesizeRequest } from '../web/src/types'
import {
  renderCalibrationScript,
  type CalibrationRenderRequest,
} from './xilinx-matrix'

async function main() {
  const requestPath = process.argv[2]
  if (!requestPath) throw new Error('usage: render-yosys-script.ts <request.json>')

  const parsed = JSON.parse(await readFile(requestPath, 'utf8')) as CalibrationRenderRequest | SynthesizeRequest
  process.stdout.write('request' in parsed
    ? renderCalibrationScript(parsed)
    : buildYosysScript(validateSynthesisRequest(parsed), 'map'))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
