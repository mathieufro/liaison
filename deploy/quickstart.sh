#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
#
# One-command local quickstart for self-hosted Liaison. Run from a clone:
#
#   ./deploy/quickstart.sh
#
# It will:
#   - check for docker, docker compose v2, and openssl;
#   - create deploy/.env from deploy/.env.example on first run only, filling
#     in every required secret and the local URLs the app needs to boot;
#   - on a Docker host without gVisor, run the app sandbox on runc (a local
#     trial; a server follows docs/self-hosting/sandbox.md);
#   - pull the published image of the chosen channel (ghcr.io/liaison-sh/liaison:latest
#     or :nightly) if it is reachable, otherwise build it locally from
#     apps/api/Dockerfile;
#   - bring the stack up and wait for /healthz to report every dependency ok;
#   - print the URL and exactly how to log in for the first time.
#
# Flags:
#   --port <n>       Publish the app on this host port instead of 3000.
#   --channel <name> release (the default) or nightly: picks the image and sets
#                    LIAISON_RELEASE_CHANNEL. A later run keeps the channel in
#                    deploy/.env. Migrations only go forward, so nightly cannot go
#                    back to an older release: see docs/admin/upgrades.md.
#   --pull           Force pulling the published image (error out if it can't be pulled).
#   --build          Force a local build from apps/api/Dockerfile, even if the
#                    published image is reachable.
#   --project <name> Docker Compose project name (default: liaison).
#   --down           Stop the stack; data is kept in Docker volumes. (Combine
#                    with --project/--port if you started with non-default values.)
#   -h, --help       Show this help.
#
# To remove all data (irreversible), after --down:
#   docker compose -p <project> -f deploy/docker-compose.yml down -v

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd)"
DEPLOY_DIR="${SCRIPT_DIR}"
COMPOSE_FILE="${DEPLOY_DIR}/docker-compose.yml"
ENV_FILE="${DEPLOY_DIR}/.env"
ENV_EXAMPLE="${DEPLOY_DIR}/.env.example"
IMAGE_REPO="ghcr.io/liaison-sh/liaison"
LOCAL_IMAGE_TAG="liaison:local"

PROJECT_NAME="liaison"
APP_PORT="3000"
MODE="auto" # auto | pull | build
ACTION="up"
CHANNEL="" # release | nightly; empty: what deploy/.env says, else release

log()  { printf '%s\n' "$*"; }
err()  { printf 'error: %s\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

print_help() {
  # Print the header comment block above (lines 2-33) as help text.
  sed -n '2,33p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --port)
      [ $# -ge 2 ] || die "--port requires a value"
      APP_PORT="$2"
      shift 2
      ;;
    --channel)
      [ $# -ge 2 ] || die "--channel requires a value (release or nightly)"
      case "$2" in
        release | nightly) CHANNEL="$2" ;;
        *) die "unknown channel: $2 (release or nightly)" ;;
      esac
      shift 2
      ;;
    --pull)
      MODE="pull"
      shift
      ;;
    --build)
      MODE="build"
      shift
      ;;
    --project)
      [ $# -ge 2 ] || die "--project requires a value"
      PROJECT_NAME="$2"
      shift 2
      ;;
    --down)
      ACTION="down"
      shift
      ;;
    -h|--help)
      print_help
      exit 0
      ;;
    *)
      die "unknown option: $1 (see --help)"
      ;;
  esac
done

COMPOSE=(docker compose -p "${PROJECT_NAME}" -f "${COMPOSE_FILE}")

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------

