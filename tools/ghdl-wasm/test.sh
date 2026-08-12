#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$script_dir/../.." && pwd)
wasm="$repo_root/web/public/ghdl/ghdl-synth.wasm"
libraries="$repo_root/web/public/ghdl/libraries.tar.gz"
fixtures="$script_dir/tests"
driver="$script_dir/ghdl_synth_test.mjs"
work_dir=$(mktemp -d "${TMPDIR:-/tmp}/synth-ghdl-fixtures.XXXXXX")
trap 'rm -rf -- "$work_dir"' EXIT

tar -xzf "$libraries" -C "$work_dir"

fail() {
  local message=$1
  printf 'GHDL fixture failure: %s\n' "$message" >&2
  if [[ -s "$work_dir/stdout" ]]; then
    printf '%s\n' '--- stdout ---' >&2
    sed -n '1,120p' "$work_dir/stdout" >&2
  fi
  if [[ -s "$work_dir/stderr" ]]; then
    printf '%s\n' '--- stderr ---' >&2
    sed -n '1,120p' "$work_dir/stderr" >&2
  fi
  exit 1
}

run_success() {
  local top=$1
  local fixture=$2
  : >"$work_dir/stdout"
  : >"$work_dir/stderr"
  node "$driver" "$wasm" "$work_dir" "$top" "$fixtures/$fixture" \
    >"$work_dir/stdout" 2>"$work_dir/stderr" \
    || fail "$fixture did not synthesize"
  [[ -s "$work_dir/stdout" ]] || fail "$fixture emitted no Verilog"
  grep -q "^module $top" "$work_dir/stdout" || fail "$fixture omitted module $top"
  grep -q '^endmodule' "$work_dir/stdout" || fail "$fixture omitted endmodule"
  grep -q "/\* $fixture:" "$work_dir/stdout" || fail "$fixture omitted source provenance"
  grep -q "^OK: synth $top" "$work_dir/stderr" || fail "$fixture omitted success summary"
  printf 'ok: %s\n' "$fixture"
}

run_failure() {
  local top=$1
  local fixture=$2
  local diagnostic=$3
  : >"$work_dir/stdout"
  : >"$work_dir/stderr"
  set +e
  node "$driver" "$wasm" "$work_dir" "$top" "$fixtures/$fixture" \
    >"$work_dir/stdout" 2>"$work_dir/stderr"
  local status=$?
  set -e
  [[ $status -eq 1 ]] || fail "$fixture exited $status instead of 1"
  [[ ! -s "$work_dir/stdout" ]] || fail "$fixture emitted unexpected stdout"
  grep -q '^FAIL: analyze' "$work_dir/stderr" || fail "$fixture omitted analysis failure"
  grep -q "$fixture.*error:" "$work_dir/stderr" || fail "$fixture omitted a named diagnostic"
  grep -q "$diagnostic" "$work_dir/stderr" || fail "$fixture diagnostic changed"
  printf 'ok: %s (expected failure)\n' "$fixture"
}

run_success and_gate and_gate.vhdl
run_success adder8 adder8.vhdl
run_success counter counter.vhdl
run_success fsm fsm.vhdl
run_failure broken syntax_error.vhdl 'expected after interface'
run_failure sembad sem_error.vhdl 'no declaration for "undefined_signal"'
