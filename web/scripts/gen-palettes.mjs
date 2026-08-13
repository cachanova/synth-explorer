import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const tokenNames = [
  'bg',
  'bg-1',
  'bg-2',
  'bg-3',
  'panel',
  'border',
  'border-strong',
  'text',
  'text-dim',
  'text-faint',
  'accent',
  'accent-dim',
  'green',
  'seq',
  'amber',
  'red',
  'blue',
]

// Palette source data. Swatches are derived from dark bg/accent/green/seq;
// every other entry maps directly to the CSS custom property at the same index.
const palettes = [
  {
    id: 'tidepool',
    label: 'Tidepool',
    blurb: 'House teal — the default.',
    dark: ['#1b1c1f', '#202225', '#26282c', '#2d3034', '#202225', '#303237', '#3d4046', '#dcdee2', '#9da1a8', '#7b7f86', '#2dd4bf', '#12857c', '#57ab5a', '#c8a5f0', '#c69026', '#e5534b', '#8ab4f8'],
    light: ['#f2f6f4', '#ffffff', '#eaf0ed', '#dde6e2', '#ffffff', '#dde5e1', '#c5d0cb', '#182220', '#54615d', '#7c8983', '#0e9e93', '#0b7d72', '#3f8f45', '#7b52c9', '#9a6c15', '#c33830', '#2f6fd0'],
  },
  {
    id: 'tidepool-deep',
    label: 'Tidepool Deep',
    blurb: 'Cooler slate-teal cut.',
    dark: ['#13181a', '#181e20', '#1e2528', '#273034', '#181e20', '#283337', '#3a474c', '#d6e0de', '#93a3a0', '#6b7b78', '#3fb8ab', '#2c7a72', '#5bb06a', '#b49cf0', '#cf9a3a', '#e85d54', '#6fb3c9'],
    light: ['#edf4f2', '#ffffff', '#e4efec', '#d5e2de', '#ffffff', '#d4e2dd', '#baccc6', '#111f1d', '#4b5d59', '#768884', '#0d8f82', '#0c6058', '#3f8f45', '#6f4fc0', '#916413', '#c33830', '#2b7d94'],
  },
  {
    id: 'solarized',
    label: 'Solarized',
    blurb: 'Schoonover’s precision pair.',
    dark: ['#002b36', '#073642', '#0b4250', '#0e4b59', '#073642', '#0d3d49', '#1c5563', '#93a1a1', '#839496', '#586e75', '#2aa198', '#1e6c66', '#859900', '#6c71c4', '#b58900', '#dc322f', '#268bd2'],
    light: ['#fdf6e3', '#eee8d5', '#e4ddc6', '#dbd3b8', '#eee8d5', '#e0dac6', '#c7bfa2', '#586e75', '#657b83', '#93a1a1', '#2aa198', '#1e6c66', '#859900', '#6c71c4', '#b58900', '#dc322f', '#268bd2'],
  },
  {
    id: 'tokyo-night',
    label: 'Tokyo Night',
    blurb: 'Indigo night + bright Day.',
    dark: ['#1a1b26', '#1f2335', '#24283b', '#292e42', '#1f2335', '#282d43', '#3b4261', '#c0caf5', '#a9b1d6', '#565f89', '#7aa2f7', '#526ca2', '#9ece6a', '#bb9af7', '#e0af68', '#f7768e', '#7dcfff'],
    light: ['#e1e2e7', '#d7d9e0', '#c9ccd8', '#b9bdcc', '#d7d9e0', '#cdd0da', '#a8adc0', '#343b58', '#5a6294', '#848cb5', '#2e7de9', '#215599', '#587539', '#9854f1', '#8f5e15', '#f52a65', '#007197'],
  },
  {
    id: 'nord',
    label: 'Nord',
    blurb: 'Arctic blue-grays (light = Snowstorm).',
    dark: ['#2e3440', '#333b49', '#3b4252', '#434c5e', '#333b49', '#3a4150', '#4c566a', '#eceff4', '#d8dee9', '#6d7a94', '#88c0d0', '#5b8089', '#a3be8c', '#b48ead', '#ebcb8b', '#bf616a', '#81a1c1'],
    light: ['#eceff4', '#e5e9f0', '#d8dee9', '#c5cdda', '#e5e9f0', '#dbe1ea', '#b6c0d0', '#2e3440', '#434c5e', '#6c7789', '#5e81ac', '#405772', '#7a9153', '#9a6f9e', '#b08a3e', '#a5545c', '#5e81ac'],
  },
  {
    id: 'gruvbox',
    label: 'Gruvbox',
    blurb: 'Warm retro contrast.',
    dark: ['#282828', '#32302f', '#3c3836', '#504945', '#32302f', '#3c3836', '#504945', '#ebdbb2', '#d5c4a1', '#928374', '#fe8019', '#a65714', '#b8bb26', '#d3869b', '#fabd2f', '#fb4934', '#83a598'],
    light: ['#fbf1c7', '#f2e5bc', '#ebdbb2', '#d5c4a1', '#f2e5bc', '#ece0bb', '#bdae93', '#3c3836', '#504945', '#7c6f64', '#d65d0e', '#8d400d', '#98971a', '#b16286', '#d79921', '#cc241d', '#458588'],
  },
  {
    id: 'night-owl',
    label: 'Night Owl',
    blurb: 'Deep ocean + Light Owl, teal accent.',
    dark: ['#011627', '#0b2942', '#123a56', '#1d3b53', '#0b2942', '#0f3b54', '#2a4d66', '#d6deeb', '#a7b6c9', '#637777', '#7fdbca', '#559186', '#addb67', '#c792ea', '#ecc48d', '#ef5350', '#82aaff'],
    light: ['#fbfbfb', '#f0f0f4', '#e5e7ee', '#d9dde6', '#f0f0f4', '#e7e7eb', '#c9ccd6', '#403f53', '#5f6789', '#989fb1', '#2aa298', '#1e6c66', '#649a01', '#994cc3', '#daaa01', '#de3d3b', '#288ed7'],
  },
  {
    id: 'dracula',
    label: 'Dracula',
    blurb: 'Vivid dark — no standard light.',
    dark: ['#282a36', '#2d2f3d', '#343746', '#3c3f51', '#2d2f3d', '#383b4b', '#4a4e63', '#f8f8f2', '#c3c6da', '#6272a4', '#ff79c6', '#a75283', '#50fa7b', '#bd93f9', '#ffb86c', '#ff5555', '#8be9fd'],
  },
  {
    id: 'synthwave',
    label: 'Synthwave ’84',
    blurb: 'Neon-on-purple — dark world.',
    dark: ['#241b2f', '#2a2139', '#34294f', '#3b3054', '#2a2139', '#342a4d', '#4b3f6b', '#f0eff1', '#b6b1c9', '#848bbd', '#ff7edb', '#a75590', '#72f1b8', '#b084eb', '#fede5d', '#fe4450', '#36f9f6'],
  },
]

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const palettePath = resolve(scriptDirectory, '../src/lib/theme/palettes.ts')
const cssPath = resolve(scriptDirectory, '../src/index.css')

