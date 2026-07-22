// Parsing of yosys `src` attribute strings.
//
// Format examples:
//   "design.sv:12.16-12.21"   file, start line.col - end line.col
//   "design.sv:12.16"         file, single point
//   "design.sv:12"            file, whole line
//   "a.sv:3.1-3.5|b.sv:9.2-9.8"  multiple, joined by "|"
//
// Columns are 1-based in yosys. Lines are 1-based.

export interface SrcSpan {
  file: string
  startLine: number
  startCol: number // 1-based; 1 when unknown
  endLine: number
  endCol: number // 1-based inclusive-ish; equals startCol when unknown
  /** True when both columns came from an authoritative source range. */
  exact?: boolean
}

const ONE = 1

function parsePoint(s: string): { line: number; col: number; exact: boolean } | null {
  // "12.16" or "12"
  const dot = s.indexOf('.')
  if (dot === -1) {
    const line = Number(s)
    if (!Number.isFinite(line)) return null
    return { line, col: ONE, exact: false }
  }
  const line = Number(s.slice(0, dot))
  const col = Number(s.slice(dot + 1))
  if (!Number.isFinite(line) || !Number.isFinite(col)) return null
  return { line, col, exact: true }
}

/** Parse a single "file:loc" fragment. Returns null if unparseable. */
export function parseSrcFragment(fragment: string): SrcSpan | null {
  const trimmed = fragment.trim()
  if (!trimmed) return null
  // The file part may itself contain ':' on odd platforms, but yosys emits
  // bare filenames, so split on the last ':'.
  const colon = trimmed.lastIndexOf(':')
  if (colon === -1) return null
  const file = trimmed.slice(0, colon)
  const loc = trimmed.slice(colon + 1)
  if (!file || !loc) return null

  const dash = loc.indexOf('-')
  if (dash === -1) {
    const p = parsePoint(loc)
    if (!p) return null
    return {
      file,
      startLine: p.line,
      startCol: p.col,
      endLine: p.line,
      endCol: p.col,
      exact: p.exact || undefined,
    }
  }
  const start = parsePoint(loc.slice(0, dash))
  const end = parsePoint(loc.slice(dash + 1))
  if (!start || !end) return null
  return {
    file,
    startLine: start.line,
    startCol: start.col,
    endLine: end.line,
    endCol: end.col,
    exact: (start.exact && end.exact) || undefined,
  }
}

/** Parse a full yosys src attribute (possibly "|"-joined) into spans. */
export function parseSrc(src: string | undefined | null): SrcSpan[] {
  if (!src) return []
  const out: SrcSpan[] = []
  for (const frag of src.split('|')) {
    const span = parseSrcFragment(frag)
    if (span) out.push(span)
  }
  return out
}

/** Short human label for a span, e.g. "design.sv:12". */
export function srcLabel(span: SrcSpan): string {
  if (span.endLine !== span.startLine) {
    return `${span.file}:${span.startLine}-${span.endLine}`
  }
  return `${span.file}:${span.startLine}`
}

/** Label for a span list (first fragment, "+N" if more). */
export function spansSummary(spans: SrcSpan[]): string | null {
  if (spans.length === 0) return null
  const first = srcLabel(spans[0])
  return spans.length > 1 ? `${first} +${spans.length - 1}` : first
}

/**
 * Spans restricted to files of the current design. Yosys techmap libraries
 * attach src attributes pointing at their own installation (for example
 * /opt/yosys/share/yosys/xilinx/ff_map.v); those paths mean nothing to the
 * user and leak server layout, so they are never shown.
 */
export function designSrcSpans(
  src: string | undefined | null,
  designFiles: ReadonlyArray<{ name: string }>,
): SrcSpan[] {
  const names = new Set(designFiles.map((file) => file.name))
  return parseSrc(src)
    .filter((span) => names.has(span.file))
    .map((span) => {
      const lower = span.file.toLowerCase()
      if (!lower.endsWith('.vhd') && !lower.endsWith('.vhdl')) return span
      return { ...span, startCol: ONE, endCol: ONE, exact: undefined }
    })
}
