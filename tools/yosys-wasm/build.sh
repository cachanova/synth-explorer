#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(cd -- "$script_dir/../.." && pwd)

readonly yosys_commit=2d1509d1bcb8df0723f6790057e3b1d21c876683
readonly abc_commit=e026ed5380f3bdc3beea2ff9ffc23236fc549d5b
readonly wasi_sdk_version=33.0
readonly wasi_sdk_archive=wasi-sdk-33.0-x86_64-linux.tar.gz
readonly wasi_sdk_sha256=0ba8b5bfaeb2adf3f29bab5841d76cf5318ab8e1642ea195f88baba1abd47bce
readonly wasi_sdk_url="https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-33/$wasi_sdk_archive"

cache_dir=${YOSYS_WASM_CACHE_DIR:-"$repo_dir/.cache/yosys-wasm"}
output_dir=${YOSYS_WASM_OUTPUT_DIR:-"$repo_dir/web/public/yosys"}
jobs=${YOSYS_WASM_JOBS:-$(getconf _NPROCESSORS_ONLN)}
sdk_dir="$cache_dir/wasi-sdk-$wasi_sdk_version-x86_64-linux"
source_dir="$cache_dir/yosys"
build_dir="$cache_dir/build"
archive_path="$cache_dir/$wasi_sdk_archive"

mkdir -p "$cache_dir" "$output_dir"

if [[ ! -f "$archive_path" ]]; then
  curl --fail --location --retry 3 --output "$archive_path" "$wasi_sdk_url"
fi
printf '%s  %s\n' "$wasi_sdk_sha256" "$archive_path" | sha256sum --check --status

if [[ ! -x "$sdk_dir/bin/clang" ]]; then
  tar --extract --gzip --file "$archive_path" --directory "$cache_dir"
fi

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

# Only the frontend, passes, backends, and technology flows used by the product
# are linked. CMake resolves their transitive pass dependencies. LTO remains
# disabled because WASI SDK 33 cannot currently combine it with wasm exceptions.
components=(
  driver
  read_aigerparse
  read_verilog
  write_json
  write_xaiger
  hierarchy
  proc
  prep
  synth
  synth_ice40
  synth_lattice
  synth_xilinx
  flatten
  design
  select
  techmap
  opt
  abc
)
components_arg=$(IFS=';'; printf '%s' "${components[*]}")
eh_lib_dir="$sdk_dir/share/wasi-sysroot/lib/wasm32-wasip1/eh"

cmake -S "$source_dir" -B "$build_dir" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_TOOLCHAIN_FILE="$script_dir/wasi-sdk.cmake" \
  -DWASI_SDK_PREFIX="$sdk_dir" \
  -DCMAKE_EXE_LINKER_FLAGS="-L$eh_lib_dir" \
  -DBUILD_TESTING=OFF \
  -DYOSYS_WITHOUT_SLANG=ON \
  -DYOSYS_COMPONENTS="$components_arg"
cmake --build "$build_dir" --target yosys --parallel "$jobs"

"$sdk_dir/bin/llvm-strip" --strip-all -o "$output_dir/yosys.wasm" "$build_dir/yosys"
tar --create --gzip --file "$output_dir/share.tar.gz" \
  --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner \
  --directory "$build_dir/share" .

(
  cd "$output_dir"
  sha256sum yosys.wasm share.tar.gz > SHA256SUMS
)

printf 'Yosys %s / ABC %s / WASI SDK %s\n' \
  "$yosys_commit" "$abc_commit" "$wasi_sdk_version"
du -h "$output_dir/yosys.wasm" "$output_dir/share.tar.gz"