replaceGeneratedRegion(
  palettePath,
  '// BEGIN GENERATED PALETTE REGISTRY — run scripts/gen-palettes.mjs',
  '// END GENERATED PALETTE REGISTRY',
  renderRegistry(),
)
replaceGeneratedRegion(
  cssPath,
  '/* BEGIN GENERATED PALETTE TOKENS — run scripts/gen-palettes.mjs */',
  '/* END GENERATED PALETTE TOKENS */',
  renderCss(),
)

function renderRegistry() {
  const entries = palettes.map((palette) => {
    const [ground, accent, port, reg] = [0, 10, 12, 13].map((index) => palette.dark[index])
    return `  { id: ${quote(palette.id)}, label: ${quote(palette.label)}, blurb: ${quote(palette.blurb)}, hasLight: ${Boolean(palette.light)}, swatch: { ground: ${quote(ground)}, accent: ${quote(accent)}, port: ${quote(port)}, reg: ${quote(reg)} } },`
  })
  return ['export const PALETTES = [', ...entries, '] as const'].join('\n')
}

function renderCss() {
  const blocks = palettes.map((palette) =>
    ['dark', 'light']
      .filter((mode) => palette[mode])
      .map((mode) => {
        const properties = tokenNames.map(
          (token, index) => `  --${token}: ${palette[mode][index]};`,
        )
        return [
          `:root[data-palette='${palette.id}'][data-theme='${mode}'] {`,
          ...properties,
          `  color-scheme: ${mode};`,
          '}',
        ].join('\n')
      })
      .join('\n'),
  )
  return [
    '/* THEME TOKEN BLOCKS — generated from scripts/gen-palettes.mjs.',
    '   One block per palette × mode; JS sets [data-palette]/[data-theme] on <html>.',
    '   Base :root above stays Tidepool dark as the pre-hydration fallback. */',
    '',
    blocks.join('\n\n'),
  ].join('\n')
}

function replaceGeneratedRegion(path, startMarker, endMarker, generated) {
  const contents = readFileSync(path, 'utf8')
  const start = contents.indexOf(startMarker)
  const end = contents.indexOf(endMarker, start + startMarker.length)
  if (start < 0 || end < 0) throw new Error(`generated-region markers missing in ${path}`)
  const before = contents.slice(0, start + startMarker.length)
  const after = contents.slice(end)
  writeFileSync(path, `${before}\n${generated}\n${after}`)
}

function quote(value) {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
}
