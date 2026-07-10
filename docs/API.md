# Synth Explorer — Server API Contract

This is the contract between `server/` (Rust, axum, port **8787**) and `web/`
(React/TS). Both sides implement exactly this. Changes to this file are a
cross-cutting decision owned by the coordinating agent.

All endpoints are JSON. Errors return HTTP 4xx/5xx with body
`{ "error": string, "log"?: string }`. The server also serves the built SPA
from `web/dist` at `/` (SPA fallback to `index.html` for non-`/api` routes).

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
  truncated: boolean;   // hit max_nodes/max_depth; UI must say so
}
```

## POST `/api/synthesize`

Request:

```ts
{
  files: { name: string; content: string }[]; // name: bare filename, [A-Za-z0-9._-]+, .v/.sv
  top?: string;          // omitted -> yosys -auto-top
  mode: "rtl" | "gates" | "lut4" | "lut6" | "ice40" | "ecp5" | "xilinx";
  extra_args?: string;   // whitespace-separated tokens, each ^[A-Za-z0-9_+=.,:-]+$,
                         // appended to the mode's synth command
}
```

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
  };
  warnings: string[];      // e.g. combinational loop reports, unmapped cells
  log: string;             // yosys log (tail, capped)
}
```

`400` on yosys failure (body includes yosys `log`), `422` on validation
failure, `504` on timeout.

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
startpoint and endpoint.
`truncated` is true when endpoint variants or route nodes were omitted.

## GET `/api/design/:id/cone?node=<id>&dir=fanin|fanout&max_depth=64&max_nodes=300&hide_control=true&hide_const=true&show_infrastructure=false`

Returns a `Subgraph` for rendering. Traversal stops at sequential cells, port
bits, and consts (they appear as boundary nodes). With `hide_control`, ordinary
clock/reset/set nets and high-fanout enables are represented by `controls`
labels instead of edges; local enables remain wired data dependencies.
`hide_const` drops const drivers. With `show_infrastructure=false`, zero-depth
IO/clock buffers are collapsed into edges but remain present in implementation
statistics. Addressable shift-register LUTs are mixed boundaries: their stored
data input stops at the primitive, while address inputs traverse through the
primitive to preserve the selected address-to-output route and depth.
`max_nodes` is clamped server-side to 2000.

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

## GET `/api/design/:id/netlist?max_nodes=1500&show_infrastructure=false`

Full design as a `Subgraph` (same caps and shapes; `truncated` set if the
design exceeds `max_nodes`). Label-connected controls omit ordinary control
wires. Used by the optional full-schematic view.

## GET `/api/design/:id/source-map`

```ts
{
  files: string[];                       // filenames as submitted
  by_line: Record<string, number[]>;     // "file.sv:12" -> node ids
}
```

## GET `/api/design/:id/line-cone?file=<name>&start_line=<n>&end_line=<n>&max_nodes=400&hide_control=true&hide_const=true&show_infrastructure=false`

Source-range envelope: the register-boundary neighborhood of one to 200 RTL
lines. Takes the cells whose `src` maps to the selected range, then
returns the union of their fanin and fanout cones (traversal stops at
sequential cells / ports / consts as usual) as a `Subgraph`. Selected cells
have `is_root: true`. A selected register is allowed as the center so its
upstream D and downstream Q neighborhoods are both visible without implying a
combinational path through it. If selected roots drive control pins, control
edges are included and `control` is true.

```ts
{
  status: "mapped" | "optimized_or_absorbed" | "unmapped";
  control: boolean;
  graph: Subgraph;
}
```

`optimized_or_absorbed` means a pre-mapping synthesis object was attributed to
the range but no final object retained that attribution; it deliberately does
not claim whether the logic was removed, folded, shared, or absorbed. `422` for
an unknown file, invalid range, or a range longer than 200 lines.
Wire-only continuous assignments, which Yosys JSON does not source-attribute,
are indexed from `assign` spans and declaration aliases such as
`wire alias = value` in the selected top's live elaborated hierarchy, then
resolved by exact flattened instance scope through the final LHS net aliases.
This recovered attribution is also returned by `/nodes` for graph-to-source probing.
Files containing conditional-preprocessor branches use only Yosys provenance
to avoid attributing an inactive branch. If the LHS no longer exists, the span
reports `optimized_or_absorbed`.

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
