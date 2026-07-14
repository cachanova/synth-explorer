# Synth Explorer — Server API Contract

This is the contract between `server/` (Rust, axum, port **8787**) and `web/`
(React/TS). Both sides implement exactly this. Changes to this file are a
cross-cutting decision owned by the coordinating agent.

All endpoints are JSON. Errors return HTTP 4xx/5xx with body
`{ "error": string, "log"?: string }`. The server also serves the built SPA
from `web/dist` at `/` (SPA fallback to `index.html` for non-`/api` routes).

## GET `/healthz`

Returns process and build metadata used by container health checks, deployments,
and external monitoring:

```ts
{
  status: "ok";
  commit: string;        // full Git commit in production; "unknown" in local builds
  version: string;       // server crate version
  yosys_version: string; // captured by the required startup preflight
}
```

The server does not start if the Yosys preflight fails.

## Shared shapes

```ts
// A node in the analysis graph. Numeric ids are stable within one design.
export type NodeKind = "cell" | "port" | "const";

export interface NodeRef {
  id: number;
  kind: NodeKind;
  name: string;         // human name: cell name (cleaned), "a[3]" for port bits, "1'b0" for consts
  cell_type?: string;   // "$lut", "$_NAND_", "$add", "SB_LUT4", ... (kind === "cell")
  seq?: boolean;        // sequential cell (FF/memory/blackbox boundary)
  register?: boolean;   // ordinary register/latch; false for memories/SRLs/blackboxes
  src?: string;         // yosys or recovered alias provenance, separated by "|"
}

export interface GraphNode extends NodeRef {
  is_root?: boolean;    // the node the cone was requested for
  is_boundary?: boolean;// traversal stopped here (startpoint/endpoint/limit)
  depth?: number;       // comb depth from startpoints (absent for seq/port nodes)
  params?: Record<string, string>; // e.g. { "LUT": "0111...", "WIDTH": "4" }
  controls?: {
    role: "clock" | "reset" | "set" | "enable" | "other";
    pin: string;
    net_name: string;
    driver_id: number;
    fanout: number;
    active_low?: boolean;
    synchronous?: boolean; // reset/set behavior when known from the primitive
    src?: string;          // control-driver source attribution when available
    generated?: boolean; // clock/reset/set is not a direct input/buffer-chain source
  }[];                   // label-connected controls omitted from ordinary wiring
  width?: number;        // grouped bus node: member-bit count (group_vectors only)
  members?: number[];    // grouped bus node: the real per-bit ids it collapses
}

export interface GraphEdge {
  from: number;         // driver node id
  to: number;           // sink node id
  from_port: string;    // e.g. "Y", "Q"
  to_port: string;      // e.g. "A", "D"
  net_name: string;     // best human name for the net ("sum[3]" or "$auto$123")
  bits: number[];       // yosys bit indices carried by this edge (parallel bit
                        // edges between the same node/port pair are merged)
  control?: boolean;    // clock/reset/enable pin connection
}

export interface Subgraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;   // hit a node/depth/merged-edge/projection-work cap
}
```

## POST `/api/synthesize`

Request:

```ts
{
  files: { name: string; content: string }[]; // name: bare filename, [A-Za-z0-9._-]+, .v/.sv
  top?: string;          // omitted -> yosys -auto-top
  mode: "rtl" | "gates" | "lut4" | "lut6" | "ice40" | "ecp5" | "xilinx";
  extra_args?: string;   // flags for the selected synthesis pass; see below
}
```

There are no dedicated fields for Xilinx options like the target family or
retiming: those are ordinary `synth_xilinx` flags, so the client passes them
through `extra_args` (e.g. `-family xcup -retime`). The webpage's Target and
Retime controls simply edit that flags string.

`extra_args` is appended to the mode's `prep`, `synth`, or `synth_*` command;
it does not accept global Yosys CLI flags or arbitrary script commands. Values
are split on whitespace and every token must match
`^[A-Za-z0-9_+=.,:-]+$`. Supported flags are mode-specific, and invalid or
conflicting combinations return a synthesis error with the Yosys log.

Response `200`:

