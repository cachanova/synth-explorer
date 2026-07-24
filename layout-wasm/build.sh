#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(cd -- "$script_dir/.." && pwd)
output_dir=${LAYOUT_WASM_OUTPUT_DIR:-"$repo_dir/web/src/wasm/layout"}
expected_wasm_bindgen="wasm-bindgen 0.2.122"
actual_wasm_bindgen=$(wasm-bindgen --version)
if [[ "$actual_wasm_bindgen" != "$expected_wasm_bindgen" ]]; then
  echo "expected $expected_wasm_bindgen, found $actual_wasm_bindgen" >&2
  exit 1
fi

expected_schemweave_rev="405c87c93c25085135423e25ee9525b650fc1b80"
expected_schemweave_source="source = \"git+https://github.com/cachanova/schemweave.git?rev=$expected_schemweave_rev#$expected_schemweave_rev\""
if ! grep -Fqx "$expected_schemweave_source" "$repo_dir/Cargo.lock"; then
  echo "Cargo.lock does not pin SchemWeave at $expected_schemweave_rev" >&2
  exit 1
fi

remap_flags="--remap-path-prefix=$repo_dir=/workspace"
if [[ -n ${HOME:-} ]]; then
  remap_flags+=" --remap-path-prefix=$HOME=/build-home"
fi

RUSTFLAGS="${RUSTFLAGS:-} $remap_flags" cargo build \
  --manifest-path "$script_dir/Cargo.toml" \
  --target wasm32-unknown-unknown \
  --profile wasm-release \
  --locked
mkdir -p "$output_dir"
wasm-bindgen \
  --target web \
  --out-dir "$output_dir" \
  --out-name schemweave \
  "$repo_dir/target/wasm32-unknown-unknown/wasm-release/synth_explorer_layout_wasm.wasm"
