# Project-owned Yosys WebAssembly build

This directory builds the exact browser Yosys used by Synth Explorer. It does
not wrap or download a YoWASP package. The build pins Yosys 0.67, its integrated
ABC revision, and WASI SDK 33, then links only the product's synthesis flows.

Run from any directory:

```sh
tools/yosys-wasm/build.sh
```

The default output is `web/public/yosys/`:

- `yosys.wasm`: stripped WASI Preview 1 command module
- `share.tar.gz`: deterministic technology-data archive
- `SHA256SUMS`: integrity hashes for both assets

The build cache defaults to `.cache/yosys-wasm`. Override
`YOSYS_WASM_CACHE_DIR`, `YOSYS_WASM_OUTPUT_DIR`, or `YOSYS_WASM_JOBS` when
needed. LTO is intentionally disabled: WASI SDK 33 has a known symbol-type
failure when LTO and native WebAssembly exceptions are combined.