# A source checkout's dev substrate (the repository root's docker-compose.yml)
# also runs as project `liaison`, with the same service names. Starting this
# stack under that name would recreate its containers, so stop and say how to
# pick another name.
refuse_foreign_project() {
  local files file
  files="$(docker ps -a --filter "label=com.docker.compose.project=${PROJECT_NAME}" \
    --format '{{.Label "com.docker.compose.project.config_files"}}' 2>/dev/null | tr ',' '\n' | sort -u)"
  while IFS= read -r file; do
    [ -z "${file}" ] && continue
    case "${file}" in
      */deploy/*) ;;
      */docker-compose.yml | */docker-compose.yaml) die "the docker compose project '${PROJECT_NAME}' already runs another stack (${file}). Run again with --project <another name>, for example --project liaison-selfhost." ;;
      *) ;;
    esac
  done <<<"${files}"
}

check_prereqs() {
  if ! command -v docker >/dev/null 2>&1; then
    die "docker is not installed or not on PATH. Install Docker: https://docs.docker.com/get-docker/"
  fi
  if ! docker info >/dev/null 2>&1; then
    die "docker is installed but the daemon is not reachable (is Docker running?)."
  fi
  if ! docker compose version >/dev/null 2>&1; then
    die "docker compose v2 is required (the 'docker compose' subcommand). Standalone docker-compose v1 is not supported. See https://docs.docker.com/compose/install/"
  fi
  if ! command -v openssl >/dev/null 2>&1; then
    die "openssl is not installed or not on PATH (needed to generate secrets)."
  fi
  if ! command -v curl >/dev/null 2>&1; then
    die "curl is not installed or not on PATH (needed for the health check)."
  fi
}

# ---------------------------------------------------------------------------
# --down
# ---------------------------------------------------------------------------

do_down() {
  command -v docker >/dev/null 2>&1 || die "docker is not installed or not on PATH."
  log "Stopping the '${PROJECT_NAME}' stack (data is kept in Docker volumes)..."
  "${COMPOSE[@]}" down
  log ""
  log "Stack stopped. Data (Postgres, search index, object storage) is still on disk."
  log "To remove it permanently, run:"
  log "  docker compose -p ${PROJECT_NAME} -f ${COMPOSE_FILE} down -v"
  exit 0
}

# ---------------------------------------------------------------------------
# .env creation
# ---------------------------------------------------------------------------

gen_hex() { openssl rand -hex "$1"; }

create_env() {
  if [ -f "${ENV_FILE}" ]; then
    log "deploy/.env already exists — leaving it untouched."
    return
  fi
  [ -f "${ENV_EXAMPLE}" ] || die "deploy/.env.example not found (expected next to docker-compose.yml)"

  log "Creating deploy/.env from deploy/.env.example (generating secrets)..."
  cp "${ENV_EXAMPLE}" "${ENV_FILE}"

  # Fill every secret the compose file requires with ':?' (see
  # deploy/docker-compose.yml). All 32-byte hex, except the object-store admin
  # access key id (12 bytes, matching the recipe in
  # docs/runbooks/production-bootstrap.md).
  set_var JWT_SECRET "$(gen_hex 32)"
  set_var ENCRYPTION_KEY "$(gen_hex 32)"
  set_var BYOK_ENCRYPTION_KEY "$(gen_hex 32)"
  set_var MEILISEARCH_MASTER_KEY "$(gen_hex 32)"
  set_var MONITOR_TOKEN "$(gen_hex 32)"
  set_var POSTGRES_PASSWORD "$(gen_hex 32)"
  set_var LIAISON_APP_PASSWORD "$(gen_hex 32)"
  set_var LIAISON_READONLY_PASSWORD "$(gen_hex 32)"
  set_var OBJECT_STORE_ADMIN_ACCESS_KEY "$(gen_hex 12)"
  set_var OBJECT_STORE_ADMIN_SECRET_KEY "$(gen_hex 32)"
  set_var OBJECT_STORAGE_ACCESS_KEY "$(gen_hex 12)"
  set_var OBJECT_STORAGE_SECRET_KEY "$(gen_hex 32)"

  # Local URLs. Production refuses to boot with the exact literal
  # "http://localhost:3000" (apps/api/src/lib/env.ts), so use 127.0.0.1 —
  # that satisfies the check and still works from the host browser.
  set_var BASE_URL "http://127.0.0.1:${APP_PORT}"
  set_var ALLOWED_ORIGINS "http://127.0.0.1:${APP_PORT}"
  set_var APP_PORT "${APP_PORT}"
  # No SMTP in a local trial: log email bodies so the passwordless sign-in code
  # is readable in `docker compose logs app`. Remove it (or set SMTP_*) before
  # anyone else signs in to this instance.
  set_var LIAISON_CONSOLE_EMAIL_BODIES "true"

  log "deploy/.env created. Edit it later to add SMTP, AI provider keys, etc."
}

