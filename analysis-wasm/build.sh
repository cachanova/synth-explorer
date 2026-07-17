#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(cd -- "$script_dir/.." && pwd)
output_dir=${ANALYSIS_WASM_OUTPUT_DIR:-"$repo_dir/web/src/wasm/analysis"}

cargo build \
  --manifest-path "$script_dir/Cargo.toml" \
  --target wasm32-unknown-unknown \
  --release
mkdir -p "$output_dir"
wasm-bindgen \
  --target web \
  --out-dir "$output_dir" \
  --out-name analysis \
  "$repo_dir/target/wasm32-unknown-unknown/release/synth_explorer_analysis_wasm.wasm"
