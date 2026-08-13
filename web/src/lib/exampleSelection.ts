import type { ExampleLanguage } from '../types'

const EXAMPLE_SELECTION_KEY = 'synthexplorer.exampleSelection.v1'

const LANGUAGES = new Set<ExampleLanguage>(['verilog', 'vhdl'])

export interface ExampleSelection {
  language: ExampleLanguage
  // The example the toolbar shows; empty means no example is chosen.
  name: string
}

export const NO_EXAMPLE_SELECTION: ExampleSelection = {
  language: 'verilog',
  name: '',
}

export function parseStoredExampleSelection(value: unknown): ExampleSelection {
  if (!value || typeof value !== 'object') return NO_EXAMPLE_SELECTION
  const record = value as Record<string, unknown>
  if (
    !LANGUAGES.has(record.language as ExampleLanguage) ||
    typeof record.name !== 'string'
  ) {
    return NO_EXAMPLE_SELECTION
  }
  return { language: record.language as ExampleLanguage, name: record.name }
}

export function loadExampleSelection(): ExampleSelection {
  try {
    const stored = localStorage.getItem(EXAMPLE_SELECTION_KEY)
    return stored == null
      ? NO_EXAMPLE_SELECTION
      : parseStoredExampleSelection(JSON.parse(stored))
  } catch {
    return NO_EXAMPLE_SELECTION
  }
}

export function saveExampleSelection(selection: ExampleSelection): void {
  try {
    localStorage.setItem(EXAMPLE_SELECTION_KEY, JSON.stringify(selection))
  } catch {
    // Keep the selection for this session when local storage is unavailable.
  }
}
