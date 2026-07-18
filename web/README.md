# Synth Explorer web application

This package is the entire production application. It contains the React UI,
CodeMirror editor, browser-local Yosys and Rust analysis workers, bundled
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

Run `npm run build` before `npm run test:e2e`; Playwright starts a local Vite
preview automatically unless `PLAYWRIGHT_BASE_URL` points elsewhere.

## Runtime ownership

- `src/workers/yosys.worker.ts` runs the pinned files in `public/yosys/`.
- `src/workers/analysis.worker.ts` owns the active Rust analysis session.
- `src/workers/exploration.worker.ts` owns the single source-selection
  projection implementation.
- `src/lib/designCache.ts` stores bounded per-origin synthesis artifacts.
- `src/data/examples/` is the canonical bundled example catalog.

The editor workspace (open source files, active file, top, mode, and flags) is
saved in IndexedDB and restored after a refresh. The trash button resets that
workspace to the default `design.sv`; its confirmation can be disabled in the
warning and re-enabled from Settings.

Completed synthesis results use a separate browser cache keyed by the exact
validated RTL, top, mode, flags, Yosys version, and artifact schema. Both stores
are local to one browser profile and are not synced to an account. The synthesis
cache can be removed independently from the settings menu.

See the [architecture](../docs/ARCHITECTURE.md) and
[migration record](../docs/BROWSER_WASM_MIGRATION.md).