# Portable in-place `KEY=` -> `KEY=value` replacement (BSD and GNU sed both
# supported via a temp file instead of `sed -i ''`/`sed -i` flag differences).
set_var() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  if grep -q "^${key}=" "${ENV_FILE}"; then
    awk -v k="${key}" -v v="${value}" 'BEGIN{FS=OFS="="} $1==k{$0=k"="v} {print}' "${ENV_FILE}" > "${tmp}"
  else
    cp "${ENV_FILE}" "${tmp}"
    printf '%s=%s\n' "${key}" "${value}" >> "${tmp}"
  fi
  mv "${tmp}" "${ENV_FILE}"
}

# The app sandbox service runs under gVisor (`runtime: runsc`), which a laptop's
# Docker (Docker Desktop, OrbStack, a plain Linux install) usually lacks. For a
# local trial on such a host, run it on runc and accept the open network of a
# stack with no firewall step, and say so. A server install follows
# docs/self-hosting/sandbox.md instead. Never overrides a runtime deploy/.env
# already names.
sandbox_runtime() {
  if grep -q '^LIAISON_SANDBOX_RUNTIME=' "${ENV_FILE}"; then
    return
  fi
  if docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q '"runsc"'; then
    return
  fi
  log "No gVisor runtime (runsc) on this Docker host: the app sandbox runs on runc for this local trial."
  log "  On a server, install gVisor and the firewall step instead: docs/self-hosting/sandbox.md"
  set_var LIAISON_SANDBOX_RUNTIME "runc"
  set_var LIAISON_SANDBOX_ALLOW_NO_GVISOR "1"
  set_var LIAISON_SANDBOX_ALLOW_OPEN_NETWORK "1"
}

# ---------------------------------------------------------------------------
# Image selection
# ---------------------------------------------------------------------------

# The channel: the flag, else what deploy/.env already says, so a plain rerun
# never moves a nightly instance to an older release. Then the image it means.
resolve_channel() {
  if [ -z "${CHANNEL}" ] && [ -f "${ENV_FILE}" ]; then
    CHANNEL="$(sed -n 's/^LIAISON_RELEASE_CHANNEL=//p' "${ENV_FILE}" | tail -n 1)"
  fi
  CHANNEL="${CHANNEL:-release}"
  case "${CHANNEL}" in
    release) IMAGE_REF="${IMAGE_REPO}:latest" ;;
    nightly) IMAGE_REF="${IMAGE_REPO}:nightly" ;;
    *) die "deploy/.env has an unknown LIAISON_RELEASE_CHANNEL: ${CHANNEL} (release or nightly)" ;;
  esac
}

select_image() {
  local image=""
  case "${MODE}" in
    pull)
      log "Pulling ${IMAGE_REF} (forced by --pull)..."
      docker pull "${IMAGE_REF}" || die "could not pull ${IMAGE_REF}"
      image="${IMAGE_REF}"
      ;;
    build)
      build_local
      image="${LOCAL_IMAGE_TAG}"
      ;;
    auto)
      log "Checking whether ${IMAGE_REF} is published yet..."
      if docker pull "${IMAGE_REF}" >/dev/null 2>&1; then
        log "Pulled ${IMAGE_REF}."
        image="${IMAGE_REF}"
      else
        log "${IMAGE_REF} is not reachable yet (nothing published on the ${CHANNEL} channel). Building locally instead."
        build_local
        image="${LOCAL_IMAGE_TAG}"
      fi
      ;;
  esac
  LIAISON_IMAGE="${image}"
}

