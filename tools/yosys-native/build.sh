#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(cd -- "$script_dir/../.." && pwd)

readonly yosys_commit=2d1509d1bcb8df0723f6790057e3b1d21c876683
readonly abc_commit=e026ed5380f3bdc3beea2ff9ffc23236fc549d5b

cache_dir=${YOSYS_NATIVE_CACHE_DIR:-"$repo_dir/.cache/yosys-native"}
jobs=${YOSYS_NATIVE_JOBS:-$(getconf _NPROCESSORS_ONLN)}
source_dir="$cache_dir/yosys"
build_dir="$cache_dir/build"

# Match the production WASM build's command surface, plus EDIF export for the
# Vivado calibration bridge. CMake resolves each component's pass dependencies.
components=(
  driver
  read_verilog
  write_json
  write_edif
  hierarchy
  proc
  synth
  synth_xilinx
  flatten
  design
  select
  techmap
  opt
  abc
)
components_arg=$(IFS=';'; printf '%s' "${components[*]}")

mkdir -p "$cache_dir"
if [[ ! -d "$source_dir/.git" ]]; then
  git clone --filter=blob:none https://github.com/YosysHQ/yosys.git "$source_dir"
fi
git -C "$source_dir" fetch --quiet origin "$yosys_commit"
git -C "$source_dir" checkout --quiet --detach "$yosys_commit"
git -C "$source_dir" submodule update --init --recursive

actual_abc_commit=$(git -C "$source_dir/abc" rev-parse HEAD)
if [[ "$actual_abc_commit" != "$abc_commit" ]]; then
  printf 'unexpected ABC revision: expected %s, got %s\n' "$abc_commit" "$actual_abc_commit" >&2
  exit 1
fi

cmake -S "$source_dir" -B "$build_dir" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_TESTING=OFF \
  -DYOSYS_WITHOUT_SLANG=ON \
  -DYOSYS_COMPONENTS="$components_arg"
cmake --build "$build_dir" --target yosys --parallel "$jobs"

version=$($build_dir/yosys -V)
if [[ "$version" != *"Yosys 0.67"* || "$version" != *"2d1509d1b"* ]]; then
  printf 'unexpected native Yosys build: %s\n' "$version" >&2
  exit 1
fi
printf '%s\n' "$version"
printf 'Use for calibration with:\n  export SYNTH_EXPLORER_YOSYS=%s\n' "$build_dir/yosys"
