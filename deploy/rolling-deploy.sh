#!/bin/sh
# SPDX-License-Identifier: FSL-1.1-ALv2
#
# deploy/rolling-deploy.sh: move the `rolling` profile of deploy/docker-compose.yml
# to a new image without stopping anything. A deploy only delays work:
#
#   1. Refuse while the previous deploy's old processes are still draining (or
#      another deploy is running), so deploys stay serial. A deploy that was
#      killed (SIGKILL, reboot) before its switch is finished first: its new
#      containers are rolled back while its old ones still run.
#   2. Run the migrations once, in the `migrate` one-shot of the NEW image (the
#      migration lease in the database keeps it to one runner even so). A failed
#      migration stops the deploy here, before any process changes.
#   3. Start the new `api` and `worker` processes BESIDE the old ones
#      (`up --no-recreate --no-deps --scale`), never recreating an old one or
#      touching the infrastructure services.
#   4. Wait until every new container's healthcheck (`/readyz`) is healthy. One
#      that never gets there rolls the deploy back: the new containers are
#      stopped and removed, the old ones keep serving, exit 1.
#   4b. Recreate the sandbox service on the new image (it refuses runs of
#      another release), or start it when the compose file defines it and none
#      runs yet.
#   5. Give the edge two probe intervals to see the new upstreams, then stop the
#      old containers by id with the full drain budget (`docker stop -t`), and
#      remove them once they exit. Their /readyz answers 503 at once, so the edge
#      stops sending them traffic, and their listener stays open 5 s more
#      (SHUTDOWN_EDGE_GRACE_MS) so the edge has moved before it closes
#      (deploy/Caddyfile.rolling.example).
#
# Ctrl-C, SIGTERM or a dropped SSH session (SIGHUP) stop the deploy cleanly:
# before the switch its new containers are rolled back, after it the old ones
# keep draining (the next run picks the drain up), and the lock is released.
# Run it under nohup, tmux or systemd-run all the same: a rollback can take a
# while (each new container gets the full drain budget).
#
# A first run beside a running `app` (the single-container setup) treats `app`
# as old: it is stopped only after the new processes are ready. Point the edge
# at the port range first (the example lists the `app` port as well). After
# that switch, deploy only with this script: a plain `docker compose up -d`
# starts `app` again on port 3000 (a second release, migrating on start).
# Remove port 3000 from the edge once `app` is gone.
#
# Usage:
#   LIAISON_IMAGE=<image> deploy/rolling-deploy.sh [--wait-drain] [--infra]
#
#   --wait-drain  stay in the foreground until the old containers are gone (by
#                 default the drain runs detached and logs to the state dir).
#   --infra       first bring up the infrastructure services (Postgres, Redis,
#                 search, object storage and their one-shot setup). That may
#                 recreate them: it is a maintenance deploy, NOT zero-downtime.
#
# Environment:
#   LIAISON_IMAGE          required: the image the new processes run.
#   LIAISON_VERSION        optional: logged with the deploy (the image carries it).
#   API_REPLICAS           new api processes (default: deploy/.env's, else 2).
#   WORKER_REPLICAS        new worker processes (default: deploy/.env's, else 1).
#   API_PORT_RANGE         host port range of the api service (default: deploy/.env's, else 3001-3004).
#                          Old + new api processes must fit in it.
#   READY_TIMEOUT_S        how long new containers get to become ready (300).
#   DRAIN_TIMEOUT_S        docker stop timeout for an old container (660: the
#                          rolling services' hard deadline of 638 s + margin).
#   EDGE_SETTLE_S          wait between "new ready" and "stop old" (2).
#   COMPOSE_FILE           compose file(s), `:`-separated (default: the
#                          docker-compose.yml beside this script).
#   COMPOSE_PROJECT_NAME   compose project (default liaison).
#   COMPOSE_PROFILES       profiles added to `rolling` (default: deploy/.env's);
#                          `meaning` also starts the `embedder` service.
#   LIAISON_ROLLING_STATE_DIR  lock (owner pid, host, boot id), the pending
#                          record of a deploy in progress, the draining list,
#                          the drain's pid and log (default deploy/.rolling
#                          beside this script).
#   INFRA_SERVICES         the services --infra brings up.
#   DOCKER                 the docker binary (tests point it at a shim).
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
SELF="$SCRIPT_DIR/$(basename -- "$0")"
DOCKER="${DOCKER:-docker}"
export COMPOSE_FILE="${COMPOSE_FILE:-$SCRIPT_DIR/docker-compose.yml}"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-liaison}"
# The value of $1 in the compose project's .env (the directory of the first
# compose file), as compose itself reads it; empty when unset.
env_file_value() {
  env_file="$(dirname -- "${COMPOSE_FILE%%:*}")/.env"
  [ -f "$env_file" ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$env_file" | tail -n 1 |
    sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\\(.*\\)'\$/\\1/"
}
# The replica counts: from the environment, else deploy/.env, else 2 and 1.
# Exported, so every compose call below interpolates the same numbers into the
# processes' LIAISON_API_REPLICAS / LIAISON_WORKER_REPLICAS, which their pool
# plan budgets (docs/self-hosting/pools.md).
API_REPLICAS="${API_REPLICAS:-$(env_file_value API_REPLICAS)}"
WORKER_REPLICAS="${WORKER_REPLICAS:-$(env_file_value WORKER_REPLICAS)}"
API_REPLICAS="${API_REPLICAS:-2}"
WORKER_REPLICAS="${WORKER_REPLICAS:-1}"
export API_REPLICAS WORKER_REPLICAS
# The port range compose publishes the api on: environment, else deploy/.env.
API_PORT_RANGE="${API_PORT_RANGE:-$(env_file_value API_PORT_RANGE)}"
API_PORT_RANGE="${API_PORT_RANGE:-3001-3004}"
READY_TIMEOUT_S="${READY_TIMEOUT_S:-300}"
DRAIN_TIMEOUT_S="${DRAIN_TIMEOUT_S:-660}"
EDGE_SETTLE_S="${EDGE_SETTLE_S:-2}"
STATE_DIR="${LIAISON_ROLLING_STATE_DIR:-$SCRIPT_DIR/.rolling}"
INFRA_SERVICES="${INFRA_SERVICES:-postgres redis meilisearch objectstore objectstore-init data-init}"
LOCK_DIR="$STATE_DIR/lock"
OWNER_FILE="$LOCK_DIR/owner"
PENDING_FILE="$STATE_DIR/pending"
DRAINING_FILE="$STATE_DIR/draining"
DRAIN_PID_FILE="$STATE_DIR/drain.pid"
DRAIN_LOG="$STATE_DIR/drain.log"

log() { printf '%s rolling-deploy: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() {
  log "ERROR: $*"
  exit 1
}

# The compose profiles: `rolling`, plus every profile COMPOSE_PROFILES names
# (environment, else deploy/.env), since a --profile flag makes compose ignore
# COMPOSE_PROFILES. With `meaning` among them the deploy also starts the
# `embedder` service when it is not running (never recreating it).
COMPOSE_PROFILES="${COMPOSE_PROFILES:-$(env_file_value COMPOSE_PROFILES)}"
PROFILE_FLAGS="--profile rolling"
MEANING=""
for p in $(printf '%s' "$COMPOSE_PROFILES" | tr ',' ' '); do
  case " $PROFILE_FLAGS " in *" --profile $p "*) continue ;; esac
  PROFILE_FLAGS="$PROFILE_FLAGS --profile $p"
  if [ "$p" = meaning ]; then MEANING=1; fi
