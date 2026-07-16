import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  DEFAULT_MODE,
  DEFAULT_PALETTE,
  isMode,
  isPaletteId,
  resolveMode,
  type Mode,
  type PaletteId,
} from './palettes'
import { MODE_KEY, PALETTE_KEY, ThemeContext } from './themeContext'

function prefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  )
}

function readStored(): { palette: PaletteId; mode: Mode } {
  let palette: PaletteId = DEFAULT_PALETTE
  let mode: Mode = DEFAULT_MODE
  try {
    const p = localStorage.getItem(PALETTE_KEY)
    const m = localStorage.getItem(MODE_KEY)
    if (isPaletteId(p)) palette = p
    if (isMode(m)) mode = m
  } catch {
    // storage blocked (private mode / sandbox) — fall back to defaults
  }
  return { palette, mode }
}

/** Write the resolved theme onto <html>; this is what the CSS blocks key off. */
function applyToDocument(palette: PaletteId, resolved: 'light' | 'dark') {
  const root = document.documentElement
  root.dataset.palette = palette
  root.dataset.theme = resolved
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [{ palette, mode }, setState] = useState(readStored)
  const [systemDark, setSystemDark] = useState(prefersDark)

  // Track the OS preference so 'system' mode reacts live.
  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  const resolvedMode = useMemo(
    () => resolveMode(palette, mode, systemDark),
    [palette, mode, systemDark],
  )

  // Keep <html> attributes in sync with state (also corrects the bootstrap if
  // stored values were stale or absent).
  useEffect(() => {
    applyToDocument(palette, resolvedMode)
  }, [palette, resolvedMode])

  const setPalette = useCallback((id: PaletteId) => {
    setState((s) => ({ ...s, palette: id }))
    try {
      localStorage.setItem(PALETTE_KEY, id)
    } catch {
      // ignore write failures
    }
  }, [])

  const setMode = useCallback((next: Mode) => {
    setState((s) => ({ ...s, mode: next }))
    try {
      localStorage.setItem(MODE_KEY, next)
    } catch {
      // ignore write failures
    }
  }, [])

  const value = useMemo(
    () => ({ palette, mode, resolvedMode, setPalette, setMode }),
    [palette, mode, resolvedMode, setPalette, setMode],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}
