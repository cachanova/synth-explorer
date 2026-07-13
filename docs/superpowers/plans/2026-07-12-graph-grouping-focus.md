# Graph Grouping / Focus / Probe Precision / Memory Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement spec `docs/superpowers/specs/2026-07-12-graph-grouping-focus-design.md`: resource-kill classification + abstract-memory retry (F), procedural-assignment probe precision (E), endpoint-row fanin graphs (D), a shared Focus toggle (C), and server-side vector grouping with grouped rendering (A+B).

**Architecture:** Server work extends the existing bounded projection machinery in `server/src/analysis.rs` and the script builder in `server/src/yosys.rs`; frontend work extends `graphOptions` plumbing in `web/src/store.tsx` → `web/src/components/tabs/Graph.tsx` → `web/src/components/GraphView.tsx`. All new pure logic gets unit tests in the established styles (`server/tests/*.rs` with real yosys; vitest node-environment tests for `web/src/lib/*`).

**Tech Stack:** Rust (axum, serde), Yosys 0.64 local / 0.67 production, React + TypeScript + Vite, elkjs in a worker, vitest, Playwright.

## Global Constraints

- Preserve the API contract style of `docs/API.md`; every API change updates that file in the same task.
- Analysis stays near-linear in graph size; no per-request graph clones; bounded outputs with explicit `truncated` flags (Repo.md).
- One implementation: no feature flags, shadow paths, or compatibility shims. New params default to today's behavior at the API layer.
- Verification per Repo.md: `cargo test` + `cargo clippy -- -D warnings` in `server/`; `npm test`, `npm run lint`, `npx tsc --noEmit`, `npm run build` in `web/` as relevant; cross-cutting changes exercise a synthesize-to-explore flow on `examples/`.
- Commit after each green task with a message describing the result.
- Worktree: `/home/leela/code/synth_explorer/graph-grouping-focus` (branch `graph-grouping-focus`).

---

### Task F1: Classify yosys resource kills into distinct errors

**Files:**
- Modify: `server/src/yosys.rs` (error enum ~L87-101; status check ~L233-235)
- Modify: `server/src/api.rs` (`map_yosys_error` ~L1031-1053)
- Test: `server/src/yosys.rs` `#[cfg(test)]` module; `server/tests/api.rs`

**Interfaces:**
- Produces: `YosysError::ResourceLimit { kind: ResourceKind, log: String }` with `enum ResourceKind { Memory, Cpu, OutputSize }`, and `pub fn classify_failure(status: &std::process::ExitStatus, log: &str) -> Option<ResourceKind>`. Task F2 consumes `ResourceKind::Memory` to decide the retry.

- [ ] **Step 1: Write failing unit tests for `classify_failure`**

In the existing `#[cfg(test)] mod tests` in `yosys.rs` (uses no fake yosys — this function is pure):

```rust
#[test]
fn classifies_bad_alloc_as_memory_kill() {
    use std::os::unix::process::ExitStatusExt;
    let aborted = std::process::ExitStatus::from_raw(libc::SIGABRT);
    assert_eq!(
        classify_failure(&aborted, "terminate called after throwing an instance of 'std::bad_alloc'"),
        Some(ResourceKind::Memory)
    );
    // bad_alloc in the log wins even when yosys exits with a plain error code
    let failed = std::process::ExitStatus::from_raw(1 << 8);
    assert_eq!(
        classify_failure(&failed, "...std::bad_alloc..."),
        Some(ResourceKind::Memory)
    );
}

#[test]
fn classifies_cpu_and_output_kills() {
    use std::os::unix::process::ExitStatusExt;
    assert_eq!(
        classify_failure(&std::process::ExitStatus::from_raw(libc::SIGXCPU), ""),
        Some(ResourceKind::Cpu)
    );
    assert_eq!(
        classify_failure(&std::process::ExitStatus::from_raw(libc::SIGKILL), ""),
        Some(ResourceKind::Cpu)
    );
    assert_eq!(
        classify_failure(&std::process::ExitStatus::from_raw(libc::SIGXFSZ), ""),
        Some(ResourceKind::OutputSize)
    );
}

#[test]
fn ordinary_failures_are_not_resource_kills() {
    use std::os::unix::process::ExitStatusExt;
    let failed = std::process::ExitStatus::from_raw(1 << 8); // exit code 1
    assert_eq!(classify_failure(&failed, "ERROR: syntax error"), None);
}
```

