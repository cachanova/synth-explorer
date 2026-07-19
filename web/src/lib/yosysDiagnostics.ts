export interface SynthesisDiagnostic {
  file: string
  line: number
  column?: number
  message: string
}

const SOURCE_ERROR = /^(.+?):(\d+)(?::(\d+))?:\s+ERROR:\s+(.+)$/

export function firstYosysSourceError(
  log: string | undefined,
  sourceFiles: readonly string[],
): SynthesisDiagnostic | undefined {
  if (!log) return undefined
  const submittedFiles = new Set(sourceFiles)
  for (const rawLine of log.split('\n')) {
    const match = SOURCE_ERROR.exec(rawLine.trim())
    if (!match || !submittedFiles.has(match[1])) continue
    const line = Number(match[2])
    const column = match[3] ? Number(match[3]) : undefined
    if (!Number.isSafeInteger(line) || line < 1) continue
    if (column != null && (!Number.isSafeInteger(column) || column < 1)) continue
    return {
      file: match[1],
      line,
      ...(column == null ? {} : { column }),
      message: match[4],
    }
  }
  return undefined
}
