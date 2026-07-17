import { readFile } from 'node:fs/promises'
import { buildYosysScript, validateSynthesisRequest } from '../web/src/lib/yosysScript'
import type { SynthesizeRequest } from '../web/src/types'

async function main() {
  const requestPath = process.argv[2]
  if (!requestPath) throw new Error('usage: render-yosys-script.ts <request.json>')

  const request = JSON.parse(await readFile(requestPath, 'utf8')) as SynthesizeRequest
  process.stdout.write(buildYosysScript(validateSynthesisRequest(request), 'map'))
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
