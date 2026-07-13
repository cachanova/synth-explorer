# Graph grouping, focus mode, endpoint paths, probe precision, and large-memory handling

Date: 2026-07-12. Status: awaiting user review.

## Goals

1. Group register/signal vectors and their bit-parallel intermediate logic into
   single multi-bit graph nodes (default on, toolbar toggle).
2. One shared Focus toggle that hides components outside the relevant set for
   line probes and path views instead of only highlighting them.
3. Clicking an endpoint row opens that endpoint's fanin graph (all logic on
   paths to it) with the endpoint highlighted.
4. Line probes inside procedural blocks resolve to the assigned signal, not
   every register in the enclosing always block.
5. Designs with large inferred memories synthesize in generic modes by keeping
   the memories abstract, and resource-limit failures report a clear message.

Non-goals: per-group click-to-expand (deferred; the global toggle covers v1),
post-place-and-route anything, editing behavior changes.

## A. Server: vector grouping projection

New boolean query parameter `group_vectors` on `/api/design/:id/netlist`,
`/cone`, and `/line-cone` (default false for API compatibility; the UI sends
true by default).

A grouping partition is computed once per design and cached alongside the
analysis (like the source map), in near-linear time:

1. **Register groups:** reuse the existing register-group analysis (name stem +
   clock/reset/enable signature).
2. **Combinational groups:** partition refinement. Initial signature is
   `(cell_type, port shape)`; each round refines by the group identity of every
   input pin's driver (and each output pin's sinks' groups) until fixpoint,
   with a bounded iteration count. A final pass verifies a 1:1 bit
   correspondence: each member connects to a distinct member of every adjacent
   group. Cells failing correspondence split out. Cell parameters (for example
   LUT INIT masks) are excluded from the signature: structure groups even when
   per-bit truth tables differ.
3. Cross-bit structure (carry chains, FSM state cones) stays ungrouped by
   construction. A vector whose bits diverge midway splits into sub-range
   groups (consistent with route-cohort splitting in Paths).

Projection changes when `group_vectors=true`:

- One node per group. Grouped nodes carry `width` (member count),
  `members: number[]` (bounded to the node budget), a display name derived from
  the member vector (`sum[17:0]`, or `sum ×18` when bits are non-contiguous),
  merged `src` spans (deduplicated, bounded), `is_root` if any member is a
  root, and merged `controls`.
- Edges merge per (source group, sink group, port pair) and carry the bit
  count.
- `max_nodes` budgets count groups, not member bits, so grouped views can
  represent much more of the design within the same caps. Truncation flags are
  unchanged in meaning.
- `/cone` accepts `nodes=<id,id,...>` (multi-root traversal already exists
  internally) so a whole group's fanin/fanout can be requested; `node=` remains
  supported.

`docs/API.md` is updated accordingly (cross-cutting change).

## B. Frontend: grouped rendering

- `graphOptions.groupVectors` (default **on**), rendered as a "group buses"
  toolbar toggle; part of the graph request key so toggling refetches.
- Group nodes render with a `×N` width badge; sublabel is the vector name.
  Merged edges render bus-style (thicker stroke, bit-count label).
- NodeCard for a group shows member count and merged source locations; fanin
  and fanout cone buttons use `nodes=<members>`.
- Selecting a group highlights the union of member source spans in the editor.

## C. Frontend: shared Focus toggle

- `graphOptions.focus` (default off), one toolbar toggle shared across views.
- A pure `filterSubgraph(sub, keepIds, boundaryHops = 1)` function runs before
  layout:
  - Line probe: keep `is_root` nodes plus one boundary hop (adjacent ports,
    registers, and const/boundary pins).
  - Path view: keep the path's node set (`coneReq.highlight`).
  - Endpoint fanin view: the cone already is the relevant set; the toggle is a
    visible no-op there (control disabled with a tooltip).
- Composes with grouping: a group is kept when any member is kept.
- Unit-tested as a pure function.