done
# shellcheck disable=SC2086 # word splitting is the flag list
compose() { "$DOCKER" compose $PROFILE_FLAGS "$@"; }

# Words of $1 as one space-separated line, and their count (ids never glob).
# shellcheck disable=SC2086
words() { echo $1; }
# shellcheck disable=SC2086
count() { set -- $1; echo $#; }
contains() {
  case " $(words "$1") " in *" $2 "*) return 0 ;; *) return 1 ;; esac
}
status_of() { "$DOCKER" inspect -f '{{.State.Status}}' "$1" 2>/dev/null || echo gone; }
pid_alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }
boot_id() { cat /proc/sys/kernel/random/boot_id 2>/dev/null || :; }
HOST_NAME=$(hostname 2>/dev/null || uname -n)

# Stop the given containers with the full drain budget, remove them, and clear
# the draining list. Never fails the caller: a container already gone is fine.
drain() {
  [ $# -gt 0 ] || return 0
  echo "$$" >"$DRAIN_PID_FILE"
  log "draining old containers: $*"
  "$DOCKER" stop -t "$DRAIN_TIMEOUT_S" "$@" >/dev/null || log "stop reported an error (continuing)"
  "$DOCKER" rm "$@" >/dev/null || log "rm reported an error (continuing)"
  rm -f "$DRAINING_FILE" "$DRAIN_PID_FILE"
  log "old containers removed: $*"
}

start_detached_drain() {
  # shellcheck disable=SC2086 # the ids are words
  nohup "$SELF" __drain $1 >>"$DRAIN_LOG" 2>&1 </dev/null &
}

# Internal entry for the detached drain (re-invoked by this script).
if [ "${1:-}" = "__drain" ]; then
  shift
  trap '' HUP
  drain "$@"
  exit 0
fi

WAIT_DRAIN=""
INFRA=""
for arg in "$@"; do
  case "$arg" in
    --wait-drain) WAIT_DRAIN=1 ;;
    --infra) INFRA=1 ;;
    -h | --help)
      sed -n '3,70p' "$SELF"
      exit 0
      ;;
    *) die "unknown argument: $arg" ;;
  esac
