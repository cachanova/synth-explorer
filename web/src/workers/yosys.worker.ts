/// <reference lib="webworker" />

import {
  ConsoleStdout,
  Directory,
  File,
  OpenFile,
  PreopenDirectory,
  WASI,
} from '@bjorn3/browser_wasi_shim'
import type { MemoryHandling, ValidatedSynthesis } from '../lib/yosysScript'
import { buildYosysScript } from '../lib/yosysScript'
import { unpackTar } from '../lib/tar'

interface Request {
  input: ValidatedSynthesis
  memory: MemoryHandling
}

export interface YosysWorkerResult {
  netlistJson: string
  sourceNetlistJson: string
  log: string
}

type WorkerResponse =
  | { ok: true; result: YosysWorkerResult }
  | { ok: false; error: string; log?: string }

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const assetVersion = '0.67-2d1509d1b'

self.onmessage = (event: MessageEvent<Request>) => {
  void run(event.data).then(
    (result) => respond({ ok: true, result }),
    (error) =>
      respond({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        log: error instanceof YosysFailure ? error.log : undefined,
      }),
  )
}

const modulePromise = fetch(`/yosys/yosys.wasm?v=${assetVersion}`)
  .then(async (response) => {
    if (!response.ok) throw new Error(`failed to load Yosys: ${response.status}`)
    const contentType = response.headers.get('Content-Type') ?? ''
    if (!contentType.includes('application/wasm')) {
      throw new Error(
        `failed to load Yosys: expected application/wasm, got ${contentType || 'no content type'}`,
      )
    }
    if (typeof WebAssembly.compileStreaming === 'function') {
      return WebAssembly.compileStreaming(response)
    }
    return WebAssembly.compile(await response.arrayBuffer())
  })

const sharePromise = fetch(`/yosys/share.tar.gz?v=${assetVersion}`)
  .then((response) => {
    if (!response.ok) throw new Error(`failed to load Yosys resources: ${response.status}`)
    // Some static hosts (including Vite preview) serve .gz files with
    // Content-Encoding: gzip. Fetch has already decoded those response bytes;
    // only decompress hosts that serve the archive as an opaque gzip file.
    if (response.headers.get('Content-Encoding')?.includes('gzip')) {
      return response.arrayBuffer()
    }
    if (!response.body) throw new Error('Yosys resource response has no body')
    return new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
  })
  .then((buffer) => unpackTar(new Uint8Array(buffer)))

async function run(request: Request): Promise<YosysWorkerResult> {
  const [module, share] = await Promise.all([modulePromise, sharePromise])
  const root = new Map<string, Directory | File>([
    ['share', share],
    ['tmp', new Directory([['yosys-abc-000000', new Directory([])]])],
    ['script.ys', textFile(buildYosysScript(request.input, request.memory))],
  ])
  for (const source of request.input.files) root.set(source.name, textFile(source.content))

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
  const sourceNetlistJson = readText(preopen, 'source-netlist.json')
  if (!netlistJson || !sourceNetlistJson) {
    throw new YosysFailure('yosys did not produce both netlists', log)
  }
  const outputBytes = netlistJson.length + sourceNetlistJson.length
  if (outputBytes > 128 * 1024 * 1024) {
    throw new YosysFailure('yosys output exceeded 128 MiB', log)
  }
  return { netlistJson, sourceNetlistJson, log: tail(log) }
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

function respond(response: WorkerResponse) {
  self.postMessage(response)
}
