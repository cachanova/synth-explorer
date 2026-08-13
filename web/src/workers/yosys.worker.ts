/// <reference lib="webworker" />

import {
  ConsoleStdout,
  Directory,
  File,
  OpenFile,
  PreopenDirectory,
  WASI,
} from '@bjorn3/browser_wasi_shim'
import type {
  YosysWorkerRequest,
  YosysWorkerResponse,
  YosysWorkerResult,
} from '../lib/engines/yosysProtocol'
import { EngineLoadError, lazyLoad } from '../lib/synthesis/engineLoad'
import { unpackTar } from '../lib/launcher/tar'
import { buildVivadoNormalizeScript, buildYosysScript, YOSYS_VERSION } from '../lib/synthesis/yosysScript'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
self.onmessage = (event: MessageEvent<YosysWorkerRequest>) => {
  void run(event.data).then(
    (result) => respond({ ok: true, result }),
    (error) =>
      respond({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        kind: error instanceof EngineLoadError ? 'load' : undefined,
        log: error instanceof YosysFailure ? error.log : undefined,
      }),
  )
}

const loadModule = lazyLoad('failed to load Yosys', async () => {
  const response = await fetch(`/yosys/yosys.wasm?v=${YOSYS_VERSION}`)
  if (!response.ok) throw new Error(`status ${response.status}`)
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!contentType.includes('application/wasm')) {
    throw new Error(`expected application/wasm, got ${contentType || 'no content type'}`)
  }
  if (typeof WebAssembly.compileStreaming === 'function') {
    return WebAssembly.compileStreaming(response)
  }
  return WebAssembly.compile(await response.arrayBuffer())
})

const loadShare = lazyLoad('failed to load Yosys resources', async () => {
  const response = await fetch(`/yosys/share.tar.gz?v=${YOSYS_VERSION}`)
  if (!response.ok) throw new Error(`status ${response.status}`)
  // Some static hosts (including Vite preview) serve .gz files with
  // Content-Encoding: gzip. Fetch has already decoded those response bytes;
  // only decompress hosts that serve the archive as an opaque gzip file.
  let buffer: ArrayBuffer
  if (response.headers.get('Content-Encoding')?.includes('gzip')) {
    buffer = await response.arrayBuffer()
  } else {
    if (!response.body) throw new Error('response has no body')
    buffer = await new Response(
      response.body.pipeThrough(new DecompressionStream('gzip')),
    ).arrayBuffer()
  }
  return unpackTar(new Uint8Array(buffer))
})

// Warm the caches as soon as the worker starts; failures surface on first use.
void loadModule().catch(() => {})
void loadShare().catch(() => {})

async function run(request: YosysWorkerRequest): Promise<YosysWorkerResult> {
  const [module, share] = await Promise.all([loadModule(), loadShare()])
  const vivado = request.kind === 'vivado-normalize'
  const root = new Map<string, Directory | File>([
    ['share', share],
    ['tmp', new Directory([['yosys-abc-000000', new Directory([])]])],
    [
      'script.ys',
      textFile(
        vivado
          ? buildVivadoNormalizeScript(request.top)
          : buildYosysScript(request.input, request.memory),
      ),
    ],
  ])
  if (vivado) {
    root.set('vivado-netlist.v', textFile(request.netlist))
  } else {
    for (const source of request.input.files) root.set(source.name, textFile(source.content))
  }

  const stdout: string[] = []
  const stderr: string[] = []
  const preopen = new PreopenDirectory('/', root)
  const wasi = new WASI(
    ['yosys', '-q', '-T', '-l', '/log.txt', '-s', '/script.ys'],
    [],
    [
      new OpenFile(new File([])),
      ConsoleStdout.lineBuffered((line) => stdout.push(line)),
      ConsoleStdout.lineBuffered((line) => stderr.push(line)),
      preopen,
    ],
    { debug: false },
  )
  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasi.wasiImport,
  })
  const exitCode = wasi.start(
    instance as WebAssembly.Instance & {
      exports: { memory: WebAssembly.Memory; _start: () => unknown }
    },
  )
  const log = readText(preopen, 'log.txt') ?? [...stdout, ...stderr].join('\n')
  if (exitCode !== 0) throw new YosysFailure('yosys failed', log)
  const netlistJson = readText(preopen, 'netlist.json')
  const sourceNetlistJson = vivado
    ? request.sourceNetlistJson
    : readText(preopen, 'source-netlist.json')
  const flatSourceNetlistJson = vivado
    ? request.flatSourceNetlistJson
    : readText(preopen, 'flat-source-netlist.json')
  if (!netlistJson || !sourceNetlistJson || !flatSourceNetlistJson) {
    throw new YosysFailure('yosys did not produce all three netlists', log)
  }
  const outputBytes =
    netlistJson.length + sourceNetlistJson.length + flatSourceNetlistJson.length
  if (outputBytes > 128 * 1024 * 1024) {
    throw new YosysFailure('yosys output exceeded 128 MiB', log)
  }
  return { netlistJson, sourceNetlistJson, flatSourceNetlistJson, log: tail(log) }
}

function textFile(contents: string): File {
  return new File(encoder.encode(contents))
}

function readText(root: PreopenDirectory, name: string): string | undefined {
  const inode = root.dir.contents.get(name)
  return inode instanceof File ? decoder.decode(inode.data) : undefined
}

function tail(value: string): string {
  return value.length <= 64 * 1024 ? value : value.slice(-64 * 1024)
}

class YosysFailure extends Error {
  readonly log: string

  constructor(message: string, log: string) {
    super(message)
    this.log = log
  }
}

function respond(response: YosysWorkerResponse) {
  self.postMessage(response)
}