done

: "${LIAISON_IMAGE:?LIAISON_IMAGE is required (the image the new processes run)}"
export LIAISON_IMAGE

is_count() { case "$1" in '' | *[!0-9]*) return 1 ;; *) return 0 ;; esac }
is_count "$API_REPLICAS" && [ "$API_REPLICAS" -ge 1 ] || die "API_REPLICAS must be a positive integer"
is_count "$WORKER_REPLICAS" || die "WORKER_REPLICAS must be an integer"
is_count "$READY_TIMEOUT_S" || die "READY_TIMEOUT_S must be an integer"
is_count "$DRAIN_TIMEOUT_S" && [ "$DRAIN_TIMEOUT_S" -ge 1 ] || die "DRAIN_TIMEOUT_S must be a positive integer"
is_count "$EDGE_SETTLE_S" || die "EDGE_SETTLE_S must be an integer"

port_lo="${API_PORT_RANGE%-*}"
port_hi="${API_PORT_RANGE#*-}"
is_count "$port_lo" && is_count "$port_hi" && [ "$port_hi" -ge "$port_lo" ] ||
  die "API_PORT_RANGE must look like 3001-3004"
port_slots=$((port_hi - port_lo + 1))

mkdir -p "$STATE_DIR"

# --- 1. one deploy at a time, and none while old processes drain ------------
# The lock records its owner (pid, host, boot id). A lock whose owner is gone
# (killed, or the host rebooted) is stale and taken over; an owner-less lock
# older than a minute too (a run killed between mkdir and the owner write).
LOCK_HELD=""
take_lock() {
  mkdir "$LOCK_DIR" 2>/dev/null || return 1
  LOCK_HELD=1
  echo "$$ $HOST_NAME $(boot_id)" >"$OWNER_FILE"
}
if ! take_lock; then
  owner=$(cat "$OWNER_FILE" 2>/dev/null || :)
  if [ -z "$owner" ]; then
    [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +1 2>/dev/null)" ] ||
      die "another deploy is starting ($LOCK_DIR has no owner yet)"
    log "taking over a stale lock with no owner recorded ($LOCK_DIR)"
  else
    # shellcheck disable=SC2086 # pid host boot-id
    set -- $owner
    o_pid="${1:-}" o_host="${2:-}" o_boot="${3:-}"
    [ "$o_host" = "$HOST_NAME" ] ||
      die "another deploy holds $LOCK_DIR (pid $o_pid on host $o_host): run deploys from one host"
    if pid_alive "$o_pid" && { [ -z "$o_boot" ] || [ "$o_boot" = "$(boot_id)" ]; }; then
      die "another deploy is running (pid $o_pid) and holds $LOCK_DIR"
    fi
    log "taking over a stale lock: its owner (pid $o_pid) is gone"
  fi
  rm -f "$OWNER_FILE"
  rmdir "$LOCK_DIR" 2>/dev/null || :
  take_lock || die "another deploy took the lock at the same time"
