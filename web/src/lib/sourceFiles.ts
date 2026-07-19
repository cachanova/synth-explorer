export const SOURCE_FILE_EXTENSIONS = ['.v', '.sv', '.svh'] as const
export const SOURCE_FILE_ACCEPT = SOURCE_FILE_EXTENSIONS.join(',')
export const SOURCE_FILE_EXTENSION_LABEL = '.v, .sv, or .svh'

export function validateSourceFilename(
  name: string,
  label = 'source filename',
): void {
  if (!SOURCE_FILE_EXTENSIONS.some((extension) => name.endsWith(extension))) {
    throw new Error(
      `${label} must end in ${SOURCE_FILE_EXTENSION_LABEL}: ${name}`,
    )
  }
  if (!name || name.includes('..') || !/^[A-Za-z0-9._-]+$/.test(name)) {
    const prefix = label[0] === label[0]?.toUpperCase() ? 'Invalid' : 'invalid'
    throw new Error(`${prefix} ${label.toLowerCase()}: ${name}`)
  }
}

export function isVerilogCompilationUnit(name: string): boolean {
  return name.endsWith('.v') || name.endsWith('.sv')
}
