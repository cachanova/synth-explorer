// Palette registry — the menu's source of truth for names, ordering, whether a
// light variant exists, and a small swatch for the picker. The authoritative
// token *values* live as `:root[data-palette][data-theme]` blocks in index.css;
// keep the two in sync (both derive from scratchpad/gen-palettes.mjs).

export const PALETTES = [
  { id: 'tidepool', label: 'Tidepool', blurb: 'House teal — the default.', hasLight: true, swatch: { ground: '#1b1c1f', accent: '#2dd4bf', port: '#57ab5a', reg: '#c8a5f0' } },
  { id: 'tidepool-deep', label: 'Tidepool Deep', blurb: 'Cooler slate-teal cut.', hasLight: true, swatch: { ground: '#13181a', accent: '#3fb8ab', port: '#5bb06a', reg: '#b49cf0' } },
  { id: 'solarized', label: 'Solarized', blurb: 'Schoonover’s precision pair.', hasLight: true, swatch: { ground: '#002b36', accent: '#2aa198', port: '#859900', reg: '#6c71c4' } },
  { id: 'tokyo-night', label: 'Tokyo Night', blurb: 'Indigo night + bright Day.', hasLight: true, swatch: { ground: '#1a1b26', accent: '#7aa2f7', port: '#9ece6a', reg: '#bb9af7' } },
  { id: 'nord', label: 'Nord', blurb: 'Arctic blue-grays (light = Snowstorm).', hasLight: true, swatch: { ground: '#2e3440', accent: '#88c0d0', port: '#a3be8c', reg: '#b48ead' } },
  { id: 'gruvbox', label: 'Gruvbox', blurb: 'Warm retro contrast.', hasLight: true, swatch: { ground: '#282828', accent: '#fe8019', port: '#b8bb26', reg: '#d3869b' } },
  { id: 'night-owl', label: 'Night Owl', blurb: 'Deep ocean + Light Owl, teal accent.', hasLight: true, swatch: { ground: '#011627', accent: '#7fdbca', port: '#addb67', reg: '#c792ea' } },
  { id: 'dracula', label: 'Dracula', blurb: 'Vivid dark — no standard light.', hasLight: false, swatch: { ground: '#282a36', accent: '#ff79c6', port: '#50fa7b', reg: '#bd93f9' } },
  { id: 'synthwave', label: 'Synthwave ’84', blurb: 'Neon-on-purple — dark world.', hasLight: false, swatch: { ground: '#241b2f', accent: '#ff7edb', port: '#72f1b8', reg: '#b084eb' } },
] as const

export type PaletteId = (typeof PALETTES)[number]['id']
export type Mode = 'system' | 'light' | 'dark'

export const DEFAULT_PALETTE: PaletteId = 'tidepool'
export const DEFAULT_MODE: Mode = 'system'

const BY_ID = new Map(PALETTES.map((p) => [p.id, p]))

export function isPaletteId(v: unknown): v is PaletteId {
  return typeof v === 'string' && BY_ID.has(v as PaletteId)
}

export function isMode(v: unknown): v is Mode {
  return v === 'system' || v === 'light' || v === 'dark'
}

export function paletteHasLight(id: PaletteId): boolean {
  return BY_ID.get(id)?.hasLight ?? true
}

/**
 * Resolve the concrete appearance a (palette, mode) pair renders as.
 * 'system' follows `prefersDark`; a palette with no light variant always
 * resolves to 'dark' regardless of mode.
 */
export function resolveMode(
  palette: PaletteId,
  mode: Mode,
  prefersDark: boolean,
): 'light' | 'dark' {
  if (!paletteHasLight(palette)) return 'dark'
  if (mode === 'system') return prefersDark ? 'dark' : 'light'
  return mode
}