build_local() {
  log "Building ${LOCAL_IMAGE_TAG} from apps/api/Dockerfile (this can take a few minutes on first run)..."
  ( cd "${REPO_ROOT}" && docker build -t "${LOCAL_IMAGE_TAG}" -f apps/api/Dockerfile . ) \
    || die "local image build failed"
}

# ---------------------------------------------------------------------------
# Bring the stack up
# ---------------------------------------------------------------------------

wait_healthy() {
  local url="http://127.0.0.1:${APP_PORT}/healthz"
  local attempts=90 # 90 * 2s = 3 minutes
  local i=0
  log "Waiting for ${url} to report every dependency ok..."
  while [ "${i}" -lt "${attempts}" ]; do
    local body
    if body="$(curl -fsS "${url}" 2>/dev/null)"; then
      # /healthz always returns HTTP 200, even with a dead dependency, so gate
      # on the body: top-level status plus every value under "dependencies"
      # (db, redis, meilisearch, objectStorage — apps/api/src/modules/healthz)
      # must read "ok". Avoid a jq dependency: strip the "dependencies" object
      # out and check it has no non-"ok" value.
      if printf '%s' "${body}" | grep -q '"status":"ok"'; then
        local deps
        deps="$(printf '%s' "${body}" | sed -n 's/.*"dependencies":{\([^}]*\)}.*/\1/p')"
        if [ -n "${deps}" ] && ! printf '%s' "${deps}" | grep -Eq ':"(error|degraded|unknown)"'; then
          log "Healthy."
          return 0
        fi
      fi
    fi
    i=$((i + 1))
    sleep 2
  done
  err "timed out after $((attempts * 2))s waiting for ${url} to become healthy."
  # A refused start (for example an image older than the database schema)
  # prints one FATAL line and restarts; surface it instead of making the
  # reader dig through the logs.
  local fatal
  fatal="$(docker compose -p "${PROJECT_NAME}" -f "${COMPOSE_FILE}" logs --no-log-prefix --tail 50 app 2>/dev/null | grep -m1 '^FATAL:' || true)"
  if [ -n "${fatal}" ]; then
    err "The app refused to start: ${fatal}"
  fi
  err "Inspect the logs with:"
  err "  docker compose -p ${PROJECT_NAME} -f ${COMPOSE_FILE} logs"
  exit 1
}

# The one-time setup token the app prints in its log while it has no org yet.
# Empty when the instance is already set up (nothing is printed then).
find_setup_token() {
  local i tok=""
  for i in 1 2 3 4 5; do
    tok="$("${COMPOSE[@]}" logs app 2>/dev/null | grep -o 'Liaison setup token: [^ "]*' | tail -n 1 | sed 's/^Liaison setup token: //' || true)"
    [ -n "${tok}" ] && break
    sleep 1
  done
  printf '%s' "${tok}"
}