```ts
{
  design_id: string;     // content hash; identical input returns the same id
  top: string;           // resolved top module
  mode: string;
  stats: {
    num_cells: number;
    cells_by_type: Record<string, number>;
    num_register_bits: number;
    num_register_groups: number;
    num_inputs: number;    // port bit counts
    num_outputs: number;
    max_depth: number;     // worst weighted structural logic depth across all endpoints
    depths: {
      input_to_register: number | null;
      register_to_register: number | null;
      register_to_output: number | null;
      input_to_output: number | null;
    };
    cell_categories: {
      logic: number;
      registers: number;
      carry_special: number;
      infrastructure: number;
    };
    estimated_delay_ns?: number; // rough worst-case combinational delay (see below)
  };
  // estimated_delay_ns is a rough PRE-place-and-route figure: it sums
  // ballpark cell delays with a fanout-based (log-scaled) net-delay estimate
  // along the critical logic path — the same shape as a vendor tool's
  // post-synthesis "estimated" timing, NOT timing closure. Omitted when the
  // design has no combinational paths. The delay coefficients are Series-7
  // ballparks meant to be calibrated against a real vendor report.
  warnings: string[];      // e.g. combinational loop reports, unmapped cells
  log: string;             // yosys log (tail, capped)
  memories_abstracted: boolean; // true when a generic mode exhausted a sandbox
                           // bound and succeeded on a retry that keeps inferred
                           // memories as $mem_v2 cells instead of flattening
                           // them to gates
}
```

Generic modes (`gates`, `lut4`, `lut6`) first synthesize exactly as before.
When that attempt exhausts a sandbox bound — memory, CPU, output size, or the
wall-clock timeout, since flattening a huge memory blows any of them depending
on the Yosys version — the server retries once with a script that stops `synth`
before `memory_map` and replays the fine stage without it, so large inferred
memories survive as abstract `$mem_v2` cells (rendered as MEM nodes, treated as
sequential boundaries). The response then carries `memories_abstracted: true`.
RTL and vendor modes never retry.

At most three distinct uncached `design_id` leaders are admitted: one complete
Yosys/parse/analysis/cache pipeline runs while two wait. Concurrent requests for
an existing in-flight id always subscribe to its server-owned task without
consuming another slot, and an initiating client disconnect does not cancel the
task. When all three distinct slots are occupied, a new distinct request gets
one final TTL-aware cache lookup and then returns `503` with `Retry-After: 5`.

Parsed designs are retained for 30 minutes from insertion in a 128 MiB
byte-weighted FIFO cache. Each entry is charged at least 64 KiB; otherwise its
weight is a deterministic estimate of retained allocation from owned
collection/string capacities plus cache key/entry overhead, not exact RSS. A
synthesized design whose charge exceeds the cache budget returns `507` rather
than an id that subsequent analysis routes could not resolve.

`400` on Yosys failure (body includes the Yosys `log`), `422` on validation
failure, `503` when three distinct leaders are active or waiting, `504` on
timeout, and `507` when one design cannot be retained in the cache.

Sandbox resource kills return `400` with a kind-specific `error` instead of
the generic "yosys failed":

- memory: `synthesis exceeded the sandbox memory limit — large memories cannot
  be flattened to gates; try RTL or a vendor mode, or reduce memory sizes`
  (only after the abstract-memory retry also failed, for generic modes)
- CPU: `synthesis exceeded the sandbox CPU limit — simplify the design or use
  a lighter mode`
- output size: `synthesis output exceeded the sandbox size limit`

## GET `/api/design/:id/endpoints`

```ts
{
  registers: {
    name: string;        // group name, e.g. "q" (bits grouped by stripping [i])
    width: number;
    cell_type: string;   // representative FF type, e.g. "$_SDFF_PP0_"
    clock: string | null;// net name driving CLK, null if none identified
    src?: string;
    worst_depth: number; // max comb depth into any bit's D
    bits: { bit: number; node_id: number; depth: number }[]; // per-bit FF cells, index-ordered
    output_aliases: {
      name: string;      // top-level output directly driven by this register
      width: number;     // declared output width
      bits: { output_bit: number; register_bit: number }[];
    }[];
  }[];
  outputs: { name: string; width: number; worst_depth: number; // non-aliased bits only
             bits: { bit: number; node_id: number; depth: number }[] }[];
  inputs:  { name: string; width: number;
             bits: { bit: number; node_id: number }[] }[];
}
```

`node_id` for a register bit is the **FF cell node**; for an output bit the
**port bit node**. Both are valid `node`/`to` params below. Output bits driven
directly by register Q through wiring or unconditional zero-depth buffers are
listed under that register's `output_aliases` and are not duplicated in
`outputs`.

Register `name` prefers the driven Q-net name; when synthesis destroys every
RTL name on a flip-flop (ABC restructuring plus vendor techmap can), it falls
back through visible Q- then D-net aliases, a directly driven output port, the
instance name, and a design-file `file:line` label, ending with a
deterministic `<cell_type>·<node_id>`. Names never surface hidden `$`-names,
and no two register groups share a displayed name.

## GET `/api/design/:id/paths?limit=25&to=<node_id>`

Ranked longest structural paths (deepest first). Paths with the same logical
endpoint, depth, and normalized structural route are grouped into bit cohorts;
different vector-bit routes remain separate. Direct registered-output aliases
share the register endpoint and do not create a duplicate zero-depth path.
With `to`, only variants ending at that node are returned.

