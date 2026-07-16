import { createContext, useContext } from 'react'
import type { Mode, PaletteId } from './palettes'

// Storage keys are shared verbatim with the no-FOUC bootstrap in index.html.
export const PALETTE_KEY = 'se-palette'
export const MODE_KEY = 'se-mode'

export interface ThemeContextValue {
  palette: PaletteId
  mode: Mode
  /** Concrete appearance actually rendered (mode + palette light-support). */
  resolvedMode: 'light' | 'dark'
  setPalette: (id: PaletteId) => void
  setMode: (mode: Mode) => void
}

export const ThemeContext = createContext<ThemeContextValue | null>(null)

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
