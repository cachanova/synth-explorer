#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(cd -- "$script_dir/../.." && pwd)
cache_dir=${GHDL_WASM_CACHE_DIR:-"$repo_dir/.cache/ghdl-wasm"}
output_dir=${GHDL_WASM_OUTPUT_DIR:-"$repo_dir/web/public/ghdl"}
image=${GHDL_WASM_BUILD_IMAGE:-synth-explorer-ghdl-wasm:24.04}

mkdir -p "$cache_dir" "$output_dir"

docker build --tag "$image" "$script_dir"
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --env HOME=/cache/home \
  --env GHDL_WASM_JOBS="${GHDL_WASM_JOBS:-$(getconf _NPROCESSORS_ONLN)}" \
  --volume "$repo_dir:/repo" \
  --volume "$cache_dir:/cache" \
  --volume "$output_dir:/output" \
  --workdir /repo \
  "$image" \
  /repo/tools/ghdl-wasm/build-in-container.sh