## D. Endpoints: row click opens the fanin graph

Clicking an endpoint row opens the endpoint group's fanin cone in the Graph tab
(`nodes=` all member bits, `dir=fanin`) with the endpoint highlighted. The
existing per-bit chips keep their bit-level cone links. Row affordance gets a
pointer cursor and title, consistent with the Fanout tab's clickable rows.

## E. Server: procedural-assignment probe precision

Motivation: Yosys attributes procedural cells to whole blocks, never to
individual assignments (verified empirically: both `$dff`s in
`02_priority_encoder.sv` carry `59.3-67.6`; nothing carries line 61).

- During provenance recovery, additionally index per-line procedural
  assignment targets: for each line inside an always block, tokenize
  `<lhs> <=` / `<lhs> =` (reusing the existing tokenizer) and record
  `line -> assigned identifier(s)` in the selected top's live elaborated
  hierarchy, resolved through the existing LHS net-alias machinery.
- In line-cone root collection: when every selected line has at least one
  parsed assignment target and at least one target resolves to a live net,
  restrict block-attributed roots to cells on the driving cones of those
  targets (the FF driving `idx` and its input cone for `idx <= …`). When
  parsing or resolution fails, fall back to today's behavior. Conditional
  preprocessor files keep Yosys-only provenance, as today.
- Selecting the whole block still probes everything (multiple targets).

## F. Server: large inferred memories and resource-limit reporting

- Generic modes (`gates`, `lut4`, `lut6`): the first attempt runs exactly as
  today, so ordinary designs pay nothing and small memories still flatten into
  explorable gate structure. When the attempt fails with a classified
  resource kill (see below), the server retries once with a memory-abstract
  script that runs the generic pipeline while keeping `$mem_v2` cells
  unmapped, and the response marks `memories_abstracted: true` so the UI can
  say so. The graph already renders `$mem_v2` as a MEM node (RTL mode);
  analysis treats it as a sequential boundary either way. The exact Yosys
  incantation (selection-scoped `memory_map` versus an explicit fine-stage
  pipeline) is validated against both supported Yosys versions (0.64 local,
  0.67 production) by tests, since `synth` internals shift between releases.
- The Yosys runner classifies failures: address-space kill (`std::bad_alloc`
  in the log or SIGABRT with allocation failure), CPU-limit kill (SIGKILL or
  SIGXCPU after `RLIMIT_CPU`), and output-size kill, each returning a distinct
  message such as "synthesis exceeded the sandbox memory limit — large
  memories cannot be flattened to gates; try RTL or a vendor mode, or reduce
  memory sizes", instead of the generic "yosys failed".
- Verified target: `StreamingHistogram.v` (8 lanes × 4096 words × 48 bits)
  currently fails only in generic modes; RTL (0.3 s), Xilinx (6.9 s), and
  ECP5 (5.9 s) succeed today. After this change generic modes must succeed
  with abstract MEM nodes.

## Testing

- Rust: partitioner unit tests (bit-parallel mux vector groups; adder carry
  stays ungrouped; FSM bits stay ungrouped; divergent vector splits into
  sub-ranges), grouped projection bounds/truncation tests, `nodes=` multi-root
  cone tests, procedural-LHS filter tests on the priority-encoder fixture,
  memory-threshold synthesis test, and failure-classification tests.
- Frontend: `filterSubgraph` unit tests, grouped-edge/label helper tests.
- Full stack: exercise examples plus `StreamingHistogram.v` across modes in
  the browser; Playwright additions for the two new toggles.
- Standard repo gates: cargo test/clippy, vitest, lint, tsc, build, e2e.

## Delivery

Feature branch `graph-grouping-focus` with same-named worktree from updated
main. Suggested landing order: F (isolated, high user value), E, D, C, then A+B
(largest). Each lands as reviewable commits in one PR unless size warrants a
split (A+B may become its own PR).