print_login_instructions() {
  local base="http://127.0.0.1:${APP_PORT}"
  local setup_token
  setup_token="$(find_setup_token)"
  log ""
  log "Liaison is up: ${base}"
  if [ -n "${SSH_CONNECTION:-}" ]; then
    # The app listens on this machine's loopback only, on purpose: it speaks
    # plain HTTP. Over SSH, that address is the server's, not the reader's.
    log ""
    log "You are on a remote machine, so that address only works from here. To try it"
    log "without a domain, open a tunnel from your own computer and use the same URL there:"
    # SSH_CONNECTION is "client-ip client-port server-ip server-port".
    log "  ssh -N -L ${APP_PORT}:127.0.0.1:${APP_PORT} $(id -un)@$(printf '%s' "${SSH_CONNECTION}" | cut -d' ' -f3)"
    log "(Use the name or public address you normally reach this server by, if it differs.)"
    log "For a domain and https, see docs/runbooks/production-bootstrap.md."
  fi
  log ""
  if [ -z "${setup_token}" ]; then
    # No setup token in the log: this instance already has its org.
    log "Sign in at ${base}/ with your email. Without SMTP the code is in the app log:"
    log "  docker compose -p ${PROJECT_NAME} -f ${COMPOSE_FILE} logs --since 10m app | grep 'sign-in code' | tail -1"
    log ""
    log "To stop the stack (keeping data): $0 --project ${PROJECT_NAME} --port ${APP_PORT} --down"
    return
  fi
  log "Setting it up with Claude Code or Codex? Run, from this clone:"
  log "  claude \"set up Liaison for my company\"   (or: codex \"set up Liaison for my company\")"
  log "It provisions the org, the admin and your company's knowledge without the"
  log "account step below (.claude/skills/setup-liaison/SKILL.md)."
  log ""
  log "First login:"
  log "  1. Open ${base}/ in a browser and choose Create an account."
  log "  2. Enter your name and email (no password needed). The very first"
  log "     registration bootstraps a new org, makes you its admin, and signs"
  log "     you straight in — no email round-trip for this one-time step."
  log "     A new install asks for its one-time SETUP TOKEN first, so a stranger"
  log "     cannot claim it before you. Yours is:"
  log "       ${setup_token}"
  log "     (also in the app log: docker compose -p ${PROJECT_NAME} -f ${COMPOSE_FILE} logs app | grep 'Liaison setup token')"
  log "  3. Every login after that is passwordless: a 6-digit code / magic"
  log "     link is emailed to you. SMTP is not configured in this local"
  log "     .env, so it is logged to the app container's stdout instead."
  log "     Watch for it with:"
  log "       docker compose -p ${PROJECT_NAME} -f ${COMPOSE_FILE} logs -f app | grep -i 'sign-in\\|magic'"
  log "  4. Open Chats at the bottom right, then Personal agent: its \"Set up your"
  log "     space\" card asks for your AI provider key and walks you through the"
  log "     rest. (The key can also go under Settings > Usage.)"
  log ""
  log "To configure real email delivery, AI provider keys, or other options, edit"
  log "deploy/.env and run: docker compose -p ${PROJECT_NAME} -f ${COMPOSE_FILE} up -d"
  log ""
  log "To stop the stack (keeping data): $0 --project ${PROJECT_NAME} --port ${APP_PORT} --down"
}

do_up() {
  check_prereqs
  create_env
  # The app mounts deploy/setup read only at /setup (provisioning config and
  # knowledge files). Create it as the current user before compose would
  # create it as root.
  mkdir -p "${DEPLOY_DIR}/setup"
  sandbox_runtime
  resolve_channel
  select_image
  set_var LIAISON_RELEASE_CHANNEL "${CHANNEL}"
  # Remember the image in .env: a later plain `docker compose up -d`, and
  # deploy/backup.sh / deploy/restore.sh, then run this same image instead of
  # the compose file's default tag.
  set_var LIAISON_IMAGE "${LIAISON_IMAGE}"

  refuse_foreign_project
  log "Starting the stack (docker compose project '${PROJECT_NAME}')..."
  LIAISON_IMAGE="${LIAISON_IMAGE}" "${COMPOSE[@]}" --env-file "${ENV_FILE}" up -d

  wait_healthy
  # The read-only role's grants need the schemas the app creates on its first
  # start, so the cluster-init hook defers them; apply them now (idempotent).
  "${COMPOSE[@]}" exec -T postgres sh /docker-entrypoint-initdb.d/20-readonly-role.sh >/dev/null ||
    err "could not apply the read-only role's grants (the database connector's liaison-self reads need them); rerun: ${COMPOSE[*]} exec -T postgres sh /docker-entrypoint-initdb.d/20-readonly-role.sh"
  print_login_instructions
}

if [ "${ACTION}" = "down" ]; then
  do_down
else
  do_up
fi
