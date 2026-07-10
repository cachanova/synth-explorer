# Synth Explorer

Compiler Explorer for RTL. Paste Verilog/SystemVerilog, synthesize it with
[Yosys](https://yosyshq.net/yosys/) — generic logic gates, LUT4/LUT6 mapping, or
FPGA target flows (iCE40, ECP5, Xilinx) — and interactively explore the result:

- **Timing-path endpoints** — every register, top-level output, and blackbox
  boundary, searchable and grouped.
- **Longest logical paths** — ranked by combinational depth, with the full
  cell-by-cell path.
- **Fanin/fanout cones** — select a register or signal and see only the logic
  that drives it (or that it drives), not the whole schematic.
- **High-fanout nets** — ranked, with control (clock/reset/enable) nets labeled.
- **Source cross-probing** — click a synthesized cell, jump to the RTL line
  that produced it (via yosys `src` attributes).
- **Compare** — snapshot two versions of the code (or two synthesis modes) and
  diff depth, cell counts, and fanout.

A full-schematic view exists as an option, but the point of the tool is
**graph-first exploration** — full synthesized schematics stop being readable
almost immediately.

> **Caveat:** everything here is structural/logical analysis of the synthesized
> netlist (unit-delay depth, pin counts). It is genuinely useful for
> understanding how your code synthesizes and where the deep/wide spots are —
> but it is *not* post-place-and-route timing. Real timing closure needs
> nextpnr/OpenSTA/Vivado/Quartus.

## Running it

Requirements: `yosys` on PATH (tested with 0.64), Rust stable, Node 24.11.1
(npm 11.6.2).

```bash
cd web && npm install && npm run build && cd ..
cd server && cargo run
# open http://127.0.0.1:8787
```

Development: `cargo run` in `server/` plus `npm run dev` in `web/` (Vite on
:5173 proxies `/api` to :8787).

## Production

Production deploys [synthexplorer.dev](https://synthexplorer.dev) to one Hetzner
VM. Caddy terminates HTTPS, and the Rust server serves both the built
frontend and `/api`. GitHub Actions publishes an immutable container image to
GHCR and deploys that digest over SSH after each push to `main`.

See [docs/OPERATIONS.md](docs/OPERATIONS.md) for provisioning, DNS, deployment,
rollback, monitoring, and recovery instructions.

## Layout

- `server/` — Rust (axum): yosys runner, netlist parser, graph + analysis
  engine, HTTP API. See `docs/API.md`.
- `web/` — React + TypeScript + Vite UI: editor, analysis tabs, elkjs-based
  cone viewer.
- `examples/` — small validation designs (adder chains, priority encoders,
  high-fanout enables, FSMs, blackboxes) used by tests and the examples menu.
- `PLAN.md` — full design rationale and architecture.
- `AGENTS.md` / `FABLE.md` — operating policy for coding agents in this repo.
