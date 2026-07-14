#!/usr/bin/env bash
set -Eeuo pipefail

readonly TEST_DIR="$(mktemp -d)"
readonly BASE_DIR_FIXTURE="${TEST_DIR}/base"
readonly RELEASES_DIR_FIXTURE="${BASE_DIR_FIXTURE}/releases"
readonly CURRENT_RELEASE_FIXTURE="${RELEASES_DIR_FIXTURE}/current-release"
readonly PREVIOUS_RELEASE_FIXTURE="${RELEASES_DIR_FIXTURE}/previous-release"
readonly OLD_RELEASE_FIXTURE="${RELEASES_DIR_FIXTURE}/old-release"
readonly CURRENT_REF='ghcr.io/cachanova/synth-explorer@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
readonly PREVIOUS_REF='ghcr.io/cachanova/synth-explorer@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
readonly OLD_REF='ghcr.io/cachanova/synth-explorer@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
readonly EXPECTED_COMMIT='dddddddddddddddddddddddddddddddddddddddd'
readonly CALL_LOG="${TEST_DIR}/calls.log"
readonly SMOKE_LOG="${TEST_DIR}/smoke.log"
WAIT_FAIL_RELEASE=
PUBLIC_HEALTH_MODE=exact

cleanup() {
  rm -rf -- "${TEST_DIR}"
}
trap cleanup EXIT

fail() {
  printf 'deploy-test: %s\n' "$*" >&2
  exit 1
}

assert_file_equals() {
  local path=$1 expected=$2 actual
  [[ -f "${path}" ]] || fail "missing ${path}"
  actual="$(cat -- "${path}")"
  [[ "${actual}" == "${expected}" ]] \
    || fail "${path} contained ${actual}, not ${expected}"
}

mkdir -p -- "${CURRENT_RELEASE_FIXTURE}/ops" "${PREVIOUS_RELEASE_FIXTURE}/ops" \
  "${OLD_RELEASE_FIXTURE}" "${BASE_DIR_FIXTURE}/state"
cp -- "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)/ops/deploy.sh" \
  "${CURRENT_RELEASE_FIXTURE}/ops/deploy.sh"
printf '%s\n' '#!/usr/bin/env bash' \
  'printf "%s %s %s\n" "$1" "$2" "${VIVADO_REQUIRED:-unset}" >>"${SMOKE_LOG:?}"' \
  >"${PREVIOUS_RELEASE_FIXTURE}/ops/smoke-test.sh"
chmod +x "${PREVIOUS_RELEASE_FIXTURE}/ops/smoke-test.sh"

export SYNTH_EXPLORER_BASE_DIR="${BASE_DIR_FIXTURE}"
export PUBLIC_BASE_URL=https://example.test
export SMOKE_LOG
# shellcheck source=/dev/null
source "${CURRENT_RELEASE_FIXTURE}/ops/deploy.sh"

# Invoking through current/ must resolve the physical release, never current
# itself (which would turn the symlink into a self-reference on success).
ln -sfn -- "${CURRENT_RELEASE_FIXTURE}" "${CURRENT_LINK}"
bash -c 'set -Eeuo pipefail; source "$1"; [[ "${RELEASE_DIR}" == "$2" ]]' \
  -- "${CURRENT_LINK}/ops/deploy.sh" "${CURRENT_RELEASE_FIXTURE}" \
  || fail 'deploy script did not resolve current/ to its physical release'
rm -f -- "${CURRENT_LINK}"

compose() {
  printf 'compose %s\n' "$*" >>"${CALL_LOG}"
}

compose_in_release() {
  printf 'compose_in_release %s\n' "$*" >>"${CALL_LOG}"
}

wait_for_app() {
  printf 'wait_for_app %s\n' "$*" >>"${CALL_LOG}"
  [[ "${1}" != "${WAIT_FAIL_RELEASE}" ]]
}

docker() {
  printf 'docker %s\n' "$*" >>"${CALL_LOG}"
  if [[ "${1:-} ${2:-}" == 'image inspect' ]]; then
    printf '%s\n' "${EXPECTED_COMMIT}"
  elif [[ "${1:-} ${2:-}" == 'image ls' ]]; then
    printf '%s\n%s\n%s\n' "${CURRENT_REF}" "${PREVIOUS_REF}" "${OLD_REF}"
  fi
}

