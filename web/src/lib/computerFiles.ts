import type { DesignFile } from '../types'
import {
  SOURCE_FILE_EXTENSIONS,
  validateSourceFilename,
} from './sourceFiles'

export const MAX_COMPUTER_FILE_COUNT = 128
export const MAX_COMPUTER_FILE_BYTES = 16 * 1024 * 1024
export const MAX_COMPUTER_FILES_BYTES = 32 * 1024 * 1024

type WritableFile = {
  write(data: string): Promise<void>
  close(): Promise<void>
  abort?(reason?: unknown): Promise<void>
}

type SaveFileHandle = {
  createWritable(): Promise<WritableFile>
}

type DirectoryHandle = {
  getFileHandle(name: string, options: { create: true }): Promise<SaveFileHandle>
}

type FilePickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName: string
    types: Array<{
      description: string
      accept: Record<string, string[]>
    }>
  }) => Promise<SaveFileHandle>
  showDirectoryPicker?: (options: { mode: 'readwrite' }) => Promise<DirectoryHandle>
}

export type SaveResult = 'saved' | 'downloaded' | 'cancelled'

const textEncoder = new TextEncoder()

function sourceContentBytes(content: string): number {
  return textEncoder.encode(content).byteLength
}

function validateWorkspaceLimits(files: DesignFile[]): void {
  if (files.length > MAX_COMPUTER_FILE_COUNT) {
    throw new Error(
      `Loading these files would exceed the ${MAX_COMPUTER_FILE_COUNT}-file workspace limit.`,
    )
  }
  let totalBytes = 0
  for (const file of files) {
    totalBytes += sourceContentBytes(file.content)
    if (totalBytes > MAX_COMPUTER_FILES_BYTES) {
      throw new Error(
        'Loading these files would exceed the 32 MiB workspace limit.',
      )
    }
  }
}

export async function readComputerFiles(
  selectedFiles: Iterable<File>,
  currentFiles: DesignFile[] = [],
): Promise<DesignFile[]> {
  const files = Array.from(selectedFiles)
  if (files.length > MAX_COMPUTER_FILE_COUNT) {
    throw new Error(`Select at most ${MAX_COMPUTER_FILE_COUNT} source files.`)
  }
  const names = new Set<string>()
  let totalBytes = 0

  for (const file of files) {
    validateSourceFilename(file.name, 'Source filename')
    if (names.has(file.name)) {
      throw new Error(`More than one selected file is named ${file.name}.`)
    }
    names.add(file.name)
    if (file.size > MAX_COMPUTER_FILE_BYTES) {
      throw new Error(`${file.name} exceeds the 16 MiB source-file limit.`)
    }
    totalBytes += file.size
    if (totalBytes > MAX_COMPUTER_FILES_BYTES) {
      throw new Error('Selected source files exceed the 32 MiB total limit.')
    }
  }

  const selectedNames = new Set(files.map((file) => file.name))
  const retainedFiles = currentFiles.filter(
    (file) => !selectedNames.has(file.name),
  )
  const resultingCount = retainedFiles.length + files.length
  if (resultingCount > MAX_COMPUTER_FILE_COUNT) {
    throw new Error(
      `Loading these files would exceed the ${MAX_COMPUTER_FILE_COUNT}-file workspace limit.`,
    )
  }
  const retainedBytes = retainedFiles.reduce(
    (total, file) => total + sourceContentBytes(file.content),
    0,
  )
  if (retainedBytes + totalBytes > MAX_COMPUTER_FILES_BYTES) {
    throw new Error(
      'Loading these files would exceed the 32 MiB workspace limit.',
    )
  }

  const result: DesignFile[] = []
  for (const file of files) {
    result.push({ name: file.name, content: await file.text() })
  }
  return result
}

export function mergeComputerFiles(
  current: DesignFile[],
  imported: DesignFile[],
): DesignFile[] {
  const importedByName = new Map(imported.map((file) => [file.name, file]))
  const merged = current.map((file) => importedByName.get(file.name) ?? file)
  const currentNames = new Set(current.map((file) => file.name))
  const result = [
    ...merged,
    ...imported.filter((file) => !currentNames.has(file.name)),
  ]
  validateWorkspaceLimits(result)
  return result
}

export function computerFileCollisions(
  current: DesignFile[],
  imported: DesignFile[],
): string[] {
  const currentNames = new Set(current.map((file) => file.name))
  return imported
    .filter((file) => currentNames.has(file.name))
    .map((file) => file.name)
}

function pickerOptions(file: DesignFile) {
  return {
    suggestedName: file.name,
    types: [
      {
        description: 'Verilog or SystemVerilog source',
        accept: { 'text/plain': [...SOURCE_FILE_EXTENSIONS] },
      },
    ],
  }
}

function isPickerCancellation(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

async function writeFile(handle: SaveFileHandle, file: DesignFile): Promise<void> {
  const writable = await handle.createWritable()
  try {
    await writable.write(file.content)
    await writable.close()
  } catch (error) {
    try {
      await writable.abort?.(error)
    } catch {
      // Preserve the original write failure.
    }
    throw error
  }
}

async function downloadFiles(files: DesignFile[]): Promise<void> {
  for (const file of files) {
    const url = URL.createObjectURL(new Blob([file.content], { type: 'text/plain' }))
    const link = document.createElement('a')
    link.href = url
    link.download = file.name
    link.style.display = 'none'
    document.body.append(link)
    try {
      link.click()
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    } finally {
      link.remove()
      URL.revokeObjectURL(url)
    }
  }
}

export async function saveComputerFile(file: DesignFile): Promise<SaveResult> {
  const pickerWindow = window as FilePickerWindow
  const picker = pickerWindow.showSaveFilePicker
  if (!picker) {
    await downloadFiles([file])
    return 'downloaded'
  }

  try {
    const handle = await picker.call(pickerWindow, pickerOptions(file))
    await writeFile(handle, file)
    return 'saved'
  } catch (error) {
    if (isPickerCancellation(error)) return 'cancelled'
    throw error
  }
}

export async function saveComputerFiles(files: DesignFile[]): Promise<SaveResult> {
  const pickerWindow = window as FilePickerWindow
  const picker = pickerWindow.showDirectoryPicker
  if (!picker) {
    await downloadFiles(files)
    return 'downloaded'
  }

  try {
    const directory = await picker.call(pickerWindow, { mode: 'readwrite' })
    for (const file of files) {
      const handle = await directory.getFileHandle(file.name, { create: true })
      await writeFile(handle, file)
    }
    return 'saved'
  } catch (error) {
    if (isPickerCancellation(error)) return 'cancelled'
    throw error
  }
}
