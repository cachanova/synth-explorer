/// <reference lib="webworker" />

import { EngineLoadError, lazyLoad } from '../lib/engineLoad'
import { unpackTarFiles } from '../lib/tar'
import { GHDL_VERSION } from '../lib/yosysScript'
import type {
  VhdlTranslation,
  VhdlWorkerRequest,
  VhdlWorkerResponse,
} from '../lib/vhdl'

const libraryRoot = '/ghdl/lib/ghdl'
const workDirectory = '/work'
const decoder = new TextDecoder('latin1')
const encoder = new TextEncoder()

const loadModule = lazyLoad('failed to load GHDL', async () => {
  const response = await fetch(`/ghdl/ghdl-synth.wasm?v=${GHDL_VERSION}`)
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

const loadLibraries = lazyLoad('failed to load GHDL libraries', async () => {
  const response = await fetch(`/ghdl/libraries.tar.gz?v=${GHDL_VERSION}`)
  if (!response.ok) throw new Error(`status ${response.status}`)
  let buffer: ArrayBuffer
  if (response.headers.get('Content-Encoding')?.includes('gzip')) {
    buffer = await response.arrayBuffer()
  } else {
    if (!response.body) throw new Error('response has no body')
    buffer = await new Response(
      response.body.pipeThrough(new DecompressionStream('gzip')),
    ).arrayBuffer()
  }
  return unpackTarFiles(new Uint8Array(buffer))
})

void loadModule().catch(() => {})
void loadLibraries().catch(() => {})

self.onmessage = (event: MessageEvent<VhdlWorkerRequest>) => {
  void run(event.data).then(
    (result) => respond({ ok: true, result }),
    (error) =>
      respond({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        kind: error instanceof EngineLoadError ? 'load' : undefined,
        log: error instanceof GhdlFailure ? error.log : undefined,
      }),
  )
}

async function run(request: VhdlWorkerRequest): Promise<VhdlTranslation> {
  const [module, libraries] = await Promise.all([loadModule(), loadLibraries()])
  const fs = new VirtualFileSystem()
  for (const [name, contents] of libraries) {
    fs.add(`${libraryRoot}/${name}`, contents)
  }
  for (const file of request.files) {
    const contents = encoder.encode(file.content)
    fs.add(file.name, contents)
    fs.add(`${workDirectory}/${file.name}`, contents)
  }

  let memory: WebAssembly.Memory
  let instance: WebAssembly.Instance
  const stdout: Uint8Array[] = []
  const stderr: Uint8Array[] = []
  const bytes = () => new Uint8Array(memory.buffer)
  const view = () => new DataView(memory.buffer)
  const emit = (fd: number, contents: Uint8Array | string) => {
    const chunk = typeof contents === 'string' ? encoder.encode(contents) : contents.slice()
    ;(fd === 2 ? stderr : stdout).push(chunk)
  }
  const cString = (pointer: number) => {
    if (!pointer) return ''
    const data = bytes()
    let end = pointer
    while (data[end]) end += 1
    return decoder.decode(data.subarray(pointer, end))
  }
  const fatString = (dataPointer: number, boundsPointer: number) => {
    const first = view().getInt32(boundsPointer, true)
    const last = view().getInt32(boundsPointer + 4, true)
    return last < first
      ? ''
      : decoder.decode(bytes().subarray(dataPointer, dataPointer + last - first + 1))
  }
  const writeFatString = (dataPointer: number, boundsPointer: number, value: string) => {
    bytes().set(encoder.encode(value), dataPointer)
    view().setInt32(boundsPointer, 1, true)
    view().setInt32(boundsPointer + 4, value.length, true)
  }
  const allocatedSize = (pointer: number) => {
    if (!pointer) return 0
    const base = pointer - 16
    const next = view().getUint32(base + 4, true)
    return (next & ~1) - base - 16
  }

  const env = {
    strlen: (pointer: number) => {
      const data = bytes()
      let length = 0
      while (data[pointer + length]) length += 1
      return length
    },
    strcmp: (left: number, right: number) => {
      const data = bytes()
      for (let index = 0; ; index += 1) {
        const difference = data[left + index] - data[right + index]
        if (difference) return difference
        if (!data[left + index]) return 0
      }
    },
    realloc: (pointer: number, size: number) => {
      const exports = instance.exports as unknown as GhdlExports
      if (!pointer) return exports.malloc(size)
      if (!size) {
        exports.free(pointer)
        return 0
      }
      const oldSize = allocatedSize(pointer)
      const next = exports.malloc(size)
      if (!next) return 0
      bytes().copyWithin(next, pointer, pointer + Math.min(oldSize, size))
      exports.free(pointer)
      return next
    },
    fopen: (pathPointer: number) => {
      const descriptor = fs.open(cString(pathPointer))
      return descriptor < 0 ? 0 : descriptor
    },
    fclose: (fd: number) => {
      fs.close(fd)
      return 0
    },
    fread: (pointer: number, size: number, count: number, fd: number) => {
      const read = fs.read(fd, bytes().subarray(pointer, pointer + size * count))
      return read < 0 ? 0 : Math.floor(read / size)
    },
    fwrite: (pointer: number, size: number, count: number, fd: number) => {
      emit(fd, bytes().subarray(pointer, pointer + size * count))
      return count
    },
    fputs: (pointer: number, fd: number) => {
      const value = cString(pointer)
      emit(fd, value)
      return value.length
    },
    fflush: () => 0,
    ungetc: (character: number, fd: number) => fs.unread(fd, character),
    getc_unlocked: (fd: number) => fs.readByte(fd),
    feof_unlocked: (fd: number) => (fs.eof(fd) ? 1 : 0),
    putc_unlocked: (character: number, fd: number) => {
      emit(fd, new Uint8Array([character & 0xff]))
      return character
    },
    __ghdl_get_stdout: () => 1,
    __ghdl_get_stderr: () => 2,
    __ghdl_get_stdin: () => 0,
    __ghdl_fprintf_g: (fd: number, value: number) => emit(fd, String(value)),
    __ghdl_snprintf_fmtf: (
      pointer: number,
      length: number,
      _format: number,
      value: number,
    ) => {
      const text = String(value).slice(0, length - 1)
      bytes().set(encoder.encode(text), pointer)
      bytes()[pointer + text.length] = 0
    },
    isatty: () => 0,
    getenv: () => 0,
    gnat__os_lib__is_regular_file: (pointer: number, bounds: number) =>
      fs.has(fatString(pointer, bounds)) ? 1 : 0,
    gnat__os_lib__is_absolute_path: (pointer: number, bounds: number) =>
      fatString(pointer, bounds).startsWith('/') ? 1 : 0,
    gnat__os_lib__is_executable_file: () => 0,
    gnat__os_lib__is_directory: (pointer: number, bounds: number) =>
      fs.isDirectory(fatString(pointer, bounds)) ? 1 : 0,
    gnat__os_lib__delete_file: (_pointer: number, _bounds: number, _name: number, ok: number) => {
      if (ok) view().setInt32(ok, 0, true)
    },
    gnat__os_lib__rename_file: (...args: number[]) => {
      const ok = args.at(-1) ?? 0
      if (ok) view().setInt32(ok, 0, true)
    },
    gnat__os_lib__file_time_stamp: () => 0n,
    gnat__os_lib__open_read__2: (pointer: number) => fs.open(cString(pointer)),
    gnat__os_lib__close: (fd: number) => fs.close(fd),
    gnat__os_lib__create_file__2: () => -1,
    gnat__os_lib__file_length: (fd: number) => fs.length(fd),
    gnat__os_lib__read: (fd: number, pointer: number, length: number) => {
      const read = fs.read(fd, bytes().subarray(pointer, pointer + length))
      return read < 0 ? 0 : read
    },
    gnat__os_lib__write: (fd: number, pointer: number, length: number) => {
      emit(fd, bytes().subarray(pointer, pointer + length))
      return length
    },
    gnat__os_lib__spawn: () => -1,
    gnat__os_lib__locate_exec_on_path: (data: number, bounds: number) =>
      writeFatString(data, bounds, ''),
    ceil: Math.ceil,
    floor: Math.floor,
    round: Math.round,
    trunc: Math.trunc,
    fmod: (left: number, right: number) => left % right,
    fmin: Math.min,
    fmax: Math.max,
    log10: Math.log10,
    cbrt: Math.cbrt,
    grt_dynload_open: () => 0,
    grt_dynload_symbol: () => 0,
    __gnat_put_exception: () => {},
    __gnat_put_int: (value: number) => emit(2, String(value)),
    __gnat_put_char: (character: number) => emit(2, new Uint8Array([character & 0xff])),
    __gnat_put_string: (pointer: number, length: number) =>
      emit(2, bytes().subarray(pointer, pointer + length)),
    __gnat_grow: (value: number) => value,
    __multi3: (result: number, al: bigint, ah: bigint, bl: bigint, bh: bigint) => {
      const left = (BigInt.asUintN(64, ah) << 64n) | BigInt.asUintN(64, al)
      const right = (BigInt.asUintN(64, bh) << 64n) | BigInt.asUintN(64, bl)
      const product = BigInt.asUintN(128, left * right)
      view().setBigUint64(result, product & ((1n << 64n) - 1n), true)
      view().setBigUint64(result + 8, product >> 64n, true)
    },
  }

  instance = await WebAssembly.instantiate(module, { env })
  const exports = instance.exports as unknown as GhdlExports
  memory = exports.memory
  const currentPages = memory.buffer.byteLength / 65_536
  if (currentPages < 1_024) memory.grow(1_024 - currentPages)
  exports.__wasm_call_ctors?.()
  exports.ghdlwasm_init()
  if (exports.synth_api__synth_init() !== 0) {
    throw new GhdlFailure('GHDL failed to initialize', text(stderr))
  }
  for (const file of request.files) {
    const [pointer, length] = adaString(exports, bytes, file.name)
    const rc = exports.synth_api__analyze_file(pointer, length)
    exports.free(pointer)
    if (rc !== 0) {
      throw new GhdlFailure(`GHDL failed to analyze ${file.name}`, text(stderr))
    }
  }
  stdout.length = 0
  const [topPointer, topLength] = adaString(exports, bytes, request.top.toLowerCase())
  const rc = exports.synth_api__synth_top(topPointer, topLength)
  exports.free(topPointer)
  if (rc !== 0) {
    throw new GhdlFailure(`GHDL failed to synthesize ${request.top}`, text(stderr))
  }
  const verilog = text(stdout)
  if (!verilog.trim()) {
    throw new GhdlFailure('GHDL produced an empty Verilog netlist', text(stderr))
  }
  return { verilog, log: tail(text(stderr)) }
}

interface GhdlExports {
  memory: WebAssembly.Memory
  malloc(size: number): number
  free(pointer: number): void
  __wasm_call_ctors?: () => void
  ghdlwasm_init(): void
  synth_api__synth_init(): number
  synth_api__analyze_file(pointer: number, length: number): number
  synth_api__synth_top(pointer: number, length: number): number
}

function adaString(
  exports: GhdlExports,
  bytes: () => Uint8Array,
  value: string,
): [number, number] {
  const contents = encoder.encode(value)
  const pointer = exports.malloc(contents.length + 1)
  bytes().set(contents, pointer)
  bytes()[pointer + contents.length] = 0
  return [pointer, contents.length]
}

function text(chunks: Uint8Array[]): string {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const joined = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.length
  }
  return decoder.decode(joined)
}

function tail(value: string): string {
  return value.length <= 64 * 1_024 ? value : value.slice(-64 * 1_024)
}

class VirtualFileSystem {
  private readonly files = new Map<string, Uint8Array>()
  private readonly directories = new Set<string>(['/', workDirectory, libraryRoot])
  private readonly descriptors = new Map<number, { contents: Uint8Array; position: number }>()
  private nextDescriptor = 100

  add(path: string, contents: Uint8Array): void {
    const normalized = normalizePath(path)
    this.files.set(normalized, contents)
    const parts = normalized.split('/').filter(Boolean)
    parts.pop()
    let directory = normalized.startsWith('/') ? '' : '.'
    for (const part of parts) {
      directory = directory === '' ? `/${part}` : `${directory}/${part}`
      this.directories.add(directory)
    }
  }

  has(path: string): boolean {
    return this.resolve(path) !== undefined
  }

  isDirectory(path: string): boolean {
    return this.directories.has(normalizePath(path))
  }

  open(path: string): number {
    const contents = this.resolve(path)
    if (!contents) return -1
    const descriptor = this.nextDescriptor
    this.nextDescriptor += 1
    this.descriptors.set(descriptor, { contents, position: 0 })
    return descriptor
  }

  close(descriptor: number): void {
    this.descriptors.delete(descriptor)
  }

  length(descriptor: number): number {
    return this.descriptors.get(descriptor)?.contents.length ?? -1
  }

  eof(descriptor: number): boolean {
    const file = this.descriptors.get(descriptor)
    return !file || file.position >= file.contents.length
  }

  read(descriptor: number, destination: Uint8Array): number {
    const file = this.descriptors.get(descriptor)
    if (!file) return -1
    const length = Math.min(destination.length, file.contents.length - file.position)
    if (length <= 0) return 0
    destination.set(file.contents.subarray(file.position, file.position + length))
    file.position += length
    return length
  }

  readByte(descriptor: number): number {
    const byte = new Uint8Array(1)
    return this.read(descriptor, byte) <= 0 ? -1 : byte[0]
  }

  unread(descriptor: number, character: number): number {
    const file = this.descriptors.get(descriptor)
    if (file && file.position > 0) file.position -= 1
    return character
  }

  private resolve(path: string): Uint8Array | undefined {
    const normalized = normalizePath(path)
    return this.files.get(normalized) ?? this.files.get(`${workDirectory}/${normalized}`)
  }
}

function normalizePath(path: string): string {
  const absolute = path.startsWith('/')
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `${absolute ? '/' : ''}${parts.join('/')}` || (absolute ? '/' : '.')
}

class GhdlFailure extends Error {
  readonly log: string

  constructor(message: string, log: string) {
    super(message)
    this.log = log
  }
}

function respond(response: VhdlWorkerResponse): void {
  self.postMessage(response)
}
