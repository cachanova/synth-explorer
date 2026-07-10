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
  src?: string;         // yosys src attr, e.g. "design.sv:12.16-12.21" (may be absent)
}

export interface GraphNode extends NodeRef {
  is_root?: boolean;    // the node the cone was requested for
  is_boundary?: boolean;// traversal stopped here (startpoint/endpoint/limit)
  depth?: number;       // comb depth from startpoints (absent for seq/port nodes)
  params?: Record<string, string>; // e.g. { "LUT": "0111...", "WIDTH": "4" }
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
    max_depth: number;     // worst comb depth (cells) across all endpoints
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
  }[];
  outputs: { name: string; width: number; worst_depth: number;
             bits: { bit: number; node_id: number; depth: number }[] }[];
  inputs:  { name: string; width: number;
             bits: { bit: number; node_id: number }[] }[];
}
```

`node_id` for a register bit is the **FF cell node**; for an output bit the
**port bit node**. Both are valid `node`/`to` params below.

## GET `/api/design/:id/paths?limit=25&to=<node_id>`

Ranked longest structural paths (deepest first). Without `to`: top paths across
all endpoints (at most one path — the critical one — per endpoint bit). With
`to`: paths into that endpoint node only (its per-bit critical paths if the id
is an FF cell; ranked alternatives are future work).

```ts
{
  paths: {
    depth: number;               // comb cells on the path
    startpoint: NodeRef;         // input port bit / FF cell (Q) / blackbox
    endpoint: NodeRef;           // FF cell (D) / output port bit / blackbox
    endpoint_port: string;       // "D", output port name, ...
    nodes: NodeRef[];            // startpoint -> ... -> endpoint, in order
  }[];
  comb_loops: string[];          // names of nodes excluded due to comb cycles
}
```

## GET `/api/design/:id/cone?node=<id>&dir=fanin|fanout&max_depth=64&max_nodes=300&hide_control=true&hide_const=true`

Returns a `Subgraph` for rendering. Traversal stops at sequential cells, port
bits, and consts (they appear as boundary nodes); `hide_control` drops
clock/reset/enable edges into FFs; `hide_const` drops const drivers.
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

## GET `/api/design/:id/netlist?max_nodes=1500`

Full design as a `Subgraph` (same caps and shapes; `truncated` set if the
design exceeds `max_nodes`). Used by the optional full-schematic view.

## GET `/api/design/:id/source-map`

```ts
{
  files: string[];                       // filenames as submitted
  by_line: Record<string, number[]>;     // "file.sv:12" -> node ids
}
```

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