Note `ExitStatus::from_raw` takes the wait(2) status word: a raw signal number means "killed by that signal"; `code << 8` means normal exit.

- [ ] **Step 2: Run to verify failure** — `cargo test -p synth-explorer-server classif` → FAIL (unresolved names).

- [ ] **Step 3: Implement**

In `yosys.rs`, near the limit constants:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResourceKind {
    Memory,
    Cpu,
    OutputSize,
}

/// Classify a failed yosys exit as a sandbox resource kill when possible.
/// bad_alloc in the log identifies an address-space kill even when the abort
/// unwinds into a normal-looking exit.
pub fn classify_failure(
    status: &std::process::ExitStatus,
    log: &str,
) -> Option<ResourceKind> {
    if log.contains("std::bad_alloc") {
        return Some(ResourceKind::Memory);
    }
    use std::os::unix::process::ExitStatusExt;
    match status.signal() {
        Some(libc::SIGABRT) => Some(ResourceKind::Memory),
        Some(libc::SIGXCPU) | Some(libc::SIGKILL) => Some(ResourceKind::Cpu),
        Some(libc::SIGXFSZ) => Some(ResourceKind::OutputSize),
        _ => None,
    }
}
```

Add the error variant:

```rust
#[error("synthesis exceeded sandbox limits")]
ResourceLimit { kind: ResourceKind, log: String },
```

At the `if !status.success()` site (~L233), classify first:

```rust
if !status.success() {
    if let Some(kind) = classify_failure(&status, &log) {
        return Err(YosysError::ResourceLimit { kind, log });
    }
    return Err(YosysError::Yosys { log });
}
```

In `api.rs` `map_yosys_error`, add an arm producing HTTP 400 with kind-specific text:

```rust
YosysError::ResourceLimit { kind, log } => {
    let message = match kind {
        ResourceKind::Memory =>
            "synthesis exceeded the sandbox memory limit — large memories cannot be \
             flattened to gates; try RTL or a vendor mode, or reduce memory sizes",
        ResourceKind::Cpu =>
            "synthesis exceeded the sandbox CPU limit — simplify the design or use a \
             lighter mode",
        ResourceKind::OutputSize =>
            "synthesis output exceeded the sandbox size limit",
    };
    ApiError::with_log(StatusCode::BAD_REQUEST, message, log)
}
```

(Match `ApiError::with_log`'s exact signature at its definition, ~api.rs:374-391.)

- [ ] **Step 4: Run** — `cargo test -p synth-explorer-server` → PASS; `cargo clippy -- -D warnings` → clean.

- [ ] **Step 5: Commit** — `git add server/src/yosys.rs server/src/api.rs && git commit -m "Classify yosys sandbox resource kills into distinct errors"`

---

### Task F2: Abstract-memory retry for generic modes

**Files:**
- Modify: `server/src/yosys.rs` (`build_script` ~L324-381; `run_yosys` ~L188; golden script test ~L509-527)
- Modify: `server/src/api.rs` (`synthesize_uncached` call site ~L536; `SynthesizeResponse` ~L320-328)
- Modify: `docs/API.md` (`POST /api/synthesize` response)
- Modify: `web/src/types.ts` (`SynthesizeResponse`), `web/src/store.tsx` or the Overview banner site — surface the notice (see Step 6)
- Test: `server/tests/api.rs`

**Interfaces:**
- Consumes: `ResourceKind::Memory` from F1.
- Produces: `build_script(input: &ValidatedSynth, memory: MemoryHandling) -> String` with `pub enum MemoryHandling { Map, Abstract }`; `run_yosys(input, memory: MemoryHandling)`; `SynthesizeResponse.memories_abstracted: bool` (serde default false; JSON field `memories_abstracted`).

Mechanism (validated empirically on yosys 0.64 against StreamingHistogram — 4,634 cells, 8 surviving `$mem_v2`): generic `synth` keeps memories abstract through the end of `coarse` (`memory -nomap`); `memory_map` is the head of `fine`. The Abstract script runs `synth ... -run begin:fine` and then replays fine without `memory_map`:

```text
synth <top_args> -flatten [-lut k] [extra] -run begin:fine
opt -fast -full
techmap
opt -fast
abc            # gates mode; `abc -lut 4|6` for lut modes; skipped when extra args contain -noabc
opt -fast      # skipped when -noabc
```

- [ ] **Step 1: Write failing script test** (extend the golden-string test module):

```rust
#[test]
fn abstract_memory_script_stops_before_memory_map() {
    let input = validated(&["design.sv"], Some("top"), SynthMode::Gates, "");
    let script = build_script(&input, MemoryHandling::Abstract);
    assert!(script.contains("synth -top top -flatten -run begin:fine\n"));
    assert!(!script.contains("memory_map"));
    assert!(script.contains("\nopt -fast -full\ntechmap\nopt -fast\nabc\nopt -fast\n"));
    // lut mode replays abc -lut
    let lut = validated(&["design.sv"], Some("top"), SynthMode::Lut6, "");
    assert!(build_script(&lut, MemoryHandling::Abstract).contains("abc -lut 6"));
    // -noabc suppresses the abc replay
    let noabc = validated(&["design.sv"], Some("top"), SynthMode::Gates, "-noabc");
    assert!(!build_script(&noabc, MemoryHandling::Abstract).contains("\nabc\n"));
}
```

(Reuse/adapt the existing `validated(...)` helper used by the current golden test; keep the existing golden test asserting `MemoryHandling::Map` output unchanged apart from the new argument.)

- [ ] **Step 2: Run to verify failure**, then implement `MemoryHandling` and the script branch. Vendor and RTL modes ignore `Abstract` (assert equal scripts in the golden test). `write_json netlist.json` stays the final line.

- [ ] **Step 3: Wire the retry in `api.rs`**

At the `run_yosys` call site in `synthesize_uncached`:

```rust
let first = run_yosys(validated, MemoryHandling::Map).await;
let (output, memories_abstracted) = match first {
    Ok(output) => (output, false),
    Err(YosysError::ResourceLimit { kind: ResourceKind::Memory, .. })
        if validated.mode.is_generic() =>
    {
        let output = run_yosys(validated, MemoryHandling::Abstract)
            .await
            .map_err(map_yosys_error)?;
        (output, true)
    }
    Err(err) => return Err(map_yosys_error(err)).into(),
};
```

Add `impl SynthMode { pub fn is_generic(&self) -> bool { matches!(self, Self::Gates | Self::Lut4 | Self::Lut6) } }`. Thread `memories_abstracted` into `SynthesizeResponse` (and into the cached design entry so `GET /api/design/:id` reproduces it). Adapt the exact `FlightResult`/error plumbing to what is at the call site — preserve the existing capacity/error semantics.

- [ ] **Step 4: End-to-end test** (real yosys, `server/tests/api.rs`): synthesize a large-memory design in gates mode and assert success + flag. Use a single-file design that OOMs when flattened but is small as text:

```rust
#[tokio::test]
async fn gates_mode_keeps_oversized_memories_abstract() {
    let source = r#"
module big_mem (
    input  wire        clk,
    input  wire        we,
    input  wire [11:0] waddr,
    input  wire [47:0] wdata,
    input  wire [11:0] raddr,
    output reg  [47:0] rdata
);
  reg [47:0] mem [0:4095];
  genvar i;
  generate
    for (i = 0; i < 8; i = i + 1) begin : g
      always @(posedge clk) if (we) mem[waddr ^ i] <= wdata;
    end
  endgenerate
  always @(posedge clk) rdata <= mem[raddr];
endmodule
"#;
    // POST /api/synthesize mode=gates via the existing test router helper;
    // assert 200, body["memories_abstracted"] == true, and stats present.
}
```

(Adapt body to the router-test helpers already in `tests/api.rs`; if this fixture flattens under the 2 GiB cap on CI, scale `mem` up until the first attempt reliably resource-kills, or assert instead on the observable contract: 200 + flag true + a `$mem`-kind cell reported in `/api/design/:id/netlist`. Multi-write-port trick above forces mux explosion like StreamingHistogram.)

- [ ] **Step 5: Update `docs/API.md`** — document `memories_abstracted` on the synthesize response and the resource-limit error messages.

- [ ] **Step 6: Surface in UI** — add `memories_abstracted?: boolean` to `web/src/types.ts` `SynthesizeResponse`; in the Overview tab (`web/src/components/tabs/Overview.tsx`), render a one-line notice when true: `Memories kept abstract — flattening them to gates exceeded sandbox limits.` styled like the existing depth disclaimer. Vitest not required (no logic); `npx tsc --noEmit` must pass.

- [ ] **Step 7: Full checks + commit** — `cargo test`, `cargo clippy -- -D warnings`, `cd web && npx tsc --noEmit`. Commit: `"Retry generic synthesis with abstract memories on sandbox kills"`.

Manual verification for the reviewer: paste `~/code/interviews/hrt/StreamingHistogram.v` in gates mode against a local server; expect success in seconds with 8 MEM nodes and the Overview notice.

---

*(Tasks E1-E2, D1, C1-C2, A1-A4, B1-B3 appended after code-exploration reports — see following sections.)*

---

### Task E1: Procedural-assignment line index and root filtering

**Files:**
- Modify: `server/src/source_provenance.rs` (tokenizer ~L247-420; entry `continuous_assign_provenance` L33)
- Modify: `server/src/analysis.rs` (`source_nodes_range` L714-745; `Analysis` struct ~L420; `extend_source_ranges` L675)
- Modify: `server/src/api.rs` (provenance wiring L576-591)
- Test: `server/src/source_provenance.rs` tests; `server/tests/api.rs`

**Interfaces:**
- Produces: `pub(crate) struct ProceduralTargets { pub by_line: HashMap<(String, usize), Vec<NodeId>> }` returned as a new field on `SourceAliasProvenance`; `Analysis::set_procedural_targets(targets)`; `source_nodes_range` filtering described below.

Implementation notes (complete behavior, worker writes the code):
1. In the byte-scanner in `continuous_assignments` (which already tracks `module`, sanitizes comments/strings via `sanitize_verilog`, computes lines via `line_at`), additionally recognize statements containing a top-level `<=` (nonblocking) that are NOT inside an `assign`/wire declaration: capture identifiers before the `<=` via the existing `identifiers()` helper, and record `(module, statement start line, lhs_identifiers)`. Also capture blocking `=` statements that BEGIN with an identifier immediately followed by `=` (not `==`, `<=`, `>=`, `!=`) while inside an `always` region (track `always` keyword ... `begin`/`end` depth the same way `module/endmodule` are tracked). `for (i = 0; ...)` capture is acceptable — unresolvable LHS names fall through harmlessly.
2. Resolve each captured LHS like continuous assignments: scope-qualify via `scopes_by_module`, look up in `roots_by_signal_name(graph)`; union resolved `NodeId`s per `(file, line)`. Skip files with conditional preprocessor directives (same rule as today).
3. Store on `Analysis` (new field `procedural_targets: HashMap<(String, usize), Vec<NodeId>>`, set from api.rs where `extend_source_ranges` is called).
4. In `source_nodes_range(file, start, end)`: after assembling `roots` as today, look up procedural targets for every line in `start..=end`. If EVERY line in the range that contributed any block-attributed root has a non-empty target entry, and the union `T` of targets is non-empty, then return `roots ∩ (T ∪ {roots whose every covering src span lies fully inside the selection})`; if the intersection is empty, return `roots` unchanged (fallback). Single-line selection on `idx <= 5'd0;` must yield only the `idx` register root(s); the envelope then pulls its mux/fanin cone.