curl() {
  if [[ "${PUBLIC_HEALTH_MODE}" == exact ]]; then
    printf '{"status":"ok","commit":"%s"}\n' "${EXPECTED_COMMIT}"
    return 0
  fi
  return 7
}

# A verified prior image and bundle are restored atomically.
: >"${CALL_LOG}"
printf 'IMAGE_REF=%s\n' "${CURRENT_REF}" >"${ENV_FILE}"
printf '%s\n' "${PREVIOUS_REF}" >"${PREVIOUS_FILE}"
printf '%s\n' "${PREVIOUS_RELEASE_FIXTURE}" >"${PREVIOUS_RELEASE_FILE}"
ln -sfn -- "${CURRENT_RELEASE_FIXTURE}" "${CURRENT_LINK}"
rollback_current
assert_file_equals "${ENV_FILE}" "IMAGE_REF=${PREVIOUS_REF}"
[[ "$(readlink -f -- "${CURRENT_LINK}")" == "${PREVIOUS_RELEASE_FIXTURE}" ]] \
  || fail 'current symlink did not move to the previous release'
[[ ! -e "${PREVIOUS_FILE}" && ! -e "${PREVIOUS_RELEASE_FILE}" ]] \
  || fail 'rollback metadata was not cleared'
assert_file_equals "${SMOKE_LOG}" "https://example.test ${EXPECTED_COMMIT} 0"

# A release containing the Vivado overlay must request the stronger smoke path.
: >"${SMOKE_LOG}"
touch -- "${PREVIOUS_RELEASE_FIXTURE}/compose.vivado.yml"
run_release_smoke "${PREVIOUS_RELEASE_FIXTURE}" \
  "${PREVIOUS_RELEASE_FIXTURE}/ops/smoke-test.sh" \
  "https://example.test" "${EXPECTED_COMMIT}"
assert_file_equals "${SMOKE_LOG}" "https://example.test ${EXPECTED_COMMIT} 1"
rm -f -- "${PREVIOUS_RELEASE_FIXTURE}/compose.vivado.yml"
grep -Fq "docker image rm -- ${CURRENT_REF}" "${CALL_LOG}" \
  || fail 'successful rollback did not remove the failed digest'

# Rollback without a verified prior release fails without disturbing current.
: >"${CALL_LOG}"
printf 'IMAGE_REF=%s\n' "${CURRENT_REF}" >"${ENV_FILE}"
ln -sfn -- "${CURRENT_RELEASE_FIXTURE}" "${CURRENT_LINK}"
if (rollback_current >/dev/null 2>&1); then
  fail 'rollback without a previous release unexpectedly succeeded'
fi
assert_file_equals "${ENV_FILE}" "IMAGE_REF=${CURRENT_REF}"
[[ "$(readlink -f -- "${CURRENT_LINK}")" == "${CURRENT_RELEASE_FIXTURE}" ]] \
  || fail 'failed rollback changed the current symlink'

# A prior release that fails verification cannot leave image/release state split.
: >"${CALL_LOG}"
printf '%s\n' '#!/usr/bin/env bash' 'exit 1' \
  >"${PREVIOUS_RELEASE_FIXTURE}/ops/smoke-test.sh"
chmod +x "${PREVIOUS_RELEASE_FIXTURE}/ops/smoke-test.sh"
printf '%s\n' "${PREVIOUS_REF}" >"${PREVIOUS_FILE}"
printf '%s\n' "${PREVIOUS_RELEASE_FIXTURE}" >"${PREVIOUS_RELEASE_FILE}"
if (rollback_current >/dev/null 2>&1); then
  fail 'rollback with a failing previous smoke test unexpectedly succeeded'
fi
assert_file_equals "${ENV_FILE}" "IMAGE_REF=${CURRENT_REF}"
assert_file_equals "${PREVIOUS_FILE}" "${PREVIOUS_REF}"
assert_file_equals "${PREVIOUS_RELEASE_FILE}" "${PREVIOUS_RELEASE_FIXTURE}"
[[ "$(readlink -f -- "${CURRENT_LINK}")" == "${CURRENT_RELEASE_FIXTURE}" ]] \
  || fail 'failed previous-release verification split image and release state'
if grep -Fq 'docker image rm --' "${CALL_LOG}"; then
  fail 'failed rollback removed a recovery image'
fi

