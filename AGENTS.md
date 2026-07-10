# Agent Instructions — Synth Explorer

Read this file at the start of every task here before changing code, running
project commands, or giving workflow guidance. It is the default operating policy
unless the user explicitly overrides part of it. If you have persistent or
dir-scoped memory, record a reminder that this workspace requires reading
`AGENTS.md` first.

## Fable Models: Read FABLE.md First

If you are running as **Fable** (`claude-fable-5`), read `FABLE.md` in the
workspace root before anything else and follow it as a layer on top of this file:
Fable does the high-level analysis and orchestration and delegates implementation
and execution to Codex, Opus, and Sonnet agents. Any other model — or a subagent
Fable dispatched to run a specific task — ignores `FABLE.md` and follows this file
normally.

## What This Project Is

Synth Explorer is a browser-based RTL exploration tool — Compiler Explorer for
hardware. It synthesizes Verilog/SystemVerilog with Yosys (generic gates, LUT4/
LUT6, or FPGA target flows), then provides **graph-first circuit analysis**:
timing-path endpoints, longest logical paths, fanin/fanout cones, fanout ranking,
and source cross-probing. The main goal is interactive exploration of how RTL
synthesizes — not a prettier full-schematic renderer. See `PLAN.md` for the full
architecture and `docs/API.md` for the server contract.

- `server/` — Rust (axum) backend: yosys runner, netlist parser, analysis engine, API.
- `web/` — React + TypeScript + Vite frontend: editor, analysis tabs, cone viewer.
- `examples/` — validation Verilog designs exercised by tests and the UI.
- `docs/` — API contract and design docs.

All analysis here is **structural/logical**, not post-route timing — keep that
caveat visible in UI and docs whenever timing-like numbers are shown.

## Operating Assumption

- Users here may be non-technical and may not know git, branch, worktree, PR,
  merge, or deployment best practices. The agent owns good source-control
  hygiene without being asked.
- The agent proactively, without waiting to be told: keeps `main` current;
  isolates feature work on dedicated branches/worktrees; plans substantial work as
  coordinated parallelizable units; runs independent discovery/implementation in
  parallel when safe; checks status before risky git ops; syncs feature branches
  with `origin/main`; resolves merge conflicts carefully; verifies before proposing
  merge; commits finished, verified work automatically (staging files by name);
  opens PRs before merge, then runs the review agents on the branch diff; and asks
  explicit confirmation before final merge or other irreversible steps.
- Treat "push this to main", "get this onto main", and similar as requests to
  prepare the work for `main` via the PR workflow, unless the user explicitly says
  to bypass PR and direct-push.
- If this file conflicts with a repo-local `AGENTS.md`, follow this file.
- Don't assume the user will notice unsafe git state, stale branches, or missing
  verification — check and communicate them clearly.
- Once a branch's PR is merged into `main`, delete that branch's worktree.

## Implementation Discipline

- Change the real code in place: one canonical implementation, modified directly.
- No shadow implementations — a second parallel copy of a function, class, module,
  endpoint, component, script, or code path that duplicates something instead of
  editing it. Edit the existing thing and delete what it replaces in the same
  change.
- No gating by default. New behavior ships live and unconditional — no feature
  flags, env toggles, config switches, `if enabled` branches, version checks, or
  commented-out / dead alternate paths to hide, stage, or "safely roll out" a
  change.
- No legacy or backward-compat by default — no bridge shims, dual-path fallbacks,
  old API behavior, deprecated aliases, or compat layers. Update every caller and
  remove the old path in the same branch (the pre-PR cleanup rule enforces this).
  Keep one explicit source of truth and fail clearly when a required input is
  missing, rather than silently accepting a legacy shape or falling back.
- These rules apply to plans as much as to code. The only way any of the above
  enters the work is an explicit user request; if you think a gate, parallel path,
  or compat layer is genuinely warranted, stop and ask first (state why, get
  approval) — never add one silently or "to be safe".
- Prefer the smallest direct change that fully replaces the old behavior.

## Resource And Performance Awareness

- Netlists get big: a few thousand cells is routine, hundreds of thousands is
  possible. Analysis algorithms must be linear or near-linear in graph size —
  no all-pairs anything, no per-bit quadratic blowups.