fi

release_lock() {
  [ -n "$LOCK_HELD" ] || return 0
  rm -f "$OWNER_FILE"
  rmdir "$LOCK_DIR" 2>/dev/null || :
  LOCK_HELD=""
}

# Before the switch (PHASE=started) a stop rolls back what this run started;
# after it the old containers keep draining.
PHASE=idle
new_ids=""
old_ids=""

all_rolling_ids() { compose ps -a -q api; compose ps -a -q worker; }

# Stop and remove every api/worker container that is not in $1 (the old
# generation), whatever its state, and check that none is left.
roll_back_new() {
  keep="$1"
  extra=""
  for id in $(all_rolling_ids); do contains "$keep" "$id" || extra="$extra $id"; done
  extra=$(words "$extra")
  if [ -n "$extra" ]; then
    log "stopping and removing the new containers: $extra"
    # shellcheck disable=SC2086
    "$DOCKER" stop -t "$DRAIN_TIMEOUT_S" $extra >/dev/null 2>&1 || :
    # shellcheck disable=SC2086
    "$DOCKER" rm -f $extra >/dev/null 2>&1 || :
  fi
  left=""
  for id in $(all_rolling_ids); do contains "$keep" "$id" || left="$left $id"; done
  [ -z "$left" ] || log "WARNING: new containers still present after the rollback:$left (remove them by hand)"
  rm -f "$PENDING_FILE"
}

rollback() {
  log "ROLLBACK: $1"
  roll_back_new "$old_ids"
  log "the old processes keep serving"
  exit 1
}

on_signal() {
  trap '' INT TERM HUP
  log "interrupted by SIG$1"
  case "$PHASE" in
    started) roll_back_new "$old_ids" && log "rolled back: the old processes keep serving" ;;
    switched) log "the old containers were being drained; the next deploy finishes their drain" ;;
  esac
  release_lock
  exit "$2"
}
trap release_lock EXIT
trap 'on_signal INT 130' INT
trap 'on_signal TERM 143' TERM
trap 'on_signal HUP 129' HUP

# A deploy killed outright (SIGKILL, a reboot) before its switch left its
# pending record: roll its new containers back while its old ones still run,
# or, when none of them does any more, keep the new ones as the current set.
if [ -s "$PENDING_FILE" ]; then
  if [ -s "$DRAINING_FILE" ]; then
    rm -f "$PENDING_FILE" # it had switched: the draining check below takes over
  else
    rec_old=$(sed -n 's/^old=//p' "$PENDING_FILE")
    rec_image=$(sed -n 's/^image=//p' "$PENDING_FILE")
    alive=""
    for id in $rec_old; do
      case "$(status_of "$id")" in running | restarting | paused) alive="$alive $id" ;; esac
    done
    if [ -n "$alive" ]; then
      log "the previous deploy ($rec_image) was interrupted before its switch: rolling back its new containers; its old ones keep serving:$alive"
      roll_back_new "$rec_old"
    else
      log "the previous deploy ($rec_image) was interrupted and none of its old containers runs: its new containers stay as the current ones"
      rm -f "$PENDING_FILE"
    fi
  fi
fi