# If neither rollback nor current restoration verifies, fail closed and retain images.
: >"${CALL_LOG}"
WAIT_FAIL_RELEASE="${CURRENT_RELEASE_FIXTURE}"
if (rollback_current >/dev/null 2>&1); then
  fail 'rollback with failed current restoration unexpectedly succeeded'
fi
WAIT_FAIL_RELEASE=
[[ ! -e "${ENV_FILE}" && ! -e "${CURRENT_LINK}" \
  && ! -e "${PREVIOUS_FILE}" && ! -e "${PREVIOUS_RELEASE_FILE}" ]] \
  || fail 'double rollback failure left active deployment state behind'
grep -Fq "compose_in_release ${CURRENT_RELEASE_FIXTURE} down" "${CALL_LOG}" \
  || fail 'double rollback failure did not stop the shared project'
if grep -Fq 'docker image rm --' "${CALL_LOG}"; then
  fail 'double rollback failure removed a recovery image'
fi

# A failed first deployment has no rollback target, so its stack and state stop.
: >"${CALL_LOG}"
rollback "${CURRENT_REF}" '' ''
[[ ! -e "${ENV_FILE}" && ! -e "${CURRENT_LINK}" ]] \
  || fail 'failed first deployment left current state behind'
grep -Fq 'compose down' "${CALL_LOG}" \
  || fail 'failed first deployment did not stop Compose'
grep -Fq "docker image rm -- ${CURRENT_REF}" "${CALL_LOG}" \
  || fail 'failed first deployment did not remove its image'

# Reachable exact health means a first-deploy synthesis failure is real and stops.
: >"${CALL_LOG}"
PUBLIC_HEALTH_MODE=exact
if (handle_first_deployment_smoke_failure "${CURRENT_REF}" "${EXPECTED_COMMIT}" >/dev/null 2>&1); then
  fail 'first-deploy synthesis failure unexpectedly succeeded'
fi
[[ ! -e "${ENV_FILE}" && ! -e "${CURRENT_LINK}" ]] \
  || fail 'first-deploy synthesis failure left active state behind'
grep -Fq 'compose down' "${CALL_LOG}" \
  || fail 'first-deploy synthesis failure did not stop Compose'

# Unreachable public health leaves the locally healthy first stack for DNS/TLS.
: >"${CALL_LOG}"
PUBLIC_HEALTH_MODE=unreachable
if (handle_first_deployment_smoke_failure "${CURRENT_REF}" "${EXPECTED_COMMIT}" >/dev/null 2>&1); then
  fail 'unverifiable first deployment unexpectedly succeeded'
fi
assert_file_equals "${ENV_FILE}" "IMAGE_REF=${CURRENT_REF}"
[[ "$(readlink -f -- "${CURRENT_LINK}")" == "${CURRENT_RELEASE_FIXTURE}" ]] \
  || fail 'unverifiable first deployment did not retain the healthy stack'
if grep -Fq 'compose down' "${CALL_LOG}" \
  || grep -Fq 'docker image rm --' "${CALL_LOG}"; then
  fail 'unverifiable first deployment was torn down before DNS/TLS convergence'
fi
clear_deployment_state
PUBLIC_HEALTH_MODE=exact

# Retention keeps exactly the active and previous release/image.
: >"${CALL_LOG}"
mkdir -p -- "${OLD_RELEASE_FIXTURE}"
prune_old_releases "${PREVIOUS_RELEASE_FIXTURE}"
[[ -d "${CURRENT_RELEASE_FIXTURE}" && -d "${PREVIOUS_RELEASE_FIXTURE}" ]] \
  || fail 'release retention removed an active rollback target'
[[ ! -e "${OLD_RELEASE_FIXTURE}" ]] \
  || fail 'release retention kept an obsolete release'
prune_old_app_images "${CURRENT_REF}" "${PREVIOUS_REF}"
grep -Fq "docker image rm -- ${OLD_REF}" "${CALL_LOG}" \
  || fail 'image retention did not remove the obsolete digest'
if grep -Fq "docker image rm -- ${CURRENT_REF}" "${CALL_LOG}" \
  || grep -Fq "docker image rm -- ${PREVIOUS_REF}" "${CALL_LOG}"; then
  fail 'image retention removed an active rollback target'
fi

printf 'deploy-test: rollback and retention cases passed\n'
