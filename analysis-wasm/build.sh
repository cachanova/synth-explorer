#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(cd -- "$script_dir/.." && pwd)
output_dir=${ANALYSIS_WASM_OUTPUT_DIR:-"$repo_dir/web/src/wasm/analysis"}
readonly expected_wasm_bindgen=0.2.122
actual_wasm_bindgen=$(wasm-bindgen --version | awk '{print $2}')
if [[ "$actual_wasm_bindgen" != "$expected_wasm_bindgen" ]]; then
  printf 'wasm-bindgen %s is required, found %s; run: cargo install wasm-bindgen-cli --version %s --locked --force\n' \
    "$expected_wasm_bindgen" "$actual_wasm_bindgen" "$expected_wasm_bindgen" >&2
  exit 1
fi
remap_flags="--remap-path-prefix=$repo_dir=/workspace"
if [[ -n ${HOME:-} ]]; then
  remap_flags+=" --remap-path-prefix=$HOME=/build-home"
fi

RUSTFLAGS="${RUSTFLAGS:-} $remap_flags" cargo build \
  --manifest-path "$script_dir/Cargo.toml" \
  --target wasm32-unknown-unknown \
  --release
mkdir -p "$output_dir"
wasm-bindgen \
  --target web \
  --out-dir "$output_dir" \
  --out-name analysis \
  "$repo_dir/target/wasm32-unknown-unknown/release/synth_explorer_analysis_wasm.wasm"
