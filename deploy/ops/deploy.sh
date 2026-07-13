#!/usr/bin/env bash
set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly RELEASE_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
readonly BASE_DIR="${SYNTH_EXPLORER_BASE_DIR:-${RELEASE_DIR}}"
readonly STATE_DIR="${SYNTH_EXPLORER_STATE_DIR:-${BASE_DIR}/state}"
readonly CURRENT_LINK="${SYNTH_EXPLORER_CURRENT_LINK:-${BASE_DIR}/current}"
readonly COMPOSE_FILE="${RELEASE_DIR}/compose.prod.yml"
readonly ENV_FILE="${STATE_DIR}/.env"
readonly PREVIOUS_FILE="${STATE_DIR}/.previous-image"
readonly PREVIOUS_RELEASE_FILE="${STATE_DIR}/.previous-release"
readonly LOCK_FILE="${STATE_DIR}/.deploy.lock"
readonly PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://synthexplorer.dev}"
readonly MIN_FREE_KIB=$((2 * 1024 * 1024))

die() {
  printf 'deploy: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

valid_image_ref() {
  [[ "$1" =~ ^[a-zA-Z0-9._/-]+(:[a-zA-Z0-9._-]+)?@sha256:[a-f0-9]{64}$ ]]
}

read_current_ref() {
  if [[ -f "${ENV_FILE}" ]]; then
    awk -F= '$1 == "IMAGE_REF" { sub(/^IMAGE_REF=/, ""); print; exit }' "${ENV_FILE}"
  fi
}

write_current_ref() {
  local image_ref=$1
  local temporary
  temporary="$(mktemp "${STATE_DIR}/.env.XXXXXX")"
  chmod 0600 "${temporary}"
  printf 'IMAGE_REF=%s\n' "${image_ref}" >"${temporary}"
  mv -- "${temporary}" "${ENV_FILE}"
}

current_release() {
  if [[ -L "${CURRENT_LINK}" ]]; then
    readlink -f -- "${CURRENT_LINK}"
  fi
}

point_current_at() {
  local release_dir=$1
  [[ -d "${release_dir}" ]] || die "release directory does not exist: ${release_dir}"
  if [[ -e "${CURRENT_LINK}" && ! -L "${CURRENT_LINK}" ]]; then
    die "${CURRENT_LINK} exists but is not a symlink"
  fi
  ln -sfn -- "${release_dir}" "${CURRENT_LINK}"
}

compose_in_release() {
  local release_dir=$1
  shift
  docker compose --project-directory "${release_dir}" \
    --file "${release_dir}/compose.prod.yml" "$@"
}

compose() {
  compose_in_release "${RELEASE_DIR}" "$@"
}

validate_caddy() {
  local image_ref=$1
  IMAGE_REF="${image_ref}" compose run --rm --no-deps --entrypoint caddy \
    caddy validate --config /etc/caddy/Caddyfile
}

wait_for_app() {
  local release_dir=$1
  local image_ref=$2
  local container_id status
  local deadline=$((SECONDS + 120))

  while (( SECONDS < deadline )); do
    container_id="$(IMAGE_REF="${image_ref}" compose_in_release "${release_dir}" ps --quiet app 2>/dev/null || true)"
    if [[ -n "${container_id}" ]]; then
      status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${container_id}" 2>/dev/null || true)"
      if [[ "${status}" == healthy ]]; then
        return 0
      fi
      if [[ "${status}" == exited || "${status}" == dead ]]; then
        docker logs --tail 100 "${container_id}" >&2 || true
        return 1
      fi
    fi
    sleep 2
  done

  if [[ -n "${container_id:-}" ]]; then
    docker inspect --format '{{json .State}}' "${container_id}" >&2 || true
    docker logs --tail 100 "${container_id}" >&2 || true
  fi
  return 1
}

remove_inactive_image() {
  local candidate_ref=$1 active_ref=${2:-}
  if valid_image_ref "${candidate_ref}" && [[ "${candidate_ref}" != "${active_ref}" ]]; then
    docker image rm -- "${candidate_ref}" >/dev/null 2>&1 || true
  fi
}

clear_deployment_state() {
  rm -f -- "${ENV_FILE}" "${CURRENT_LINK}" \
    "${PREVIOUS_FILE}" "${PREVIOUS_RELEASE_FILE}"
}

public_health_matches() {
  local expected_commit=$1 response
  response="$(curl --fail --silent --show-error \
    --connect-timeout 5 --max-time 15 \
    "${PUBLIC_BASE_URL%/}/healthz")" || return 1
  jq --exit-status --arg commit "${expected_commit}" \
    '.status == "ok" and .commit == $commit' <<<"${response}" >/dev/null
}

handle_first_deployment_smoke_failure() {
  local new_ref=$1 expected_commit=$2
  if public_health_matches "${expected_commit}"; then
    rollback "${new_ref}" '' '' || true
    die "synthesis smoke test failed after first deployment"
  fi
  write_current_ref "${new_ref}"
  point_current_at "${RELEASE_DIR}"
  die "public health could not verify the first healthy deployment; stack left running for DNS/TLS retry"
}

rollback() {
  local failed_ref=$1
  local previous_ref=$2
  local previous_release=$3
  local original_release previous_commit previous_smoke

  printf 'deploy: deployment failed; rolling back\n' >&2
  original_release="$(current_release)"
  if valid_image_ref "${previous_ref}" && [[ -n "${previous_release}" && -d "${previous_release}" ]]; then
    previous_commit="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "${previous_ref}" 2>/dev/null || true)"
    previous_smoke="${previous_release}/ops/smoke-test.sh"
    [[ -x "${previous_smoke}" ]] || previous_smoke="${SCRIPT_DIR}/smoke-test.sh"
    if [[ "${previous_commit}" =~ ^[a-f0-9]{40}$ ]] \
      && IMAGE_REF="${previous_ref}" compose_in_release "${previous_release}" up --detach --remove-orphans --force-recreate \
      && wait_for_app "${previous_release}" "${previous_ref}" \
      && "${previous_smoke}" "${PUBLIC_BASE_URL}" "${previous_commit}"; then
      write_current_ref "${previous_ref}"
      point_current_at "${previous_release}"
      rm -f -- "${PREVIOUS_FILE}" "${PREVIOUS_RELEASE_FILE}"
      remove_inactive_image "${failed_ref}" "${previous_ref}"
      printf 'deploy: restored %s from %s\n' "${previous_ref}" "${previous_release}" >&2
      return 0
    fi
    if valid_image_ref "${failed_ref}" \
      && [[ -n "${original_release}" && -d "${original_release}" && "${original_release}" != "${previous_release}" ]] \
      && IMAGE_REF="${failed_ref}" compose_in_release "${original_release}" up --detach --remove-orphans --force-recreate \
      && wait_for_app "${original_release}" "${failed_ref}"; then
      write_current_ref "${failed_ref}"
      point_current_at "${original_release}"
      printf 'deploy: previous release verification failed; restored current release state\n' >&2
      printf 'deploy: rollback to %s from %s failed\n' "${previous_ref}" "${previous_release}" >&2
      return 1
    fi
    if [[ -n "${original_release}" && -d "${original_release}" ]]; then
      IMAGE_REF="${failed_ref}" compose_in_release "${original_release}" down >/dev/null 2>&1 || true
    else
      IMAGE_REF="${previous_ref}" compose_in_release "${previous_release}" down >/dev/null 2>&1 || true
    fi
    clear_deployment_state
    printf 'deploy: rollback and current-release restoration both failed; stopped the shared project\n' >&2
    printf 'deploy: rollback to %s from %s failed\n' "${previous_ref}" "${previous_release}" >&2
    return 1
  fi

  IMAGE_REF="${failed_ref}" compose down >/dev/null 2>&1 || true
  clear_deployment_state
  remove_inactive_image "${failed_ref}" ''
  printf 'deploy: no previous image was available; stopped failed first deployment\n' >&2
  return 0
}

rollback_current() {
  local current_ref previous_ref previous_release
  current_ref="$(read_current_ref)"
  [[ -n "${current_ref}" ]] || die "no current image is recorded"
  valid_image_ref "${current_ref}" || die "current IMAGE_REF is not an immutable digest"
  previous_ref="$(cat -- "${PREVIOUS_FILE}" 2>/dev/null || true)"
  previous_release="$(cat -- "${PREVIOUS_RELEASE_FILE}" 2>/dev/null || true)"
  valid_image_ref "${previous_ref}" \
    || die "no previous image is available for rollback"
  [[ -n "${previous_release}" && -d "${previous_release}" ]] \
    || die "no previous release directory is available for rollback"

  rollback "${current_ref}" "${previous_ref}" "${previous_release}" \
    || die "rollback failed"
}

check_disk_space() {
  local available_kib
  available_kib="$(df --output=avail "${BASE_DIR}" | awk 'NR == 2 { print $1 }')"
  [[ "${available_kib}" =~ ^[0-9]+$ ]] || die "could not determine free disk space"
  (( available_kib >= MIN_FREE_KIB )) \
    || die "less than 2 GiB is free under ${BASE_DIR}"
}

prune_old_releases() {
  local previous_release=$1 candidate
  for candidate in "${BASE_DIR}/releases"/*; do
    [[ -e "${candidate}" ]] || continue
    if [[ "${candidate}" != "${RELEASE_DIR}" && "${candidate}" != "${previous_release}" ]]; then
      rm -rf -- "${candidate}"
    fi
  done
}

prune_old_app_images() {
  local current_ref=$1 previous_ref=$2 repository candidate
  repository="${current_ref%@*}"
  while IFS= read -r candidate; do
    [[ "${candidate}" == "${repository}@sha256:"* ]] || continue
    if [[ "${candidate}" != "${current_ref}" && "${candidate}" != "${previous_ref}" ]]; then
      docker image rm -- "${candidate}" >/dev/null 2>&1 || true
    fi
  done < <(docker image ls --digests --no-trunc --format '{{.Repository}}@{{.Digest}}')
}

main() {
  [[ $# -eq 1 ]] || die "usage: $0 <image-ref@sha256:digest> | --rollback"
  local requested=$1

  require_command docker
  require_command curl
  require_command df
  require_command flock
  require_command jq
  require_command readlink
  require_command ln
  install -d -m 0750 -- "${STATE_DIR}"
  [[ -f "${COMPOSE_FILE}" ]] || die "missing ${COMPOSE_FILE}"
  [[ -f "${RELEASE_DIR}/Caddyfile" ]] || die "missing ${RELEASE_DIR}/Caddyfile"
  [[ -x "${SCRIPT_DIR}/smoke-test.sh" ]] || die "missing executable ${SCRIPT_DIR}/smoke-test.sh"
  docker compose version >/dev/null

  exec 9>"${LOCK_FILE}"
  flock --nonblock 9 || die "another deployment is in progress"

  if [[ "${requested}" == "--rollback" ]]; then
    rollback_current
    return
  fi

  local new_ref=${requested}
  valid_image_ref "${new_ref}" || die "image reference must include a sha256 digest"

  local previous_ref previous_release expected_commit
  previous_ref="$(read_current_ref)"
  previous_release="$(current_release)"
  if [[ -n "${previous_ref}" ]] && ! valid_image_ref "${previous_ref}"; then
    die "existing IMAGE_REF is not an immutable digest"
  fi
  if [[ -n "${previous_ref}" && -z "${previous_release}" ]]; then
    die "existing IMAGE_REF has no current release symlink"
  fi

  IMAGE_REF="${new_ref}" compose config --quiet
  check_disk_space
  docker pull "${new_ref}"
  validate_caddy "${new_ref}"
  expected_commit="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "${new_ref}")"
  [[ "${expected_commit}" =~ ^[a-f0-9]{40}$ ]] \
    || die "image revision label must be a full 40-character Git commit"

  if [[ -n "${previous_ref}" ]]; then
    printf '%s\n' "${previous_ref}" >"${PREVIOUS_FILE}"
  else
    rm -f -- "${PREVIOUS_FILE}"
  fi
  if [[ -n "${previous_release}" ]]; then
    printf '%s\n' "${previous_release}" >"${PREVIOUS_RELEASE_FILE}"
  else
    rm -f -- "${PREVIOUS_RELEASE_FILE}"
  fi
  if ! IMAGE_REF="${new_ref}" compose up --detach --remove-orphans --force-recreate; then
    rollback "${new_ref}" "${previous_ref}" "${previous_release}" || true
    die "docker compose failed"
  fi
  if ! wait_for_app "${RELEASE_DIR}" "${new_ref}"; then
    rollback "${new_ref}" "${previous_ref}" "${previous_release}" || true
    die "application did not become healthy"
  fi
  if ! "${SCRIPT_DIR}/smoke-test.sh" "${PUBLIC_BASE_URL}" "${expected_commit}"; then
    if valid_image_ref "${previous_ref}" && [[ -n "${previous_release}" ]]; then
      rollback "${new_ref}" "${previous_ref}" "${previous_release}" || true
      die "external smoke test failed"
    fi
    handle_first_deployment_smoke_failure "${new_ref}" "${expected_commit}"
  fi

  write_current_ref "${new_ref}"
  point_current_at "${RELEASE_DIR}"
  prune_old_releases "${previous_release}"
  prune_old_app_images "${new_ref}" "${previous_ref}"
  printf 'deploy: deployed %s (%s) from %s\n' "${new_ref}" "${expected_commit}" "${RELEASE_DIR}"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