Tests (write first, following the fixture and api-test styles):
- Unit test in `source_provenance.rs`: parsing `always_ff @(posedge clk) begin\n if (rst) begin\n idx <= 5'd0;\n valid <= 1'b0;\n end\nend` records line→`idx` and line→`valid` separately.
- API test in `tests/api.rs` (real yosys, source = `examples/02_priority_encoder.sv` content inline): line-cone on the `idx <= 5'd0;` line returns a graph whose root set contains the idx register and NOT the valid register (assert via `is_root` nodes' `name`/driven net); line-cone on the whole always block still returns both.

Steps: failing tests → implement → `cargo test` + `cargo clippy -- -D warnings` → commit `"Filter line probes by procedural assignment targets"`.

---

### Task D1: Multi-root cones — `nodes=` param + endpoint row behavior

**Files:**
- Modify: `server/src/api.rs` (`ConeQuery` L710-719, handler `cone` L721, reuse `parse_node_ids` L1059)
- Modify: `docs/API.md` (cone section)
- Modify: `web/src/api.ts` (`ConeOptions`/`getCone` L85-114)
- Modify: `web/src/store.tsx` (`ConeGraphRequest` L48-56, `openCone` L678-693)
- Modify: `web/src/components/tabs/Graph.tsx` (cone fetch L106-114)
- Modify: `web/src/components/tabs/Endpoints.tsx` (row onClick L360-370 and L425-435)
- Test: `server/tests/api.rs`; `web/src/store.test.ts` if a pure helper is extracted

**Interfaces:**
- Produces: `ConeQuery.nodes: Option<String>` (comma ids; when present, overrides `node`; same 200-id cap; roots deduped) feeding `Analysis::multi_root_cone` (exists, analysis.rs:888). Frontend `openCone(opts: { node?: number; nodes?: number[]; dir; label; highlight?: number[] })` — `nodes ?? [node]` stored on `ConeGraphRequest.nodes: number[]`; `getCone` serializes `nodes=1,2,3` when >1 else `node=`.
- Endpoints rows: `onClick` passes `nodes: endpoint.bits.map(b => b.node_id)`, `dir:'fanin'`, `highlight: endpoint.bits.map(b => b.node_id)`, label `` `${name} (fanin)` `` — all bits covered, endpoint highlighted, per-bit chips unchanged.

Server test: request `/cone?nodes=<two register ids>&dir=fanin` on the reg_mux fixture flow and assert both cones union under one cap (mirror `tests/core.rs:60` which already proves the engine; this test proves the HTTP param). Also `nodes=` with an invalid id → 422 (existing `parse_node_ids` semantics).

Steps: failing server test → server impl + docs → frontend types/plumbing → `cargo test`/clippy + `npm test`/`tsc`/lint → commit `"Expose multi-root cones and open endpoint rows as full fanin graphs"`.

---

### Task C1: `filterSubgraph` + shared Focus toggle

**Files:**
- Create: `web/src/lib/filterSubgraph.ts`; Test: `web/src/lib/filterSubgraph.test.ts`
- Modify: `web/src/store.tsx` (GraphOptions L82-88, DEFAULT_GRAPH_OPTIONS L136-142)
- Modify: `web/src/components/tabs/Graph.tsx` (optsKey L43; layout effect L144-175; toolbar L420-429 pattern)

**Interfaces:**
- Produces:
```ts
export function filterSubgraph(
  sub: Subgraph,
  keep: ReadonlySet<number>,
  boundaryHops = 1,
): Subgraph
```
Keeps nodes in `keep`; then up to `boundaryHops` rounds, adds direct neighbors of kept nodes that are context anchors (`kind !== 'cell'` or `seq` or `is_boundary`); keeps edges with both ends kept; preserves `truncated`. Returns the input object unchanged (same reference) when `keep` is empty or nothing is dropped.

Test cases (write first): root cell + adjacent port kept, distant cell dropped; register neighbor kept as anchor; empty keep returns identical reference; edges to dropped nodes removed; boundaryHops=0 keeps only `keep`.

Wiring in Graph.tsx: add `focus: boolean` to GraphOptions (default false) and to `optsKey`. In the layout effect, before `layoutSubgraph(result.graph, …)`:
```ts
const keep = graphOptions.focus ? focusKeepSet(coneReq, result.graph) : null
const toLayout = keep ? filterSubgraph(result.graph, keep) : result.graph
```
with `focusKeepSet` (same lib file, unit-tested): for `kind==='source'` → ids of `is_root` nodes; for `kind==='cone'|'netlist'` with `coneReq.highlight.length > 0` → highlight ids; otherwise `null` (toggle no-op). Toolbar: add a `focus` checkbox modeled on the infrastructure toggle, `title="Render only the selection-relevant components"`, disabled (with title explaining) when `focusKeepSet` returns null. Note the displayed node count line derives from the LAID graph — after filtering it must reflect filtered counts (verify where "N nodes · M edges" is computed and feed it `toLayout`).

Steps: failing vitest → implement → `npm test`/`tsc`/lint → commit `"Add Focus toggle that renders only selection-relevant components"`.

---

### Task R1: Rename user-facing "graph" to "schematic"

**Files:** `web/src/components/tabs/Graph.tsx` (tab registration lives where TabId labels render — locate the tab-bar label source), `web/src/store.tsx` (user-visible `label:` strings only, e.g. keep "Full netlist"), `web/src/components/tabs/Paths.tsx` ("graph" link text), `web/src/components/tabs/Fanout.tsx` + `Endpoints.tsx` (row `title` copy "…in Graph"), `web/src/components/NodeCard.tsx` if it says "graph", `web/e2e/production.e2e.ts` (any `Graph` text selectors), and empty-state strings ("No graph.").

Scope rule: USER-VISIBLE COPY ONLY. Do not rename code identifiers, CSS classes, TabId values, API routes, or files — `activeTab === 'graph'` stays. Grep for case-sensitive `Graph`/`graph` inside JSX text/`title=`/`aria-label`/`label:` strings; replace with `Schematic`/`schematic` where the user reads it. Run Playwright locally after (`PLAYWRIGHT_BASE_URL=http://127.0.0.1:8787 npx playwright test`) to catch selector breakage. Commit `"Rename user-facing graph copy to schematic"`.

---

### Task N1: Fix generic "FDRE" unnamed register endpoints

**Files:**
- Modify: `server/src/analysis.rs` (`discover_endpoints` grouping ~L1787-1854, `register_q_name` L2806)
- Possibly modify: `web/src/components/tabs/Endpoints.tsx` (display only if server data suffices)
- Test: `server/tests/examples.rs` or `tests/api.rs` with a xilinx-mode synthesis

Investigation COMPLETE (coordinator, 2026-07-12) — findings for the implementer:
StreamingHistogram.v xilinx mode yields 359 register endpoints; 299 have names like
`$techmap13155$abc$9934$auto$blifparse.cc:557:parse_blif$1004` with src pointing at
`/usr/bin/../share/yosys/xilinx/ff_map.v` (yosys library, NOT a design file) and no
surviving user Q-net alias — ABC restructures the FFs and ff_map.v techmap re-creates
them, destroying RTL names. Group widths are mostly 1-2. So: the fallback chain below
must (a) try D-net aliases (CellInfo.d_bits -> graph.net_aliases) since the comb net
feeding D often retains a user alias, and (b) treat library-file src as unusable —
derive src labels from DESIGN-file spans only (files list is available in Analysis).
Original investigation steps below remain for writing the regression fixture.

Investigation first (report findings in the task summary): synthesize `~/code/interviews/hrt/StreamingHistogram.v` (or a reduced fixture with the same property) in xilinx mode via `analyze_source`, dump `endpoints.registers` and find groups whose `name` is `$`-hidden or empty — these render as bare cell type ("FDRE") in the UI. Identify what usable identity exists on those FFs (Q-net aliases, D-net aliases, `hdlname` attribute, src spans).

Fix (server-side, single implementation): extend the group-naming fallback chain in `discover_endpoints`: `register_q_name` (today) → first non-hidden Q-net alias → first non-hidden D-net alias → `output_aliases[0].name` → `"<cell_type> @ <file>:<line>"` derived from the FF's first design-file src span → last resort `<cell_type>·<node_id>`. Groups must never render as identical bare cell-type rows. Add a test asserting no two register endpoints share the exact same displayed name and none is a bare `$`-name.

Commit `"Name register endpoints from net aliases or source when yosys names are hidden"`.

---

### Task A1: Grouping partition engine

**Files:**
- Create: `server/src/grouping.rs` (+ `mod grouping;` in `lib.rs`)
- Test: inline `#[cfg(test)]` using the hand-built-graph helpers pattern from `analysis.rs` tests (copy the tiny builders it needs: `combinational_node` L3687, `graph_from_parts` L3731, `add_test_edge` L3705, `register_bank_graph` L3332 — or import if visibility allows)

**Interfaces (Task A2/B consume exactly these):**
```rust
pub type GroupId = u32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GroupKind { Register, Comb }

#[derive(Debug, Clone)]
pub struct Group {
    pub kind: GroupKind,
    pub members: Vec<NodeId>,   // sorted, len >= 2
    pub label: String,          // "sum[17:0]" or "sum ×18" (non-contiguous)
    pub cell_type: String,
}

#[derive(Debug, Default)]
pub struct GroupPartition {
    pub groups: Vec<Group>,
    pub group_of: HashMap<NodeId, GroupId>,
}

impl GroupPartition {
    /// Near-linear: bounded partition refinement (max 8 rounds) + 1:1 check.
    pub fn build(graph: &Graph, registers: &[RegisterGroup]) -> GroupPartition;
}
```

Algorithm (implement exactly):
1. Seed register groups from `registers` (analysis.rs `RegisterGroup.bits[].node_id`) with `width >= 2`; label from group name + `[hi:lo]` when bit indices are contiguous.
2. Comb cells: initial signature = canonical `cell_type` string. Refinement round: each cell's new signature = `(old_sig, sorted list over incoming data edges of (driver_class, from_port, to_port), sorted list over outgoing data edges of (sink_class, from_port, to_port))` where `driver_class`/`sink_class` is the neighbor's current group id if grouped (registers count from round 0), else the neighbor's own signature class id for comb cells, else a class per (kind, port name) for ports/consts. Hash signatures to class ids per round (`HashMap<sig, id>`). Stop when the class count stops changing or after 8 rounds.
3. Candidate groups = classes with ≥2 comb members. Verify per adjacent class a 1:1 correspondence: for each member, its edge set to that adjacent class targets exactly one distinct member (build the bipartite match by iterating edges; reject the whole candidate class into singletons on any violation — e.g. carry chains where bit i feeds bit i+1, cells with fan-in from two bits of the same vector).
4. Labels for comb groups: from the dominant driven-net stem (strip `[k]` bit suffix via `strip_bit_suffix`); fall back to `"{cell_type} ×{n}"`.

Tests (TDD, write first):
- `register_bank_graph(2, 8)` → two register groups of width 8.
- A bit-parallel graph: 8 DFFs ← 8 MUX cells each fed by distinct port bits (build with `graph_from_parts`) → one comb group of 8 MUXes.
- A carry-chain graph: cells where cell i also feeds cell i+1 → NO comb group (1:1 check fails).
- FSM-like: 3 DFFs with structurally different fanin cones → no grouping.
- Divergent vector: 8 parallel cells where 4 feed one sink shape and 4 another → two groups of 4.
- Determinism: same input twice → identical partition ordering.

Commit `"Add bit-parallel grouping partition engine"`.

---

### Task A2: Quotient projection + `group_vectors` API param

**Files:**
- Modify: `server/src/analysis.rs` (Subgraph emission; `GraphNode` gains `width: Option<u32>`, `members: Option<Vec<u32>>`)
- Modify: `server/src/api.rs` (`ConeQuery`/`NetlistQuery`/`LineConeQuery` gain `group_vectors: Option<bool>`; `Design` gains the cached partition — build in `synthesize` pipeline api.rs:546-612)
- Modify: `docs/API.md` (all three endpoints + Subgraph node shape)
- Test: `server/tests/core.rs`, `server/tests/api.rs`

**Interfaces:**
- `Design.grouping: crate::grouping::GroupPartition` (built once after `Analysis::new`, from `analysis.endpoints().registers`).
- New emission path: after the existing per-bit traversal produces `(seen, edge_set)`, when `group_vectors` is on, collapse via the partition into a grouped `Subgraph`: one `GraphNode` per touched group (synthetic id = `graph.nodes.len() as u32 + group_id` — document this in API.md; UI treats ids as opaque), singleton nodes pass through with their real ids. Grouped node fields: `width=members.len()`, `members` (only members present in `seen`), `is_root` if any member root, `depth` = max member depth, merged `controls` (dedup by role+net), merged `src` (dedup fragments, cap 8), `name` = group label, `cell_type` = group cell_type, `seq` from kind. Edges collapse per (group-or-node id pair, port pair) with `bits` concatenated (cap at existing edge caps); `control` OR-ed.
- **Budget semantics:** to honor "budgets count groups", the cone/netlist traversal cap when `group_vectors` is on counts UNIQUE GROUP-OR-SINGLETON ids added to `seen`, not raw nodes. Implement by threading an optional `&GroupPartition` into `multi_root_subgraph`'s cap accounting (count `group_of.get(id).map(...)` distinct keys). `full_netlist` similarly takes the first N group-units. Truncation flags keep today's meaning.
- `/nodes?ids=` must keep working with real per-bit ids; grouped synthetic ids are NOT accepted there (document).

Tests: netlist of `register_bank_graph(2,8)` with grouping on → 2 register group nodes (+ports), each `width==8`; cap honoring: `max_nodes=1` with two groups → 1 group + `truncated`; cone from a member id lands on its group node with `is_root`; line-cone grouped response keeps status semantics; HTTP param plumbed for all three endpoints (api.rs test asserting a `width` field appears when `group_vectors=true` and not otherwise).

Commit `"Project grouped subgraphs behind group_vectors"`.

---

### Task B1: Frontend grouped rendering

**Files:**
- Modify: `web/src/types.ts` (GraphNode: `width?: number; members?: number[]`)
- Modify: `web/src/api.ts` (`group_vectors` on ConeOptions/LineConeOptions/getNetlist)
- Modify: `web/src/store.tsx` (GraphOptions `groupVectors: boolean` default TRUE in DEFAULT_GRAPH_OPTIONS)
- Modify: `web/src/components/tabs/Graph.tsx` (optsKey + fetch params + toolbar checkbox "group buses")
- Modify: `web/src/lib/symbols.ts` (`symbolKind`: nodes with `(node.width ?? 0) >= 2` route to their base kind — a grouped DFF still draws as a register, grouped LUT as LUT/box; no new SymbolKind needed)
- Modify: `web/src/lib/layout.ts` (`nodeDimensions`: nodes with `width >= 2` get `+14` height and width fitting the `×N` badge)
- Modify: `web/src/components/GraphView.tsx` (`NodeContents`: render `×{width}` badge chip using the existing `g-boundary-badge` slot pattern; edge rendering: when `edge.bits.length > 1`, add a small `<text>` bit-count label at the path midpoint and a `bus` class for thicker stroke; add `.g-edge.bus` CSS in `index.css`)
- Modify: `web/src/components/NodeCard.tsx` (show `width` and "members: N bits"; Fanin/Fanout cone buttons pass `nodes: node.members ?? [node.id]`)
- Test: `web/src/lib/layout.test.ts` (dimensions for width>=2), `web/src/lib/symbols.test.ts` (grouped node keeps base symbol); helper for the badge label if extracted
- Modify: `docs/API.md` only if field names shift during implementation (keep in sync with A2)

Steps: failing vitest for dimensions/symbols → implement → run `npm test`, `tsc`, lint, build → visual check against local server with `01_reg_mux` (expect ONE DFF node `q[7:0] ×8`, one MUX group, bus edges) and `03_adder_chain` (registers group; carry logic stays per-bit) → commit `"Render grouped vectors with width badges and bus edges"`.

---

### Task P1: Polish batch (frontend)

**Files/items (one commit each, all small):**
1. `web/src/index.css`: make the graph status banner background opaque (find the banner class used by "showing a graph snapshot…" / truncation banners; set solid `background-color` var) — fixes edges showing through text.
2. `web/src/components/tabs/Fanout.tsx`: numeric-aware ordering for equal-fanout rows — sort drivers by `(fanout desc, natural(name))` client-side with a `naturalCompare` helper in `web/src/lib/` + vitest (`d_in[2]` before `d_in[10]`).
3. Endpoints/Fanout stale indicator: when `store.analysisState !== 'current'`, render the small chip `showing previous results — refreshing` above the table (reuse the Graph banner styling), matching Graph's honesty.
4. Narrow viewport: in `index.css`, allow the analysis pane to scroll internally instead of the page (`overflow-x: auto` on the pane content, `min-width: 0` on flex children); page-level horizontal scrollbar must not appear at 500px width.
5. `web/src/lib/prettyType.ts` `shortNetName`: when the shortened segment still starts with a bare autoindex number (`/^\d+([./]|$)/`), strip through it; if nothing meaningful remains return the empty string (callers already treat empty as "suppress"). Update `prettyType.test.ts` accordingly — sublabels like `1866.genblk…`/`3763.A[4]` must no longer appear; genuinely meaningful tails (`new_n27`, `sum[3]`) still do.

Verification: vitest + tsc + lint + visual spot-check at 500px and on a xilinx adder graph. Commits per item.

---

## Execution notes (coordinator)

- Lanes: SERVER = F1→F2→E1→D1(server half)→A1→A2 in `graph-grouping-focus`; FRONTEND = C1→R1→P1→N1(investigation may need server change — if so it moves to the server lane) in worktree `schematic-ui` branched from `graph-grouping-focus` after F2 lands, merged back by the coordinator; D1 frontend half and B1 run after both lanes converge.
- Every task: TDD, run the listed checks, commit on green. Reviewer gate between tasks (coordinator).
- Final: full-stack verify with `examples/` + `~/code/interviews/hrt/StreamingHistogram.v` (all modes), Playwright, then PR with the three independent reviews per Repo.md.
