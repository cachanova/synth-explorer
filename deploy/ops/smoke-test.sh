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
  local vivado_design_id unauthorized_status vivado_required=${VIVADO_REQUIRED:-0}
  local vivado_access_token=${VIVADO_SMOKE_ACCESS_TOKEN:-}
  [[ "${vivado_required}" == 0 || "${vivado_required}" == 1 ]] \
    || die "VIVADO_REQUIRED must be 0 or 1"
  if [[ "${vivado_required}" == 1 ]]; then
    [[ "${vivado_access_token}" =~ ^[a-fA-F0-9]{64}$ ]] \
      || die "VIVADO_SMOKE_ACCESS_TOKEN must be a 256-bit hexadecimal key"
  fi
  temporary_dir="$(mktemp -d)"
  health_file="${temporary_dir}/health.json"
  synth_file="${temporary_dir}/synthesize.json"
  flags_synth_file="${temporary_dir}/synthesize-flags.json"
  design_file="${temporary_dir}/design.json"
  payload_file="${temporary_dir}/payload.json"
  flags_payload_file="${temporary_dir}/payload-flags.json"
  matrix_payload_file="${temporary_dir}/payload-matrix.json"
  matrix_file="${temporary_dir}/synthesize-matrix.json"
  # examples/ sits next to this script's parent on the host release dir
  # (ops/ + examples/ siblings) but one level higher in the repo, where the
  # script lives under deploy/ops/ and examples/ stays at the root.
  local script_dir candidate
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  source_file=""
  for candidate in "${script_dir}/.." "${script_dir}/../.."; do
    if [[ -f "${candidate}/examples/handshake_controller.sv" ]]; then
      source_file="$(cd -- "${candidate}" && pwd)/examples/handshake_controller.sv"
      break
    fi
  done
  [[ -n "${source_file}" ]] || die "missing synthesis smoke fixture: examples/handshake_controller.sv"

  curl --fail-with-body --show-error --silent --location \
    --retry 20 --retry-all-errors --retry-delay 3 \
    --connect-timeout 5 --max-time 15 \
    --output "${health_file}" "${base_url}/healthz"
  if [[ "${vivado_required}" == 1 ]]; then
    jq --exit-status --arg commit "${expected_commit}" \
      '.status == "ok" and .commit == $commit
        and ((.yosys_version | type) == "string")
        and (.yosys_version | contains("0.67"))
        and ((.vivado_version | type) == "string")
        and (.vivado_version | ascii_downcase | contains("vivado v2026.1"))
        and .vivado_access_protected == true' \
      "${health_file}" >/dev/null \
      || die "health response did not match the deployed commit, Yosys 0.67, and Vivado 2026.1"
  else
    jq --exit-status --arg commit "${expected_commit}" \
      '.status == "ok" and .commit == $commit
        and ((.yosys_version | type) == "string")
        and (.yosys_version | contains("0.67"))' \
      "${health_file}" >/dev/null \
      || die "health response did not match the deployed commit and Yosys 0.67"
  fi

  jq --null-input --rawfile source "${source_file}" \
    '{files: [{name: "handshake_controller.sv", content: $source}], top: "handshake_controller", tool: "yosys", mode: "gates"}' \
    >"${payload_file}"
  jq '. + {extra_args: "-noabc"}' "${payload_file}" >"${flags_payload_file}"

  curl --fail-with-body --show-error --silent \
    --connect-timeout 5 --max-time 75 \
    --header 'content-type: application/json' \
    --data-binary "@${payload_file}" \
    --output "${synth_file}" "${base_url}/api/synthesize"
  design_id="$(jq --exit-status --raw-output \
    'select(.top == "handshake_controller" and .tool == "yosys" and .mode == "gates") | .design_id | select(type == "string" and length == 12)' \
    "${synth_file}")" \
    || die "synthesis response did not contain the expected design"

  curl --fail-with-body --show-error --silent \
    --connect-timeout 5 --max-time 75 \
    --header 'content-type: application/json' \
    --data-binary "@${flags_payload_file}" \
    --output "${flags_synth_file}" "${base_url}/api/synthesize"
  flags_design_id="$(jq --exit-status --raw-output \
    'select(.top == "handshake_controller" and .tool == "yosys" and .mode == "gates") | .design_id | select(type == "string" and length == 12)' \
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
    '.design_id == $design_id and .top == "handshake_controller" and .tool == "yosys" and .mode == "gates"' \
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
      'select(.top == "handshake_controller" and .tool == "yosys" and .mode == $mode) | .design_id | select(type == "string" and length == 12)' \
      "${matrix_file}")" \
      || die "${mode} synthesis did not contain the expected design"
    jq --exit-status '.stats.num_cells | select(type == "number")' \
      "${matrix_file}" >/dev/null \
      || die "${mode} synthesis did not return a cell count"
    printf 'smoke-test: %s mode passed with design %s\n' "${mode}" "${matrix_design_id}"
  done

  if [[ "${vivado_required}" == 1 ]]; then
    jq '. + {tool: "vivado", mode: "gates", target: "xc7a35tcpg236-1"} | del(.extra_args)' \
      "${payload_file}" >"${matrix_payload_file}"
    unauthorized_status="$(curl --show-error --silent \
      --connect-timeout 5 --max-time 15 \
      --header 'content-type: application/json' \
      --data-binary "@${matrix_payload_file}" \
      --output "${matrix_file}" --write-out '%{http_code}' \
      "${base_url}/api/synthesize")"
    [[ "${unauthorized_status}" == 401 ]] \
      || die "public Vivado synthesis was not rejected with 401"

    printf 'header = "Authorization: Bearer %s"\n' "${vivado_access_token}" | \
      curl --config - --fail-with-body --show-error --silent \
      --connect-timeout 5 --max-time 360 \
      --header 'content-type: application/json' \
      --data-binary "@${matrix_payload_file}" \
      --output "${matrix_file}" "${base_url}/api/synthesize"
    vivado_design_id="$(jq --exit-status --raw-output \
      'select(.top == "handshake_controller" and .tool == "vivado" and .mode == "gates" and .target == "xc7a35tcpg236-1") | .design_id | select(type == "string" and length == 12)' \
      "${matrix_file}")" \
      || die "vivado synthesis did not contain the expected design"
    jq --exit-status '.stats.num_cells | select(type == "number" and . > 0)' \
      "${matrix_file}" >/dev/null \
      || die "vivado synthesis did not return a positive cell count"
    printf 'smoke-test: vivado tool passed with design %s\n' "${vivado_design_id}"
  fi

  printf 'smoke-test: %s is healthy at commit %s; all modes passed (designs %s, %s with -noabc)\n' \
    "${base_url}" "${expected_commit}" "${design_id}" "${flags_design_id}"
}

main "$@"