# The previous deploy's old containers: running ones are still draining (or
# must be drained again when the drain itself died: an SSH drop with
# --wait-drain, a reboot that restarted them); exited ones are removed.
if [ -s "$DRAINING_FILE" ]; then
  still=""
  # shellcheck disable=SC2013 # container ids, one or more per line
  for id in $(cat "$DRAINING_FILE"); do
    case "$(status_of "$id")" in
      gone) ;;
      running | restarting | paused) still="$still $id" ;;
      *)
        "$DOCKER" rm "$id" >/dev/null 2>&1 || :
        log "removed the drained container $id"
        ;;
    esac
  done
  if [ -n "$still" ]; then
    echo "$still" >"$DRAINING_FILE"
    if pid_alive "$(cat "$DRAIN_PID_FILE" 2>/dev/null || :)"; then
      log "the previous deploy's old containers are still draining:$still"
    else
      log "the previous deploy's old containers run with no drain behind them:$still; draining them again"
      start_detached_drain "$still"
    fi
    log "retry once they are gone (drain log: $DRAIN_LOG)"
    exit 75
  fi
  rm -f "$DRAINING_FILE" "$DRAIN_PID_FILE"
fi

log "deploying ${LIAISON_IMAGE}${LIAISON_VERSION:+ (version $LIAISON_VERSION)} to project $COMPOSE_PROJECT_NAME"

# Every --infra service settled: each container runs healthy (or has no
# healthcheck), or exited with code 0 (a one-shot).
infra_settled() {
  for svc in $INFRA_SERVICES; do
    ids=$(compose ps -a -q "$svc")
    [ -n "$ids" ] || return 1
    for id in $ids; do
      case "$(status_of "$id")" in
        running)
          h=$("$DOCKER" inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id" 2>/dev/null || echo gone)
          [ "$h" = healthy ] || [ "$h" = none ] || return 1
          ;;
        exited)
          [ "$("$DOCKER" inspect -f '{{.State.ExitCode}}' "$id" 2>/dev/null || echo 1)" = 0 ] || return 1
          ;;
        *) return 1 ;;
      esac
    done
  done
}

if [ -n "$INFRA" ]; then
  log "--infra: bringing up $INFRA_SERVICES. This may recreate them: NOT zero-downtime."
  # shellcheck disable=SC2086 # word splitting is the service list
  # shellcheck disable=SC2086
  if ! compose up -d --wait $INFRA_SERVICES; then
    # Some Compose releases (2.40) fail `up --wait` once a one-shot service
    # (objectstore-init, data-init) has exited, even with code 0. Judge the
    # services ourselves: each runs (healthy, or without a healthcheck) or
    # exited 0.
    infra_settled || die "the infrastructure services did not come up"
    log "--infra: compose --wait reported a one-shot's exit; every infrastructure service runs or exited 0"
  fi
fi

# Stopped api/worker containers (a crash, an earlier drain) would be started
# again by the scale-up with their old image. Remove them first; `rm` without
# `--stop` never touches a running container.
compose rm -f api worker >/dev/null

old_api=$(words "$(compose ps -a -q api)")
old_worker=$(words "$(compose ps -a -q worker)")
old_app=$(words "$(compose ps -q app)")
n_old_api=$(count "$old_api")
n_old_worker=$(count "$old_worker")
target_api=$((n_old_api + API_REPLICAS))
target_worker=$((n_old_worker + WORKER_REPLICAS))
[ "$target_api" -le "$port_slots" ] ||
  die "$n_old_api old + $API_REPLICAS new api processes need $target_api ports; API_PORT_RANGE $API_PORT_RANGE has $port_slots"
if [ -n "$old_app" ] && [ -n "$old_api" ]; then
  log "WARNING: app runs beside the api processes (a plain \`docker compose up -d\` starts it): it drains as an old process now"
fi
old_ids=$(words "$old_api $old_worker $old_app")

# --- 2. migrations, once, before any new process ------------------------------
PHASE=migrate
log "running migrations and the app catalog (migrate one-shot)"
compose run --rm --no-deps migrate ||
  die "the migrate step failed (a migration, or a catalog app that did not install: see its output). No process was started or stopped; the old processes keep serving"

# The host's one embedding process (meaning profile): started if it is not
# running, never recreated. Tool search ranks by words while it is down, so a
# failure here does not stop the deploy.
if [ -n "$MEANING" ]; then
  compose up -d --no-recreate --no-deps embedder ||
    log "WARNING: the embedder service did not start; tool search ranks by words until it does"
fi