- The graph model is bit-level; keep node/edge representations compact (indices,
  not string-keyed maps, on hot paths) and avoid cloning the graph per request.
- Cone/path API responses must be bounded (depth/size limits with truncation
  flags) — never stream an unbounded subgraph to the browser.
- The frontend renders only requested cones, never the full netlist by default;
  layout (elkjs) runs in a worker and is capped by node count with a clear
  "too large, narrow the selection" fallback.
- Yosys runs are subprocesses with timeouts and output-size caps; a hung or huge
  synthesis must fail cleanly, not wedge the server.

## Security

- The server executes yosys on user-provided source text. Never interpolate user
  input into a shell string — build yosys script files and argv arrays directly,
  sanitize extra-args tokens against an allowlist pattern, and run in a temp dir
  that is always cleaned up.
- This is a local-first developer tool; still, treat the synthesize endpoint as
  untrusted input (size limits, timeouts, no path traversal via file names).
- No secrets belong in this repo. There are no external credentials in the
  steady state; if one ever becomes necessary, source it from the environment and
  ask the user where they want it managed.

## Workspace Model

- The workspace root is a worktree container, not a git checkout: it holds
  `repo.git` (canonical git metadata), the `main/` worktree, and feature
  worktrees. This guide is versioned in the repo and symlinked at the workspace
  root, so it reads the same from the container root or inside any worktree.
  Steady-state layout:

```text
<workspace-root>/
  AGENTS.md
  repo.git/
  main/
  <feature-worktree-1>/
  <feature-worktree-2>/
```

- `main/` is reserved for the `main` branch only — never a feature worktree.
  Feature work happens in its own worktree and branch.
- From the workspace root, use `git --git-dir=<workspace-root>/repo.git ...`; from
  an attached worktree, normal `git ...` is fine.

## Main Worktree Rule

- Before feature work, update `origin` and ensure local `main` matches
  `origin/main`:
  `git -C <workspace-root>/main checkout main`
  `git -C <workspace-root>/main pull --ff-only origin main`
- If `main/` is dirty or on a non-`main` branch, don't hijack it — preserve the
  in-progress work and restore a clean `main` worktree separately first.
- Inspect before any branch-changing operation: `git worktree list`,
  `git branch -vv`, `git status -sb`, `git fetch origin --prune`.

## Starting Work

- First decide whether the request belongs to an existing feature branch. If it
  already has a worktree, continue there — never create a second worktree for the
  same branch. If it's new, create a worktree and branch from updated `main`. Keep
  the worktree directory name equal to the branch slug.

New feature:

```bash
git --git-dir=<workspace-root>/repo.git fetch origin --prune
git -C <workspace-root>/main checkout main
git -C <workspace-root>/main pull --ff-only origin main
git --git-dir=<workspace-root>/repo.git worktree add \
  <workspace-root>/<feature-slug> \
  -b <feature-slug> \
  main
```

Continue a feature:

```bash
git --git-dir=<workspace-root>/repo.git worktree list
git --git-dir=<workspace-root>/repo.git branch -vv
```

## Parallel Work Planning

- For non-trivial work, the coordinating agent writes a short plan first: critical
  path, independent subtasks, likely shared files/contracts, and the verification
  needed before PR or merge.
- When the user says to implement a plan, execute end-to-end without stopping
  between steps: fan independent, cleanly-owned subtasks out to parallel workers,
  commit each finished/verified piece, sync and ready the PR, run the review agents
  in parallel, then notify that it's ready. Only the final merge needs explicit
  confirmation.
- Prefer parallel agents when subtasks advance independently and don't touch the
  same files, schemas, lockfiles, generated artifacts, or config at once. Use
  read-only parallel agents freely for separable discovery, docs inspection, test
  identification, API-contract checks, or option analysis.
- One coordinating agent owns source-control and release: worktree setup, branch
  sync, git ops, integration, conflict resolution, PR creation, merge, cleanup.
- Give parallel implementation workers explicit ownership: the files/modules each
  owns, the behavior to implement, the tests to run, and a reminder that others may
  be working and unrelated changes must not be reverted. Never put two workers on
  the same files or tightly-coupled modules at once — if it can't split cleanly,
  serialize or narrow scopes.
