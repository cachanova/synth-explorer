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

The browser cache is keyed by the exact validated RTL, top, mode, flags, Yosys
version, and artifact schema. It is local to one browser profile, is not synced
to an account, and can be removed from the settings menu.

See the [architecture](../docs/ARCHITECTURE.md) and
[migration record](../docs/BROWSER_WASM_MIGRATION.md).
