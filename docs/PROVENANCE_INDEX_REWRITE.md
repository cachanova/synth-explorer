# Source Provenance Index Rewrite

## Objective

Replace the independently owned source maps, range indexes, probe hints,
synthetic source strings, procedural targets, and source-presence index with one
immutable `SourceProvenanceIndex`. Preserve the current browser and WASM
contracts while making source-to-graph and graph-to-source queries use the same
canonical span identity.

The rewrite is behavior-preserving. Any intentional change to user-visible
selection, status, focus, or truncation semantics belongs in a later change.

## Baseline

- Base commit: `0f5a9ad158a40729b70628baa64ddabd1faab007`
- Includes the declaration fallback hotfix and focused clock/reset wiring.
- Provenance-focused baseline: 58 Rust tests pass.
- Public contracts to preserve:
  - `source_map_json`
  - `source_ranges_for_bits_json`
  - `nodes_json`, including `NodeRef.src`
  - `source_selection_json`

## Canonical model

Each unique, normalized `(file, start line/column, end line/column)` tuple owns
one `SpanId`. Facts from every provenance source attach to that span without
collapsing their roles:

- final-graph native node attribution;
- reachable pre-flatten source presence;
- recovered node, exact-bit, and approximate-bit associations;
- continuous, procedural, declaration, block, signal, and output-port intent;
- exactness and completeness metadata.

The finalized index owns:

- interned files and canonical spans;
- a per-file interval index for source queries;
- distinct mapping facts when records share coordinates but differ in nodes,
  bits, approximation, or completeness;
- packed span-to-node associations plus adaptive dense/compact node reverse
  indexes;
- adaptive bit lookup: small mapping sets scan packed facts, while larger sets
  retain direct bit-to-mapping indexes;
- sparse per-file procedural-target line associations owned by the index;
- separate presence, recovered-presence, recovered-mapping, and hint admission
  budgets so one provenance role cannot starve another;
- structured completeness facts, projected onto the existing public status and
  truncation fields.

Presence-only spans use a compact record and allocate richer facts only when a
span has native nodes, recovered mappings, or directional policy. Native graph
coordinates are parsed once during construction and participate in the same
interval and node reverse indexes; exact queries no longer reparse `Node.src`.

`Analysis` owns exactly one finalized index. `AnalysisDesign` does not own a
second source index. Response structs remain serialization projections rather
than internal storage.

## Query boundary

The index provides four operations:

1. `resolve_selection(range, fallback_bounds)` returns roots, direct bits,
   direction, focus policy, presence, and relevant completeness.
2. `spans_for_node(node_id)` returns canonical native and recovered source spans
   for graph-to-editor navigation and `NodeRef.src` projection.
3. `spans_for_bits(bit_ids)` returns exact and approximate reverse mappings.
4. `source_map_projection(caps)` produces the existing bounded bulk response.

Cone traversal, graph grouping, and presentation remain in `Analysis`.

## Required invariants

1. Coordinates are 1-based and inclusive.
2. Columns remain non-authoritative for VHDL.
3. Exact mappings win before fallback.
4. Fallback applies only to a collapsed exact miss and only to eligible spans
   wholly inside the supplied statement bounds.
5. Same-line declarations remain distinct by their full coordinate tuple.
6. Empty known spans remain `optimized_or_absorbed`, not `unmapped` and not a
   reason to jump to a neighboring mapped span.
7. Precise recovered mappings suppress broad native attribution only on the
   selected lines they cover.
8. Bidirectional focus requires paired directions on the same signal span.
9. Incomplete procedural recovery never becomes authoritative.
10. Node and bit associations are valid, sorted, deduplicated, bounded, and
    deterministic.
11. Huge ranges remain sparse; no interval is expanded into an unbounded
    per-line structure.
12. Every omitted span or association marks the corresponding completeness
    dimension.
13. Existing JSON field names, omission rules, ordering, caps, and status
    precedence remain unchanged.
14. The index is immutable after finalization; legacy setters and extension
    methods are removed.

## Migration

### 1. Characterization and measurement

- Add exact wire-format goldens for all four WASM provenance surfaces.
- Add missing exact/fallback, optimized-neighbor, reverse-ordering,
  node-source-union, malformed-source, and mixed-completeness regressions.
- Add a deterministic benchmark harness over real precomputed Verilog/VHDL
  designs plus synthetic cap/strategy stress tests.
- Record construction time, total analysis heap, provenance heap, forward query
  latency, node reverse latency, bit reverse latency, and response hashes.

### 2. Index foundation and reverse queries

- Introduce interned file/span identifiers and an immutable builder/finalizer.
- Ingest final-graph native spans, reachable pre-flatten presence, and recovered
  facts.
