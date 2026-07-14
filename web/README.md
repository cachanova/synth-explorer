# Synth Explorer web client

The `web/` package contains the React interface for Synth Explorer. It provides
the CodeMirror source editor, synthesis controls, analysis views, and the
elkjs-based circuit viewer.

Read the [repository README](../README.md) for the product overview and full
stack setup.

## Development

Install Node.js 24.11.1 and npm 11.6.2, then install the locked dependencies:

```bash
npm ci
npm run dev
```

Vite serves <http://localhost:5173> and proxies `/api` to the Rust server at
<http://127.0.0.1:8787>. Start the server from the repository's `server/`
directory before synthesizing a design.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Vite development server |
| `npm test` | Run the Vitest suite once |
| `npm run test:watch` | Run Vitest in watch mode |
| `npm run lint` | Check the source with Oxlint |
| `npx tsc --noEmit` | Type-check without emitting files |
| `npm run build` | Type-check and build `dist/` for production |
| `npm run test:e2e` | Run Playwright against `PLAYWRIGHT_BASE_URL` |
| `npm run verify:worker` | Verify the elkjs worker bundle in a Node VM |

## Structure

| Path | Purpose |
| --- | --- |
| `src/components/` | Editor, controls, analysis tabs, and graph UI |
| `src/lib/` | API-independent graph, synthesis, layout, and source helpers |
| `src/workers/` | elkjs layout worker and browser environment shim |
| `e2e/` | Playwright production-flow checks |
| `public/` | Brand and favicon assets |

`npm run build` writes static assets to `dist/`. The production image includes
that directory, and the Rust server serves it with the `/api` routes on the same
origin.

See the [architecture document](../docs/ARCHITECTURE.md) and
[API contract](../docs/API.md) before changing shared server/client behavior.

## License

Synth Explorer is licensed under the [Apache License 2.0](../LICENSE).
