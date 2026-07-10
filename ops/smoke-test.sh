#!/usr/bin/env bash
set -Eeuo pipefail

temporary_dir=

cleanup() {
  if [[ -n "${temporary_dir}" ]]; then
    rm -rf -- "${temporary_dir}"
  fi
}

trap cleanup EXIT

die() {
  printf 'smoke-test: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

main() {
  [[ $# -eq 2 ]] || die "usage: $0 <base-url> <expected-commit>"
  local base_url=${1%/}
  local expected_commit=$2
  [[ "${base_url}" =~ ^https?://[^/]+(:[0-9]+)?$ ]] || die "base URL must contain only scheme and authority"
  [[ "${expected_commit}" =~ ^[a-f0-9]{40}$ ]] || die "expected commit must be a full 40-character Git commit"

  require_command curl
  require_command jq

  local health_file synth_file flags_synth_file design_file matrix_file
  local payload_file flags_payload_file matrix_payload_file source_file design_id flags_design_id
  local default_cells flags_cells mode matrix_design_id
  temporary_dir="$(mktemp -d)"
  health_file="${temporary_dir}/health.json"
  synth_file="${temporary_dir}/synthesize.json"
  flags_synth_file="${temporary_dir}/synthesize-flags.json"
  design_file="${temporary_dir}/design.json"
  payload_file="${temporary_dir}/payload.json"
  flags_payload_file="${temporary_dir}/payload-flags.json"
  matrix_payload_file="${temporary_dir}/payload-matrix.json"
  matrix_file="${temporary_dir}/synthesize-matrix.json"
  source_file="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)/examples/05_shared_logic.sv"
  [[ -f "${source_file}" ]] || die "missing synthesis smoke fixture: ${source_file}"

  curl --fail-with-body --show-error --silent --location \
    --retry 20 --retry-all-errors --retry-delay 3 \
    --connect-timeout 5 --max-time 15 \
    --output "${health_file}" "${base_url}/healthz"
  jq --exit-status --arg commit "${expected_commit}" \
    '.status == "ok" and .commit == $commit and (.yosys_version | type == "string" and contains("0.67"))' \
    "${health_file}" >/dev/null \
    || die "health response did not match the deployed commit and Yosys 0.67"

  jq --null-input --rawfile source "${source_file}" \
    '{files: [{name: "05_shared_logic.sv", content: $source}], top: "shared_logic", mode: "gates"}' \
    >"${payload_file}"
  jq '. + {extra_args: "-noabc"}' "${payload_file}" >"${flags_payload_file}"

  curl --fail-with-body --show-error --silent \
    --connect-timeout 5 --max-time 75 \
    --header 'content-type: application/json' \
    --data-binary "@${payload_file}" \
    --output "${synth_file}" "${base_url}/api/synthesize"
  design_id="$(jq --exit-status --raw-output \
    'select(.top == "shared_logic" and .mode == "gates") | .design_id | select(type == "string" and length == 12)' \
    "${synth_file}")" \
    || die "synthesis response did not contain the expected design"

  curl --fail-with-body --show-error --silent \
    --connect-timeout 5 --max-time 75 \
    --header 'content-type: application/json' \
    --data-binary "@${flags_payload_file}" \
    --output "${flags_synth_file}" "${base_url}/api/synthesize"
  flags_design_id="$(jq --exit-status --raw-output \
    'select(.top == "shared_logic" and .mode == "gates") | .design_id | select(type == "string" and length == 12)' \
    "${flags_synth_file}")" \
    || die "synthesis-flags response did not contain the expected design"
  [[ "${flags_design_id}" != "${design_id}" ]] \
    || die "synthesis flags did not affect the content-addressed design id"
  default_cells="$(jq --exit-status --raw-output '.stats.num_cells | select(type == "number")' "${synth_file}")" \
    || die "default synthesis did not return a cell count"
  flags_cells="$(jq --exit-status --raw-output '.stats.num_cells | select(type == "number")' "${flags_synth_file}")" \
    || die "flagged synthesis did not return a cell count"
  [[ "${flags_cells}" != "${default_cells}" ]] \
    || die "-noabc did not change the synthesized cell count"

  curl --fail-with-body --show-error --silent \
    --connect-timeout 5 --max-time 15 \
    --output "${design_file}" "${base_url}/api/design/${design_id}"
  jq --exit-status --arg design_id "${design_id}" \
    '.design_id == $design_id and .top == "shared_logic" and .mode == "gates"' \
    "${design_file}" >/dev/null \
    || die "design fetch did not return the synthesized design"

  for mode in rtl lut4 lut6 ice40 ecp5 xilinx; do
    jq --arg mode "${mode}" '.mode = $mode | del(.extra_args)' \
      "${payload_file}" >"${matrix_payload_file}"
    curl --fail-with-body --show-error --silent \
      --connect-timeout 5 --max-time 75 \
      --header 'content-type: application/json' \
      --data-binary "@${matrix_payload_file}" \
      --output "${matrix_file}" "${base_url}/api/synthesize"
    matrix_design_id="$(jq --exit-status --raw-output --arg mode "${mode}" \
      'select(.top == "shared_logic" and .mode == $mode) | .design_id | select(type == "string" and length == 12)' \
      "${matrix_file}")" \
      || die "${mode} synthesis did not contain the expected design"
    jq --exit-status '.stats.num_cells | select(type == "number")' \
      "${matrix_file}" >/dev/null \
      || die "${mode} synthesis did not return a cell count"
    printf 'smoke-test: %s mode passed with design %s\n' "${mode}" "${matrix_design_id}"
  done

  printf 'smoke-test: %s is healthy at commit %s; all modes passed (designs %s, %s with -noabc)\n' \
    "${base_url}" "${expected_commit}" "${design_id}" "${flags_design_id}"
}

main "$@"
