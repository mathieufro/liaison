#!/bin/sh
# SPDX-License-Identifier: FSL-1.1-ALv2
#
# The API image's entrypoint.
#
#   serve (default)  migrate (unless LIAISON_MIGRATE_ON_START=false), reconcile
#                    the first-party catalog apps, then exec the server.
#   migrate          migrate and reconcile, then exit: the one-shot step a
#                    rolling deploy runs once, before it starts new processes.
#                    Non-zero when a migration or a catalog app install fails.
#                    Both refuse an image older than the database's schema
#                    (src/db/schema-guard.ts), with or without the migration.
#   embedder         the host's embedding process for tool search
#                    (src/modules/agent/tools/embedder-main.ts): loads the
#                    model once and answers the host's processes on a Unix
#                    socket. No migration, no server, no privileged URL.
#   sandbox          the app sandbox service (packages/sandbox-supervisor): a
#                    supervised pool of workerd processes, the compose
#                    `sandbox` service. No database, no secret.
#   anything else    run as given (one-off CLI containers: `docker compose run
#                    app bun ...`).
#
# Migrations take a lease in the database (src/db/migrate.ts), so replicas that
# start together apply each migration once: one runs them, the others wait and
# then find nothing to do. A rolling deploy sets LIAISON_MIGRATE_ON_START=false
# on its long-running services and runs `migrate` itself.
#
# The privileged MIGRATION_DATABASE_URL is for the setup steps ONLY. The server
# is started with it removed from its environment (`env -u`), so a code
# execution foothold in the API process, or a child it spawns, cannot read a
# role that bypasses row-level security. When it is unset, migrate falls back
# to DATABASE_URL (single-role dev setups only; migrate.ts refuses the
# unprivileged app role in production).
#
# The setup steps run with LIAISON_ONESHOT=1: their database pools stay at 2
# connections each, outside the pool plan of the long-running processes
# (apps/api/src/db/pool-plan.ts).
#
# The server step is `exec`ed so the API replaces this shell: Docker signals
# the top process, and a shell there never forwards SIGTERM, so the app would
# never drain and would be SIGKILLed at stop_grace_period.
set -eu

APP_DIR="${LIAISON_APP_DIR:-/app}"

# The migration runs as a child of this shell (a step follows it), so the shell
# forwards `docker stop`'s SIGTERM (and a Ctrl-C) to it: the migration then
# releases its lease and exits instead of holding the lease until its TTL, and
# the shell stops there. SIGINT goes on as SIGTERM, because a background job of
# a non-interactive shell starts with SIGINT ignored.
migrate() {
  (cd "$APP_DIR/apps/api" && LIAISON_ONESHOT=1 MIGRATION_DATABASE_URL="${MIGRATION_DATABASE_URL:-${DATABASE_URL:-}}" exec bun src/db/migrate.ts) &
  child=$!
  signalled=""
  trap 'signalled=1; kill -TERM "$child" 2>/dev/null || :' TERM INT
  status=0
  # `wait` returns early (over 128) when a trapped signal arrives: wait again
  # until the child itself has exited, and keep its status.
  while :; do
    status=0
    wait "$child" || status=$?
    kill -0 "$child" 2>/dev/null || break
  done
  trap - TERM INT
  if [ -n "$signalled" ]; then exit 143; fi
  return "$status"
}

# The check migrate.ts runs under its lease, for a start that skips the migration.
schema_guard() {
  (cd "$APP_DIR/apps/api" && LIAISON_ONESHOT=1 MIGRATION_DATABASE_URL="${MIGRATION_DATABASE_URL:-${DATABASE_URL:-}}" bun src/db/schema-guard.ts)
}

# Fail-soft on a server start: without --strict, reconcile-catalog-boot.ts exits 0.
reconcile() {
  (cd "$APP_DIR/apps/api" && LIAISON_ONESHOT=1 bun src/db/reconcile-catalog-boot.ts)
}

case "${1:-serve}" in
  sandbox)
    exec bun "$APP_DIR/packages/sandbox-supervisor/src/main.ts"
    ;;
  migrate)
    migrate
    cd "$APP_DIR/apps/api"
    # Strict: a catalog app that does not install fails the one-shot, so a
    # deploy stops before starting new processes. Exec'd so a stop during it
    # reaches it directly.
    LIAISON_ONESHOT=1 exec bun src/db/reconcile-catalog-boot.ts --strict
    ;;
  embedder)
    cd "$APP_DIR/apps/api"
    exec env -u MIGRATION_DATABASE_URL bun src/modules/agent/tools/embedder-main.ts
    ;;
  serve) ;;
  *) exec "$@" ;;
esac

if [ "${LIAISON_MIGRATE_ON_START:-true}" != "false" ]; then
  migrate
else
  schema_guard
fi
reconcile
cd "$APP_DIR"
exec env -u MIGRATION_DATABASE_URL bun run apps/api/src/index.ts