```ts
{
  paths: {
    depth: number;               // weighted structural logic levels
    class: "input_to_register" | "register_to_register" |
           "register_to_output" | "input_to_output" | "other";
    endpoint_group: string;      // logical register/output/blackbox group
    endpoint_kind: "register" | "output" | "blackbox";
    bits: number[];              // structurally equivalent endpoint bits
    output_aliases: {
      name: string;
      width: number;
      bits: { output_bit: number; register_bit: number }[];
    }[];
    startpoint: NodeRef;         // input port bit / FF cell (Q) / blackbox
    endpoint: NodeRef;           // FF cell (D) / output port bit / blackbox
    endpoint_port: string;       // "D", output port name, ...
    nodes: NodeRef[];            // startpoint -> ... -> endpoint, capped at 512
  }[];
  comb_loops: string[];          // names of nodes excluded due to comb cycles
  truncated: boolean;            // response limit or bounded route sampling hit
}
```

To keep wide designs bounded, the server retains at most 64 deepest bit targets
per logical endpoint and examines at most `min(limit * 16, 8000)` targets overall
before grouping route variants. Candidates are assigned one per logical
endpoint, deepest groups first, before additional bits are selected round-robin.
A returned route contains at most 512 nodes while retaining its actual
startpoint and endpoint. Reconstructing candidates has a shared 65,536-node
work budget per request; deepest logical endpoint representatives consume that
budget before additional bit variants.
`truncated` is true when endpoint variants or route nodes were omitted.

## GET `/api/design/:id/cone?node=<id>&dir=fanin|fanout&max_depth=64&max_nodes=300&hide_control=true&hide_const=true&show_infrastructure=false`

Also accepts `nodes=<id,id,...>` for a multi-root cone: the union of every
root's cone traversed under the same single node/edge budget, with each root
marked `is_root`. When `nodes` is present it overrides `node`; duplicate ids
are deduplicated, at most 200 ids may be requested (`422` above that, `422`
for an empty or non-numeric list), and an unknown id yields `404`. Endpoint
rows use this to open one fanin graph covering every bit of a register group.

Returns a `Subgraph` for rendering. Traversal stops at sequential cells, port
bits, and consts (they appear as boundary nodes). With `hide_control`, ordinary
clock/reset/set nets and high-fanout enables are represented by `controls`
labels instead of edges; local enables remain wired data dependencies.
`hide_const` drops const drivers. With `show_infrastructure=false`, zero-depth
IO/clock buffers are collapsed into edges but remain present in implementation
statistics. Addressable shift-register LUTs are mixed boundaries: their stored
data input stops at the primitive, while address inputs traverse through the
primitive to preserve the selected address-to-output route and depth.
`max_nodes` is clamped server-side to 2000. Every `Subgraph` response retains at
most 10,000 merged edges. The same 10,000-item work budget bounds hidden
infrastructure projection before rendering; `truncated` is true when a node,
edge, or projection-work cap is reached.

With `group_vectors=true`, bit-parallel register and logic vectors collapse
into single nodes carrying `width` and `members` (see `GraphNode`), and the
`max_nodes` budget counts group-or-singleton units rather than member bits, so a
wide datapath fits in far fewer nodes. Multi-bit I/O ports collapse the same
way: bits sharing a port name become one bus node (`kind: "port"`, `width`,
`members`), while scalar ports stay per-bit. Bus edges between groups merge into
one edge carrying every bit and the vector net name. Grouped nodes use synthetic ids
`>= graph node count`; those ids are display-only and are rejected by `/nodes`
and by `node=`/`nodes=` (which address real per-bit ids). Defaults to `false`.

## GET `/api/design/:id/fanout?limit=50`

```ts
{
  drivers: {
    driver: NodeRef;         // FF cell, input port bit, or comb cell
    port: string;            // driving port ("Q", "Y", port name)
    net_name: string;
    fanout: number;          // total sink pins driven
    endpoints: number;       // distinct sequential/output endpoints reached (direct sinks)
    control: boolean;        // drives clock/reset/enable pins predominantly
  }[];   // sorted by fanout desc
}
```

## GET `/api/design/:id/netlist?max_nodes=1500&show_infrastructure=false&hide_control=true&hide_const=false&group_vectors=false`

Full design as a `Subgraph` (same caps and shapes; `truncated` set if the
design exceeds `max_nodes`). Constants are filtered before the node budget, and
control edges before the edge budget, so hidden content does not consume its
corresponding visible capacity. Used by the optional full-schematic view.
Grouping has the same semantics as `/cone`, and the node budget counts grouped
units.

## GET `/api/design/:id/source-map`

