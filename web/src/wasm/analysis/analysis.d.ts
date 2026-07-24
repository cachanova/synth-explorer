/* tslint:disable */
/* eslint-disable */

export class AnalysisSession {
    free(): void;
    [Symbol.dispose](): void;
    cone_json(query_json: string): string;
    endpoints_json(): string;
    expand_group_json(query_json: string): string;
    fanout_json(limit?: number | null): string;
    netlist_json(query_json: string): string;
    constructor(design_id: string, netlist_json: string, source_netlist_json: string, files_json: string, mode: string, tool: string, profile: string);
    nodes_json(ids_json: string): string;
    paths_json(query_json: string): string;
    source_for_nodes_json(ids_json: string): string;
    source_map_json(): string;
    source_ranges_for_bits_json(bits_json: string): string;
    source_selection_json(query_json: string): string;
    summary_json(): string;
    timing_json(query_json: string): string;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_analysissession_free: (a: number, b: number) => void;
    readonly analysissession_cone_json: (a: number, b: number, c: number) => [number, number, number, number];
    readonly analysissession_endpoints_json: (a: number) => [number, number, number, number];
    readonly analysissession_expand_group_json: (a: number, b: number, c: number) => [number, number, number, number];
    readonly analysissession_fanout_json: (a: number, b: number) => [number, number, number, number];
    readonly analysissession_netlist_json: (a: number, b: number, c: number) => [number, number, number, number];
    readonly analysissession_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number) => [number, number, number];
    readonly analysissession_nodes_json: (a: number, b: number, c: number) => [number, number, number, number];
    readonly analysissession_paths_json: (a: number, b: number, c: number) => [number, number, number, number];
    readonly analysissession_source_for_nodes_json: (a: number, b: number, c: number) => [number, number, number, number];
    readonly analysissession_source_map_json: (a: number) => [number, number, number, number];
    readonly analysissession_source_ranges_for_bits_json: (a: number, b: number, c: number) => [number, number, number, number];
    readonly analysissession_source_selection_json: (a: number, b: number, c: number) => [number, number, number, number];
    readonly analysissession_summary_json: (a: number) => [number, number, number, number];
    readonly analysissession_timing_json: (a: number, b: number, c: number) => [number, number, number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
