# Source Provenance Architecture

## Purpose

Source provenance connects submitted HDL coordinates to the synthesized graph
and supports navigation in both directions:

- editor selections resolve to graph roots, signal bits, and focus policy;
- graph nodes and signal bits resolve back to source spans;
- the browser receives bounded source-map projections for display and lookup.

`SourceProvenanceIndex` is the canonical store for these relationships. It is
built during design analysis and is immutable after construction.

## Ownership and lifecycle

`AnalysisDesign::from_netlists` recovers provenance from the source netlist and
submitted files, builds a `SourceProvenanceIndex`, and transfers it to
`Analysis`. `Analysis` owns exactly one finalized index for the lifetime of the
design.

The index owns source identity, mappings, reverse indexes, selection policy,
and completeness metadata. `Analysis` consumes resolved probe facts to perform
cone traversal, grouping, focus-depth control, and response presentation. Those
graph operations do not belong to the provenance index.

Public response types are serialization projections of the index rather than
parallel sources of provenance truth.

## Canonical data model

Files and spans are normalized during construction. Each unique coordinate
tuple within a file has one canonical span:

```text
file + start line/column + end line/column -> SpanId
```

Coordinates are 1-based and inclusive. Columns are optional and are not
authoritative for VHDL.

A span may carry any combination of:

- native final-graph node attribution;
- reachable pre-flatten source presence;
- recovered node mappings;
- exact and approximate signal-bit mappings;
- fanin or fanout policy for declarations, signals, output ports, procedural
  statements, and blocks;
- per-mapping and per-file completeness state.

Mappings that share coordinates remain distinct when their node sets, bit
sets, approximation, or completeness differ. This preserves semantic
boundaries while still interning the coordinate span once.

Presence-only spans use a compact record. Rich span facts are allocated only
when a span has native nodes, recovered mappings, or directional policy.

## Construction

The index builder combines four inputs:

1. Native `src` attributes from final graph nodes.
2. Reachable source presence from the pre-flatten netlist.
3. Recovered declaration, assignment, node, and signal-bit mappings.
4. Directional probe hints and resolved procedural targets.

Native coordinates are parsed once during construction. Recovered facts are
normalized into the same file and span identities before the index is
finalized. Node IDs, bit IDs, and mapping records are sorted and deduplicated
to make query results deterministic.

Admission budgets are applied independently to source presence, recovered
presence, recovered mappings, probe hints, and associations. Omitting a fact
because of a bound records the affected completeness state.

## Index layout

Each file owns its submitted-file status, canonical spans, native line
associations, known source lines, procedural targets, and per-file
completeness. Spans are sorted by coordinates and paired with prefix maximum
end lines, allowing interval lookup without expanding multi-line ranges into a
per-line structure.

The finalized index also owns reverse indexes for:

- node to canonical native or recovered spans;
- node to recovered display spans used by `NodeRef.src`;
- signal bit to exact or approximate mappings.

Node reverse storage chooses a dense or compact representation based on the
key distribution. Bit lookup likewise adapts to the retained mapping set: it
keeps compact reverse indexes when the mapping count is large or the retained
association count is small, and scans the mappings when a small mapping set
would require a disproportionately large reverse index. These are storage
choices only and do not change query semantics.

## Source-to-graph selection

`resolve_selection` first evaluates the exact submitted range. The result may
include graph roots, exact signal bits, direction, local bidirectional focus,
output-register expansion, source-presence status, and completeness.

Exact coordinate matches take precedence. Precise recovered spans suppress
broad native line attribution only on the lines they cover. When columns are
absent or non-authoritative, selection uses line overlap.

If a collapsed caret selection has no exact mapping, the index may select the
nearest eligible recovered span on the same line. Fallback is allowed only
when:

- the caller supplies valid statement bounds;
- the caret lies inside those bounds;
- the candidate span lies wholly inside those bounds; and
- the exact location is not already known source.

Candidates are ordered by distance and then by their coordinates for stable
tie-breaking. This lets clicks on declaration indentation, type, or width map
to the nearby identifier while preserving exact-column disambiguation for
multiple declarations on one line. Known optimized or absorbed source does not
jump to a neighboring mapped span.

Directional policies are resolved from the matching canonical spans.
Bidirectional signal focus is local only when fanin and fanout intent share the
same signal span. Procedural targets are used only when their recovery is
complete; otherwise selection falls back to broader non-authoritative
attribution.

After provenance resolution, `Analysis` performs the requested graph cone
traversal. Local bidirectional selections use a bounded depth so Focus does not
devolve into the entire connected graph.

## Graph-to-source queries

Recovered node source projection uses direct reverse lookup into canonical
spans. `Analysis::node_ref` combines those recovered spans with the native
`Graph::Node.src` compatibility field, splitting and deduplicating the native
fragments before producing the existing `NodeRef.src` string.

Signal-bit source projection accepts a bounded, deduplicated bit set and
returns exact mappings before marking approximate matches. The index uses its
bit reverse indexes when that is cheaper than scanning the retained mappings.
Response ordering and truncation remain deterministic in either path.

## Source-map projection

`source_map` produces the browser-facing bulk view from the canonical index:

- submitted file names;
- bounded native line-to-node associations;
- bounded recovered range mappings; and
- a truncation indicator.

The projection preserves lexical line-key ordering across files and enforces
separate entry and association budgets. It is a compatibility surface for the
browser, not an independently maintained index.

The WASM boundary exposes the same provenance through:

- `source_map_json`;
- `source_ranges_for_bits_json`;
- `nodes_json`, including `NodeRef.src`; and
- `source_selection_json`.

## Completeness and bounds

Completeness is retained at the narrowest available level:

- global truncation records omitted mapping data that can affect the whole
  projection;
- per-file incomplete-span state records omitted coordinate facts;
- per-mapping incomplete state records a partially recovered association;
- query-local truncation records bounded root, bit, or procedural-target
  collection.

Selection and reverse queries propagate the relevant dimensions into existing
response fields. Large coordinate ranges stay sparse, and all returned node,
bit, line, and range collections respect their configured caps.

## Invariants

1. One immutable index owns all retained provenance for an analysis.
2. Forward and reverse queries refer to the same canonical span identities.
3. Coordinates are 1-based and inclusive; VHDL columns are non-authoritative.
4. Exact mappings win before bounded nearest-span fallback.
5. Same-line declarations remain distinct by their full coordinate tuples.
6. Known empty spans report optimized or absorbed source and prevent fallback
   to an unrelated neighbor.
7. Precise recovered mappings override native line attribution only where they
   overlap.
8. Bidirectional focus requires paired directions on the same signal span.
9. Incomplete procedural recovery is never treated as authoritative.
10. Associations and projections are sorted, deduplicated, bounded, and
    deterministic.
11. Omitted provenance marks the corresponding completeness dimension.
12. Public JSON field names, omission rules, ordering, caps, and status
    precedence remain stable.

## Architectural boundary

The provenance index does not perform synthesis, graph construction, cone
traversal, grouping, layout, or editor rendering. It does not replace the
browser's public source-map contract with internal span IDs. Its responsibility
ends after returning canonical, bounded provenance facts to `Analysis` or the
serialization boundary.