# --- 3. new processes beside the old ones -------------------------------------
# Recorded first: a deploy killed from here on is rolled back by the next run.
printf 'image=%s\nold=%s\n' "$LIAISON_IMAGE" "$old_ids" >"$PENDING_FILE"
PHASE=started
log "starting $API_REPLICAS api + $WORKER_REPLICAS worker beside $n_old_api api + $n_old_worker worker"
compose up -d --no-recreate --no-deps --scale "api=$target_api" --scale "worker=$target_worker" api worker ||
  log "scale-up reported an error; checking what started"

# Every container of the two services, whatever its state (a crash-looping
# one included), that was not there before.
for id in $(all_rolling_ids); do
  contains "$old_ids" "$id" || new_ids="$new_ids $id"
done
new_ids=$(words "$new_ids")

expected=$((API_REPLICAS + WORKER_REPLICAS))
[ "$(count "$new_ids")" -eq "$expected" ] ||
  rollback "expected $expected new containers, found $(count "$new_ids"): $new_ids"

# --- 4. wait until every new container is ready --------------------------------
log "waiting for /readyz on: $new_ids"
deadline=$(($(date +%s) + READY_TIMEOUT_S))
while :; do
  pending=""
  for id in $new_ids; do
    state=$(status_of "$id")
    [ "$state" = running ] || rollback "new container $id is $state"
    health=$("$DOCKER" inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id" 2>/dev/null || echo gone)
    case "$health" in
      healthy) ;;
      none) rollback "new container $id has no healthcheck: cannot tell when it is ready" ;;
      *) pending="$pending $id" ;;
    esac
  done
  [ -n "$pending" ] || break
  [ "$(date +%s)" -lt "$deadline" ] || rollback "not ready within ${READY_TIMEOUT_S}s:$pending"
  sleep 1
done
log "new processes ready: $new_ids"

# --- 4b. the sandbox service follows the new release ----------------------------
# The sandbox service runs the same image as the app and
# refuses runs of another release (docs/self-hosting/sandbox.md, Upgrades).
# It is recreated on the new image now, as the new processes take over: from
# here the old ones' remaining sandbox runs are refused while they drain, which
# the new processes retry. A stack whose compose file defines it but where none
# runs yet (the first rolling deploy of a release that starts it with the
# stack) gets it started here, unless LIAISON_APP_RUNTIME=quickjs keeps every
# app off it (a host left without the service, `--scale sandbox=0`).
sandbox_wanted() {
  "$DOCKER" compose config --services 2>/dev/null | grep -qx sandbox || return 1
  ! "$DOCKER" compose config 2>/dev/null | grep -Eq "LIAISON_APP_RUNTIME: [\"']?quickjs[\"']?\$"
}
if [ -n "$("$DOCKER" compose ps -a -q sandbox 2>/dev/null)" ]; then
  log "recreating the sandbox service on the new image"
  "$DOCKER" compose up -d --no-deps sandbox ||
    log "WARNING: the sandbox service was not recreated; app runs on it are refused until it runs this release: docker compose up -d sandbox"
elif sandbox_wanted; then
  log "starting the sandbox service on the new image"
  "$DOCKER" compose up -d --no-deps sandbox ||
    log "WARNING: the sandbox service did not start; app runs on it fail until it does: docker compose up -d sandbox (docs/self-hosting/sandbox.md)"
fi

# --- 5. the edge moves; the old processes drain ----------------------------------
if [ -z "$old_ids" ]; then
  rm -f "$PENDING_FILE"
  log "deploy done: no old processes to drain"
  exit 0
fi
sleep "$EDGE_SETTLE_S"
echo "$old_ids" >"$DRAINING_FILE"
rm -f "$PENDING_FILE"
PHASE=switched
[ -z "$old_app" ] ||
  log "app is drained as an old process: from now on deploy with this script only, and remove port 3000 from the edge"
if [ -n "$WAIT_DRAIN" ]; then
  # shellcheck disable=SC2086
  drain $old_ids
  log "deploy done"
else
  start_detached_drain "$old_ids"
  log "deploy done; the old containers drain in the background (up to ${DRAIN_TIMEOUT_S}s, log: $DRAIN_LOG)"
fi
