# Synth Explorer

Shared rules live in `~/agents`. This file holds only Synth Explorer facts.

## Product and contracts

Synth Explorer is a browser-based RTL exploration tool. It synthesizes Verilog
and SystemVerilog with Yosys using generic gates, LUT4 or LUT6 mapping, and FPGA
target flows. It then provides graph-first analysis of endpoints, logical paths,
fanin and fanout cones, fanout ranking, and source locations. The product is an
interactive circuit explorer, not a full-schematic renderer.

- `analysis-core/`: canonical Rust netlist parser and graph analysis.
- `analysis-wasm/`: browser bindings for the Rust core.
- `web/`: the complete static product, including Yosys/analysis workers,
  bundled examples, React, TypeScript, Vite, and the elkjs cone viewer.
- `calibration/`: local-only native Yosys and optional Vivado tooling.
- `docs/ARCHITECTURE.md`: architecture and design rationale.

Analysis is structural and logical, not post-place-and-route timing. Keep that
caveat visible anywhere the product shows timing-like values. Real timing closure
requires tools such as nextpnr, OpenSTA, Vivado, or Quartus.

For high-judgment design work, inspect graph-model
types, the analysis core, worker contracts, and Yosys script construction.
Treat endpoint semantics, path dynamic programming, cycle handling, and synthesis
script shapes as architectural decisions.

## Performance

- Netlists may contain hundreds of thousands of cells. Keep analysis linear or
  near-linear in graph size. Avoid all-pairs work and per-bit quadratic behavior.
- Use compact numeric indices on hot paths. Do not clone the graph per request.
- Bound cone and path responses by depth and size and return truncation flags.
- The frontend renders requested cones, not the full netlist by default. Run
  elkjs in a worker, cap node counts, and ask the user to narrow oversized views.
- Give Yosys subprocesses timeouts and output-size limits. Fail cleanly on a hung
  or oversized synthesis.

## Security

- Treat submitted source, filenames, top names, and synthesis arguments as
  untrusted input.
- Never interpolate user input into a shell command. Write Yosys scripts to a
  temporary directory and pass argv arrays directly.
- Validate extra argument tokens against the existing allowlist and reject shell
  syntax, path traversal, and invalid filenames.
- Enforce source-size, runtime, log, and output limits. Always clean temporary
  directories.
- The project uses no external credentials in steady state. If that changes,
  load secrets from the environment through a user-approved manager.

## Local development

Requirements: Rust 1.97.1, Node 24.11.1, npm 11.6.2, and a current Chromium.
Native Yosys is only required for calibration; Vivado is an optional licensed
local calibration dependency.

```bash
cd web
npm install
npm run dev
npm run build
```

The Vite server listens at `http://localhost:5173`. Synthesis and analysis run
in browser workers; no backend process or API proxy exists. Production is the
static `web/dist/` output.

Prefer checked-in scripts when present and update them when the run shape changes.

## Verification

- Rust changes: run `cargo test --workspace --locked` and
  `cargo clippy --workspace --locked --all-targets -- -D warnings`.
- Frontend changes: run `npm test`, `npm run lint`, `npx tsc --noEmit`, and
  `npm run build` in `web/` as relevant to the changed area.
- Cross-cutting changes: build the static app and exercise a real
  synthesize-to-explore flow using `web/src/data/examples/`; assert zero API
  traffic.
- Preserve worker contracts and test structural facts, bounds, truncation,
  cycle handling, and source mapping when those areas change.

## PR workflow

- After implementation is complete and verified, commit, push, and open a PR
  without waiting for another request. Only merging requires user confirmation.
- After opening the PR, run correctness, performance and memory, and test reviews
  in parallel. Fix valid findings and rerun affected checks before reporting the
  PR ready.
