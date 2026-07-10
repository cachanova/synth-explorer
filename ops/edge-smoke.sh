#!/usr/bin/env bash
set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly APEX_HOST=synthexplorer.dev
readonly WWW_HOST=www.synthexplorer.dev

die() {
  printf 'edge-smoke: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

assert_redirect() {
  local source_url=$1 expected_location=$2 headers status location
  headers="$(mktemp)"
  status="$(curl --ipv4 --silent --show-error --output /dev/null \
    --dump-header "${headers}" --connect-timeout 5 --max-time 15 \
    --write-out '%{http_code}' "${source_url}")"
  location="$(awk 'tolower($1) == "location:" { sub(/\r$/, "", $2); print $2; exit }' "${headers}")"
  rm -f -- "${headers}"
  [[ "${status}" == 301 || "${status}" == 308 ]] \
    || die "${source_url} returned ${status}, not a permanent redirect"
  [[ "${location}" == "${expected_location}" ]] \
    || die "${source_url} redirected to ${location}, not ${expected_location}"
}

main() {
  [[ $# -eq 1 ]] || die "usage: $0 <expected-commit>"
  local expected_commit=$1
  [[ "${expected_commit}" =~ ^[a-f0-9]{40}$ ]] \
    || die "expected commit must be a full 40-character Git commit"

  require_command curl
  require_command getent
  getent ahostsv4 "${APEX_HOST}" >/dev/null \
    || die "the apex A record did not resolve"
  getent ahostsv6 "${APEX_HOST}" >/dev/null \
    || die "the apex AAAA record did not resolve"

  curl --ipv4 --fail --silent --show-error --connect-timeout 5 --max-time 15 \
    "https://${APEX_HOST}/healthz" >/dev/null
  if command -v ip >/dev/null 2>&1 && ip -6 route show default | grep -q .; then
    curl --ipv6 --fail --silent --show-error --connect-timeout 5 --max-time 15 \
      "https://${APEX_HOST}/healthz" >/dev/null
  else
    printf 'edge-smoke: runner has no IPv6 default route; AAAA resolution verified without an IPv6 request\n'
  fi

  assert_redirect "http://${APEX_HOST}/healthz" "https://${APEX_HOST}/healthz"
  assert_redirect "https://${WWW_HOST}/healthz" "https://${APEX_HOST}/healthz"
  "${SCRIPT_DIR}/smoke-test.sh" "https://${APEX_HOST}" "${expected_commit}"
  printf 'edge-smoke: DNS, TLS, HTTP, and www routing passed\n'
}

main "$@"
