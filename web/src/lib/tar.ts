import { Directory, File } from '@bjorn3/browser_wasi_shim'

interface Tree {
  directories: Map<string, Tree>
  files: Map<string, Uint8Array>
}

const decoder = new TextDecoder()

export function unpackTar(bytes: Uint8Array): Directory {
  const root: Tree = { directories: new Map(), files: new Map() }
  for (let offset = 0; offset + 512 <= bytes.length; ) {
    const header = bytes.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = textField(header, 0, 100).replace(/^\.\//, '')
    const prefix = textField(header, 345, 155)
    const path = [prefix, name].filter(Boolean).join('/').replace(/\/$/, '')
    const sizeText = textField(header, 124, 12).trim()
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0
    const type = header[156]
    const dataOffset = offset + 512
    if (path) {
      if (type === 53) ensureDirectory(root, path.split('/'))
      else if (type === 0 || type === 48) addFile(root, path, bytes.slice(dataOffset, dataOffset + size))
    }
    offset = dataOffset + Math.ceil(size / 512) * 512
  }
  return materialize(root)
}

function textField(bytes: Uint8Array, offset: number, length: number): string {
  const field = bytes.subarray(offset, offset + length)
  const end = field.indexOf(0)
  return decoder.decode(end >= 0 ? field.subarray(0, end) : field)
}

function ensureDirectory(root: Tree, parts: string[]): Tree {
  let current = root
  for (const part of parts.filter(Boolean)) {
    let child = current.directories.get(part)
    if (!child) {
      child = { directories: new Map(), files: new Map() }
      current.directories.set(part, child)
    }
    current = child
  }
  return current
}

function addFile(root: Tree, path: string, contents: Uint8Array) {
  const parts = path.split('/').filter(Boolean)
  const name = parts.pop()
  if (!name) return
  ensureDirectory(root, parts).files.set(name, contents)
}

function materialize(tree: Tree): Directory {
  const entries = new Map<string, Directory | File>()
  for (const [name, directory] of tree.directories) entries.set(name, materialize(directory))
  for (const [name, contents] of tree.files) {
    entries.set(name, new File(contents, { readonly: true }))
  }
  return new Directory(entries)
}
