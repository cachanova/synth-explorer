# Synth Explorer web application

This package is the entire production application. It contains the React UI,
CodeMirror editor, browser-local GHDL, Yosys, and Rust analysis workers, bundled
examples, IndexedDB cache, and elkjs graph viewer.

## Development

```bash
npm ci
npm run dev
```

Vite serves <http://localhost:5173>. Synthesis works directly from that origin;
there is no API proxy or backend process.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Vite development server |
| `npm test` | Run Vitest |
| `npm run lint` | Run Oxlint |
| `npx tsc -b` | Type-check the application and workers |
| `npm run build` | Produce the static `dist/` deployment |
| `npm run test:e2e` | Build-independent Playwright checks against `PLAYWRIGHT_BASE_URL` or local preview |
| `npm run benchmark:migration` | Compare pinned control and candidate deployments |
| `npm run generate:precomputed` | Regenerate gate-mode artifacts for the default design and both language variants of every bundled example |
| `npm run verify:precomputed` | Verify precomputed coverage, exact input keys, producer, schema, and artifact shape |

Run `npm run build` before `npm run test:e2e`; Playwright starts a local Vite
preview automatically unless `PLAYWRIGHT_BASE_URL` points elsewhere.

## Runtime ownership

- `src/workers/yosys.worker.ts` runs the pinned files in `public/yosys/`.
- `src/workers/ghdl.worker.ts` translates VHDL-2008 with the pinned files in
  `public/ghdl/` before Yosys runs.
- `src/workers/analysis.worker.ts` owns the active Rust analysis session.
- `src/workers/exploration.worker.ts` owns the single source-selection
  projection implementation.
- `src/lib/designCache.ts` stores bounded per-origin synthesis artifacts.
- `public/precomputed/` contains content-addressed gate-mode artifacts for the
  default design and bundled examples; `src/data/precomputedManifest.json`
  limits which exact input keys may use them.
- `src/data/examples/` is the canonical bundled example catalog. Every concept
  has paired Verilog/SystemVerilog and VHDL variants selected with the toolbar
  language toggle.

The editor workspace (open source files, active file, top, mode, and flags) is
saved in IndexedDB and restored after a refresh. The trash button resets that
workspace to the default `design.sv` while preserving the selected synthesis
mode and flags; its confirmation can be disabled in the warning and re-enabled
from Settings. The file-tab toolbar can load one or more local `.v`, `.sv`,
`.svh`, `.vhd`, or `.vhdl` files, save the active file, or save every open file
to a chosen directory. When the browser does not expose native file-save
pickers, save actions use downloads.
Replacing a same-named editor tab requires confirmation. Computer-file imports
keep the resulting workspace within 128 files, 16 MiB per imported file, and
32 MiB total to keep browser memory bounded.

Completed synthesis results use a separate browser cache keyed by the exact
validated RTL, top, mode, flags, relevant tool versions, and artifact schema. Both stores
are local to one browser profile and are not synced to an account. The synthesis
cache can be removed independently from the settings menu.

On a cache miss, an exact default/example gate-mode input may use its immutable
precomputed artifact from the Vercel edge. Any source, top, mode, flags, Yosys
version, or schema change produces a different key and runs local Yosys as
usual. The downloaded result is validated and then enters the same IndexedDB
cache path as a locally generated result.

See the [architecture](../docs/ARCHITECTURE.md) and
[migration record](../docs/BROWSER_WASM_MIGRATION.md).
