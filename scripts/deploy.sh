#!/usr/bin/env bash
#
# Two-phase production deploy for the backend:
#
#   1. build the image           (compose build)
#   2. apply DB migrations       (compose run --rm migrate)
#   3. swap the app container    (compose up -d)
#
# Running migrations BEFORE `up` is what keeps the currently-running app
# untouched when a migration fails: the `depends_on` gate in the compose file
# only blocks the START of the new app container — a bare `up -d --build`
# still replaces the old container during its create phase, so a failed
# migration would leave the app down (a `Created`, never-started container)
# until the operator intervenes. With this script a failure in step 2 aborts
# the deploy while the previous version keeps serving.
set -euo pipefail

cd "$(dirname "$0")/.."

# The compose plugin (`docker compose`) where available (prod host), the
# standalone `docker-compose` binary otherwise (dev machine runs podman).
if docker compose version > /dev/null 2>&1; then
  compose() { docker compose "$@"; }
else
  compose() { docker-compose "$@"; }
fi

# The sync log directory is bind-mounted into the container, which runs as the
# non-root `appuser` (uid 10001). Docker creates a missing bind source as
# root:root 0755, which that user cannot write to — and the per-sync log files
# would silently never appear. Single-tenant host, so a permissive mode is
# preferred over a chown that would need root.
echo '==> Preparing the sync log directory'
mkdir -p log
chmod 777 log

echo '==> Building image'
compose build

echo '==> Applying DB migrations'
compose run --rm migrate

echo '==> Starting the app'
compose up -d

echo '==> Deploy finished'