- Don't use parallelism to bypass the worktree rules, and don't parallelize risky
  shared operations (checkout, merge, rebase, branch deletion, lockfile regen,
  PR merge) — the coordinator serializes those after checking status.
- While workers run, the coordinator does non-overlapping work; when they finish,
  it reviews their changed paths, integrates, checks `git status -sb`, and runs
  focused verification for the whole feature. If parallelism would create unclear
  ownership, hidden conflicts, or more integration risk than it saves, go serial
  and say why. Coding especially is a weak fit for multi-agent fan-out — shared
  context and dependencies — and fan-out costs multiples more tokens, so gate it
  on task value and split out only genuinely independent units.

## Keeping A Feature Current

- Sync with `origin/main` before substantial work, before opening a PR, and again
  before merging — merge it into the feature branch locally so conflicts surface
  early, not at PR-merge time. Resolve conflicts in the feature worktree, rerun
  verification, then proceed; if `main` moves again before merge, repeat.

```bash
git fetch origin --prune
git merge origin/main
```

- Always check `git status -sb` after conflict resolution and before opening or
  merging a PR.

## PR And Merge Workflow

- When a feature is complete, verified, and the user wants it landed, open a PR
  from the feature branch into `main` — the default even if they say "push to
  main". Never direct-push to `main` unless the user explicitly confirms bypassing
  the PR flow, and never merge the PR until the user explicitly confirms. Merge
  with **squash**.
- Before opening the PR, make a cleanup pass over the code, tests, docs, scripts,
  routes, and contracts touched: delete stale, superseded, or now-unused code,
  including any legacy/compat paths the change obsoletes (see "Implementation
  Discipline").
- After opening the PR, launch the review agents in parallel on the branch diff —
  code review (correctness, guidelines, dead code), performance/memory review, and
  test verification. Summarize findings, fix the real issues on the branch and
  re-run, and note anything intentionally left. Opening the PR and running these
  reviews is automatic once the work is PR-ready; only merging needs confirmation.
- When PR-ready, notify the user and always include the PR number, branch name,
  and a brief summary of what the change set out to do. Then wait for explicit
  confirmation to merge.
- Before merging: `git fetch origin --prune`, ensure `main` is current, merge
  `origin/main` into the feature branch if needed, resolve conflicts, rerun
  relevant tests.
- After merge, bring local `main` forward, keep the workspace tidy, and prune the
  merged feature worktree and branch once confirmed safe.

## Local Development

Requirements: `yosys` (0.6x+) on PATH, Rust stable toolchain, Node 20+.

- Backend (from a worktree root):

```bash
cd server
cargo run                 # serves API on http://127.0.0.1:8787 and web/dist if built
cargo test                # unit + integration tests (integration tests invoke yosys)
```

- Frontend:

```bash
cd web
npm install
npm run dev               # Vite dev server on http://localhost:5173, proxies /api to :8787
npm run build             # production build into web/dist (served by the Rust server)
```

- Full local stack for manual/E2E testing: `npm run build` in `web/`, then
  `cargo run` in `server/`, open `http://127.0.0.1:8787`.
- Prefer checked-in helper scripts (`scripts/`) over ad hoc commands when they
  exist, and keep them current when the run shape changes.

## Verification

- Run focused checks for the changed area before opening or merging a PR.
  Backend: `cargo test` and `cargo clippy -- -D warnings` in `server/`.
  Frontend: `npx tsc --noEmit` and `npm run build` in `web/` (plus `npm test`
  where tests exist).
- Cross-cutting changes: run the full stack and exercise a synthesize → explore
  flow against `examples/` designs before calling it done.
- Trust objective checks (tests, typecheck, targeted diffs) over a model's
  self-review, which is unreliable; when a check fails, fix and re-run rather than
  accepting a self-assessment that it works.
- If verification can't be completed, say so explicitly.

## Safety

- Never overwrite unrelated user work to restore `main/`, and never force-reset or
  delete a dirty worktree without explicit user approval.
- If the layout deviates from the intended model, preserve in-progress work first,
  then normalize.