```ts
{
  files: string[];                       // filenames as submitted
  by_line: Record<string, number[]>;     // exact Yosys cell src only: "file.sv:12" -> node ids
  ranges: {
    file: string;
    start_line: number;
    end_line: number;
    node_ids: number[];
    mapping_incomplete: boolean;          // retained roots were capped for this interval
  }[];                                   // recovered assign/alias/port-declaration intervals
  truncated: boolean;
}
```

Recovered ranges are stored and queried as sparse intervals; a multiline span
does not create one entry per line. The public response returns at most 10,000
`by_line` entries with 20,000 total exact associations, plus at most 10,000
ranges with 20,000 total recovered associations. The internal recovered index
also retains at most 20,000 range-to-node associations globally.
`mapping_incomplete` marks each interval affected by that global bound or its
per-range root bound. `truncated` is true when either public response bound or
an internal per-line/per-range/global root collection bound was hit.
Internal line-cone and optimized/absorbed queries retain the complete sparse
interval index and its per-interval completeness independently of this bounded
response projection.

## GET `/api/design/:id/line-cone?file=<name>&start_line=<n>&end_line=<n>&max_nodes=400&hide_control=true&hide_const=true&show_infrastructure=false`

Source-range schematic for one to 200 RTL lines. Directional source constructs
return only the circuit owned by that selection: an input declaration follows
fanout, while output declarations, continuous assignments, and procedural
assignments follow fanin. When an output declaration is connected directly to
an ordinary register (optionally through transparent I/O buffers), its probe
also expands that register's inputs; upstream registers remain boundaries. A
non-assignment line inside an `always` block uses the union of every resolved
assignment target in that block. Unclassified source ranges retain the
bidirectional register-boundary envelope around cells whose `src` maps to the
selection. Every other traversal stops at sequential cells / ports / consts as
usual. A selected register may be the center of an unclassified envelope so its
upstream D and downstream Q neighborhoods are both visible without implying a
combinational path through it. If selected roots drive control pins, control
edges are included and `control` is true.
Accepts `group_vectors=true` (same grouping semantics as `/cone`); a group is a
root when any member is a root.

```ts
{
  status: "mapped" | "mapping_incomplete" |
          "optimized_or_absorbed" | "unmapped";
  control: boolean;
  highlight: number[]; // graph node ids owned by the selected source construct
  graph: Subgraph;
}
```

`mapping_incomplete` means a selected recovered interval exceeded provenance
association bounds. The graph contains any retained roots, but is partial; this
status takes priority over `mapped` and `optimized_or_absorbed` so capped
provenance is never presented as logic proven to have been optimized away.
`optimized_or_absorbed` means a pre-mapping synthesis object was attributed to
the range but no final object retained that attribution; it deliberately does
not claim whether the logic was removed, folded, shared, or absorbed. `422` for
an unknown file, invalid range, or a range longer than 200 lines.
Wire-only continuous assignments and port declarations, which Yosys JSON does
not reliably source-attribute, are indexed from the selected top's live
elaborated hierarchy and resolved through the final signal aliases. Continuous
assignments use inclusive `assign` spans; declaration aliases such as
`wire alias = value` retain the same recovery. Exact flattened instance scopes
are derived from the reachable pre-flatten module-instance graph, so
unreachable sibling modules cannot contribute aliases even on Yosys versions
without post-flatten scope metadata.
This recovered attribution is also returned by `/nodes` for graph-to-source
probing as one `file:start-end` source span rather than one alias per line.
Yosys attributes procedural cells to whole `always` blocks, so recovery also
indexes per-line assignment targets (`<lhs> <=` and leading `<lhs> =`
statements) and the enclosing block range, resolved through the same scope and
net-alias machinery. Probing `idx <= 5'd0;` therefore follows only the fanin of
`idx`; probing an `if`/`for`/block line follows the fanin of every resolved
target assigned by that block. Any parsing or resolution gap falls back to
Yosys source attribution rather than inventing ownership.
Files containing conditional-preprocessor branches use only Yosys provenance
to avoid attributing an inactive branch. If the LHS no longer exists, the span
reports `optimized_or_absorbed`. Source-range root collection retains at most
2,001 deterministic node ids so exceeding the 2,000-node graph ceiling is
reported through `graph.truncated` without constructing an unbounded root set.

## GET `/api/design/:id/nodes?ids=1,2,3`

Resolve node ids to display metadata.
Returns `{ "nodes": NodeRef[] }` in request order; unknown ids are omitted.
At most 200 ids per request (`422` above that).

## GET `/api/examples`

```ts
{
  examples: {
    name: string;        // "03_adder_chain"
    title: string;
    description: string;
    top: string;
    files: { name: string; content: string }[];
  }[];
}
```

## GET `/api/design/:id`

Returns the same body as the original `/api/synthesize` response (for reloads).
`404` if the id is unknown (in-memory store; designs don't survive restarts).
