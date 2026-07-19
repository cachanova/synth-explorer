import type { DesignFile } from '../types'

export const SOURCE_FILE_ACCEPT = '.v,.sv'

type WritableFile = {
  write(data: string): Promise<void>
  close(): Promise<void>
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

function validateSourceName(name: string): void {
  if (!name.endsWith('.v') && !name.endsWith('.sv')) {
    throw new Error(`Source filename must end in .v or .sv: ${name}`)
  }
  if (!name || name.includes('..') || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`Invalid source filename: ${name}`)
  }
}

export async function readComputerFiles(
  selectedFiles: Iterable<File>,
): Promise<DesignFile[]> {
  const files = Array.from(selectedFiles)
  const names = new Set<string>()

  for (const file of files) {
    validateSourceName(file.name)
    if (names.has(file.name)) {
      throw new Error(`More than one selected file is named ${file.name}.`)
    }
    names.add(file.name)
  }

  return Promise.all(
    files.map(async (file) => ({ name: file.name, content: await file.text() })),
  )
}

export function mergeComputerFiles(
  current: DesignFile[],
  imported: DesignFile[],
): DesignFile[] {
  const importedByName = new Map(imported.map((file) => [file.name, file]))
  const merged = current.map((file) => importedByName.get(file.name) ?? file)
  const currentNames = new Set(current.map((file) => file.name))
  return [...merged, ...imported.filter((file) => !currentNames.has(file.name))]
}

function pickerOptions(file: DesignFile) {
  return {
    suggestedName: file.name,
    types: [
      {
        description: 'Verilog source',
        accept: { 'text/plain': ['.v', '.sv'] },
      },
    ],
  }
}

function isPickerCancellation(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

async function writeFile(handle: SaveFileHandle, file: DesignFile): Promise<void> {
  const writable = await handle.createWritable()
  await writable.write(file.content)
  await writable.close()
}

function downloadFiles(files: DesignFile[]): void {
  for (const file of files) {
    const url = URL.createObjectURL(new Blob([file.content], { type: 'text/plain' }))
    const link = document.createElement('a')
    link.href = url
    link.download = file.name
    link.style.display = 'none'
    document.body.append(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}

export async function saveComputerFile(file: DesignFile): Promise<SaveResult> {
  const pickerWindow = window as FilePickerWindow
  const picker = pickerWindow.showSaveFilePicker
  if (!picker) {
    downloadFiles([file])
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
    downloadFiles(files)
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