- Migrate bit-to-source and node-to-source queries.
- Remove `synthetic_src` and the full-range reverse scan in the same change.

### 3. Forward selection

- Move exact matching, presence, nearest fallback, directional policy,
  procedural narrowing, direct-bit collection, and completeness projection into
  the index.
- Remove `source_map`, `source_ranges`, `source_probe_hints`, and
  `procedural_targets` from `Analysis`.
- Remove `SourceLineIndex` and `AnalysisDesign.source_index`.
- Stop passing a separate source index through the WASM selection path.

### 4. Construction cleanup

- Make recovered provenance feed the builder as typed facts.
- Keep `SourceRangeMapping` only as a transient builder input and public DTO;
  retain distinct compact mapping facts inside a canonical coordinate span.
- Remove probe-hint interval indexes, procedural-range conversion, source-map
  construction, mutation setters, and formatted synthetic-source maps.
- Retain public response DTOs only at the serialization boundary.

### 5. Verification and comparison

- Require exact behavior/wire parity for the characterization corpus.
- Run all Rust, WASM, frontend, and browser-local synthesis checks.
- Rebuild and verify the checked-in analysis WASM.
- Compare the rewrite against the frozen baseline using identical release
  builds, fixtures, warmup, iteration counts, and machine conditions.
- Run independent correctness, performance/memory, and adversarial-test
  reviews before opening the PR.

## Performance gates

- No query benchmark may regress by more than 10% without an explained,
  measured tradeoff.
- Analysis construction must not regress by more than 20%.
- Total analysis heap must not increase.
- A 100,000-node native-line stress case must retain only the admitted bounded
  associations for both shared and unique coordinates.
- Construction and queries must remain linear or near-linear and respect all
  existing caps.

## Measured comparison

The frozen baseline and rewrite were built in separate release target
directories and exercised with the same Criterion harness. All six fixtures
match their committed source-map, supported exact/fallback selection,
node-source, and bit-source digests. CI executes the frozen benchmark in test
mode, and the WASM test freezes the complete JSON of all four public provenance
surfaces.

| Fixture | Total retained heap | Provenance heap |
|---|---:|---:|
| Round-robin Verilog | 91,220 -> 82,185 (-9.9%) | 21,561 -> 12,526 (-41.9%) |
| Round-robin VHDL | 146,870 -> 145,190 (-1.1%) | 7,213 -> 5,533 (-23.3%) |
| Priority encoder VHDL | 285,154 -> 284,537 (-0.2%) | 3,491 -> 2,874 (-17.7%) |
| Barrel shifter Verilog | 1,092,598 -> 1,079,389 (-1.2%) | 25,796 -> 12,587 (-51.2%) |
| Inferred FIFO Verilog | 1,230,136 -> 1,212,877 (-1.4%) | 36,568 -> 19,309 (-47.2%) |
| Inferred FIFO VHDL | 1,254,232 -> 1,251,472 (-0.2%) | 10,147 -> 7,387 (-27.2%) |

Representative median release timings from the same run:

| Query | Baseline | Rewrite | Change |
|---|---:|---:|---:|
| Round-robin construction | 614.53 us | 288.79 us | -53.0% |
| Round-robin exact selection | 10.63 us | 6.57 us | -38.2% |
| Round-robin fallback selection | 10.09 us | 6.37 us | -36.9% |
| Round-robin node reverse, 46 nodes | 9.01 us | 7.84 us | -13.0% |
| Round-robin bit reverse, 1 bit | 127.27 ns | 86.73 ns | -31.9% |
| Round-robin bit reverse, 39 bits | 552.83 ns | 252.10 ns | -54.4% |
| FIFO construction | 8.344 ms | 4.601 ms | -44.9% |
| FIFO exact selection | 1.127 ms | 0.748 ms | -33.6% |
| FIFO fallback selection | 1.123 ms | 0.768 ms | -31.6% |
| FIFO node reverse, 200 nodes | 42.89 us | 30.90 us | -28.0% |
| FIFO bit reverse, 200 bits | 5.289 us | 1.032 us | -80.5% |

Criterion samples are sensitive to host load; the committed digest assertions
are the behavior gate, while the table records the observed directional
performance comparison on the implementation host.

## Compatibility note

The browser and WASM wire contracts are unchanged and frozen by payload
digests. The Rust-only `SourceLineIndex` type and the separate
`AnalysisDesign.source_index` field are intentionally removed rather than kept
as compatibility shims; all workspace consumers now use the canonical index
owned by `Analysis`.

## Non-goals

- Changing source-selection UX or status precedence.
- Localizing the currently global truncation signal in user-visible responses.
- Removing the exported bulk source-map worker/API contract.
- Changing synthesis, graph traversal, grouping, or layout semantics.
- Sending structured spans to the frontend in place of the current `src`
  string contract.
