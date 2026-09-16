# Emergency rollback — production upgrade of `be/`

This runbook covers the upgrade that fast-forwards the prod checkout from
`5ea8b19` to `a697d77` (11 commits: the sync overhaul, the new deploy
mechanism, and 3 DB migrations), and any later deploy that follows the same
shape. Goal in an incident: **restore service first, investigate later.**

All commands run on the prod server, from the `be/` checkout, unless stated
otherwise. `docker compose` and the standalone `docker-compose` are
interchangeable here.

## 0. Scope and invariants

- **Old stack** = the untracked, server-local `docker-compose.prod.yaml`
  (real secrets inline). `git pull` never touches it — it stays on disk and
  remains startable throughout.
- **New stack** = the committed `docker-compose.yaml` (+ `scripts/deploy.sh`,
  secrets interpolated from the git-ignored `.env`).
- Both stacks publish `192.168.179.2:9977` and use `container_name:
  whisky-be` → **they run strictly one at a time**. nginx already targets
  `192.168.179.2:9977` and needs no change in either direction — nginx steps
  below are verify-only.
- Postgres (`whisky-db`) and the session store (`whisky-valkey`) **are now
  services of the new stack**, alongside the catalogue cache
  (`whisky-cache`). They used to live in their own compose project, which is
  what the `external` networks in earlier revisions attached to. Two
  consequences for anything below: `compose up -d` and `compose down` now
  reach them, so a `down` takes the database with the app; and their data is
  held in volumes declared `external` (`whisky_whisky_pg_data`,
  `whisky_whisky_valkey_data` by default), so compose refuses to start rather
  than silently creating an empty cluster if a name is wrong. Prefer
  `compose up -d service` and `compose stop service` when the intent is the
  application alone.
- The Python collector is a separate checkout with its own cron; nothing
  here deploys or rolls it back. Its interaction with the new schema is
  covered in the post-checks.
- Migrations apply in **one transaction** — a failed apply leaves the schema
  exactly as it was. There is nothing to roll back after a failed
  `migrate` step; only after a _successful_ one.

## 0.1 One-time: adopting Postgres and the session store

Only for the first deploy after they became services of this compose file.
Skip it afterwards.

The data stays where it is — `down` without `-v` never touches a named
volume — and the new stack attaches to the very same volumes by name, which
is why they are declared `external`: a wrong name fails the deploy instead of
starting an empty cluster.

```bash
# 1. Confirm the volumes, and that the names match PG_VOLUME / VALKEY_VOLUME.
docker volume ls | grep -E 'pg_data|valkey_data'

# 2. Take a dump first. This is the step that makes the rest reversible.
scripts/db-backup.sh backup

# 3. Stop the old infrastructure project, whatever it is called. Its
#    containers hold the names and networks the new stack wants.
docker compose -p <old-project> -f <its-compose-file> down

# 4. Confirm the volumes are still there.
docker volume ls | grep -E 'pg_data|valkey_data'

# 5. Deploy. It creates whisky-db, whisky-valkey, whisky-cache and the app.
scripts/deploy.sh
```

If step 5 reports `external volume "..." not found`, the name in `.env` does
not match step 1 — fix `PG_VOLUME`/`VALKEY_VOLUME` rather than letting compose
create one. If it warns that a network `exists but was not created for
project`, the old project's networks are still around: `docker network rm
whisky_db whisky_valkey` once nothing is attached.

**Rolling this back** is stopping the new stack and starting the old
infrastructure project again; both read the same volumes, so no data moves.

## 0.2 One-time: the monitoring deploy (2026-09-15)

The monitoring stack is a **separate compose project** and is purely
additive — rolling it back is `docker compose -f
infra/docker-compose.monitoring.yaml down`, which touches nothing the
application uses. It holds no application data; its volumes are Prometheus's
own samples and Grafana's own database.

**One thing in that deploy is not additive, and it is the only rollback trap
here: the HAProxy probe URI moved from `/health` to `/health/live`.**

- `infra/haproxy/haproxy.cfg` now probes `/health/live`, a route that exists
  only from this version of the API onwards.
- **Rolling the application back past this commit while that config is
  mounted drains the entire backend**: every replica 404s the probe, HAProxy
  takes them all out of rotation, and the site answers 503 with three healthy
  replicas running.
- So a rollback of the app **must** restore the probe URI in the same step:

  ```bash
  sed -i 's|uri /health/live|uri /health|' infra/haproxy/haproxy.cfg
  docker compose up -d lb          # HAProxy re-reads its config on restart
  docker compose ps be             # then verify the replicas come back up
  ```

  Confirm with HAProxy's own view rather than by assumption:

  ```bash
  docker exec whisky-lb wget -qO- http://127.0.0.1:8404/metrics \
    | grep '^haproxy_server_status{proxy="app".*state="UP"'
  ```

  One line per slot, and the value is what matters: `1` is in rotation, `0` is
  not. Three slots at `1` is a healthy fleet; every slot at `0` is this trap.
  The exporter publishes a 0/1 series per state rather than a status number,
  so the unused slots of the sixteen-slot template read `state="MAINT"` and
  are not a fault.

Two smaller notes for the same deploy:

- `haproxy.cfg` **moved** to `infra/haproxy/`, so a checkout rolled back past
  this commit expects it at the repository root again. `docker-compose.yaml`
  carries the matching path, so rolling both back together is consistent;
  rolling back only one is not.
- The host nginx template now returns 404 for `/api/health` and
  `/api/metrics`. Nothing applies it automatically, so a rollback of this
  repository does not undo it — if the block was copied to the host, put the
  previous server block back by hand.

## 0.3 One-time: the log stack deploy (2026-09-16)

Two containers joined the **monitoring** compose project — VictoriaLogs and
Vector — and that half is purely additive, exactly as §0.2 describes: `docker
compose -f infra/docker-compose.monitoring.yaml down` touches nothing the
application uses, and neither volume holds anything the application needs.

**Two changes landed in the application's own `docker-compose.yaml`, and
neither is a trap:**

- **`logging:` blocks on all six services** (`json-file`, `max-size: 20m`,
  `max-file: 3`). Purely additive and independently useful — it was an
  outstanding item in three load-test documents before this. Rolling it back
  restores unbounded log growth, which is the thing to _avoid_ rolling back.
- **`LOG_JSON=false` became `true`.** Rolling the repository back restores
  `false`, and **nothing breaks when it does.** The collector's Docker
  transform parses optimistically and keeps the raw line when the parse fails,
  so pino-pretty output arrives as plain text with its message intact — it
  simply stops being filterable by `level` and `context`. That degradation is
  by design; see `infra/vector/vector.yaml`.

**The one thing to be careful with is `-v`**, and it is a nuisance rather than
a loss:

```bash
# Fine — stops the log stack, keeps everything.
docker compose -f infra/docker-compose.monitoring.yaml down

# NOT this. It destroys `vector_data`, which holds the collector's read
# offsets, so on the next start Vector re-reads every file inside its
# ignore window and ships those lines a second time.
docker compose -f infra/docker-compose.monitoring.yaml down -v
```

Duplicate lines, not missing ones — and `victorialogs_data` goes with it,
which is the stored history. The same "never `-v`" rule §0.2 and
`docker-compose.yaml` already state for the application's data volumes.

Three smaller notes for the same deploy:

- The Grafana plugin installs into the `grafana_data` volume, so rolling the
  repository back removes the provisioned datasource file but leaves the
  plugin in place. Harmless: an installed plugin with no datasource does
  nothing.
- `infra/.env` gains nine variables. A rollback leaves them set and unread,
  which is also harmless — but if `GRAFANA_PLUGINS_PREINSTALL` was set to the
  empty string for the offline path, remember that the plugin then lives in
  `infra/grafana/plugins/`, which is git-ignored and survives a checkout.
- Nothing in `src/` changed and no migration shipped, so there is no database
  half to this deploy at all.

## 1. Pre-flight (mandatory, BEFORE the upgrade)

Everything below is cheap; do all of it. It is what makes the rollback paths
one-command affairs.

```bash
export ROLLBACK_DIR=~/whisky-rollback/$(date -u +%Y%m%dT%H%M%SZ)
mkdir -m 700 -p "$ROLLBACK_DIR"
ln -sfn "$ROLLBACK_DIR" ~/whisky-rollback/latest

# 1. Git state (the SHA is what PATH A's rebuild fallback checks out)
git rev-parse HEAD                >  "$ROLLBACK_DIR/HEAD-sha"
git status --porcelain            >  "$ROLLBACK_DIR/git-status.txt"
git diff HEAD                     >  "$ROLLBACK_DIR/local-changes.patch"

# 2. The running stack, verbatim and resolved
cp docker-compose.prod.yaml          "$ROLLBACK_DIR/"
docker compose -f docker-compose.prod.yaml config \
                                  >  "$ROLLBACK_DIR/compose-config.txt"
sudo nginx -T                     >  "$ROLLBACK_DIR/nginx.txt"

# 3. Protect the running image from pruning/rebuilds
docker inspect whisky-be --format '{{.Image}}' \
                                  >  "$ROLLBACK_DIR/image-id.txt"
docker tag "$(cat "$ROLLBACK_DIR/image-id.txt")" whisky-be:pre-upgrade

chmod 600 "$ROLLBACK_DIR"/*   # the compose copy holds real secrets
```

Then a fresh dump, and prove the restore path works without touching
anything (safe mode only prints the plan):

```bash
./scripts/db-backup.sh backup
./scripts/db-backup.sh list                      # note the newest dump name
./scripts/db-backup.sh restore <newest-dump>     # DRY RUN: validates + prints, changes nothing
echo '<newest-dump>' > "$ROLLBACK_DIR/dump-name"
```

If the dry run errors, fix `scripts/db-backup.env` (`ADMIN_USER`/`DB_MAINT`)
**before** deploying — PATH C depends on it.

## 2. Recommended cutover sequence

This ordering keeps downtime near zero and defines the pivot points the
triage table refers to. The schema changes are additive, so the old app
keeps serving correctly while the migrations are already applied.

```bash
git pull --ff-only
# create/verify .env: DB_NAME, DB_USER, DB_PASS, JWT_ACCESS_SECRET
docker compose build
docker rm -f whisky-be-migrate 2>/dev/null || true
docker compose run --rm migrate                    # old app still serving
docker compose -f docker-compose.prod.yaml down    # old stack off
docker compose up -d                               # new stack on
curl -fsS http://192.168.179.2:9977/docs-json -o /dev/null && echo OK
```

## 3. Triage — pick the path

| Symptom                                                                           | Path                                                                                                                                                                             |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Site unreachable, but `curl http://192.168.179.2:9977/...` on the server answers  | Proxy/nginx problem, **no rollback** — compare `sudo nginx -T` with `$ROLLBACK_DIR/nginx.txt`, `nginx -t`, reload                                                                |
| `migrate` step failed during the cutover above                                    | DB unchanged (single transaction), old stack still running (or one `-f docker-compose.prod.yaml up -d` away). **No rollback** — read `docker logs whisky-be-migrate`, fix, retry |
| Migration succeeded, new app up but broken (errors, wrong behavior)               | **PATH A** (fast; keeps the new schema)                                                                                                                                          |
| Old system misbehaves against the new schema, or the schema itself is the suspect | **PATH B**, then PATH A if the old app is not already back                                                                                                                       |
| Data is corrupted (bad writes, lost rows)                                         | **PATH C**, then PATH A                                                                                                                                                          |

## PATH A — put the old app back (minutes, no git)

The old image and `docker-compose.prod.yaml` are still on the server;
nothing needs rebuilding.

```bash
# 1. FIRST: preserve the failed image for forensics (a later rebuild would
#    silently overwrite the bare tag)
docker tag whisky-be:latest "whisky-be:failed-$(date -u +%Y%m%dT%H%M%SZ)" 2>/dev/null || true

# 2. Swap the stacks
docker compose down                                  # new stack off
docker compose -f docker-compose.prod.yaml up -d     # old stack on — NO --build

# 3. Verify
curl -fsS http://192.168.179.2:9977/docs-json -o /dev/null && echo direct OK
curl -fsS https://<public-host>/api/meta -o /dev/null && echo via-nginx OK
```

Do **not** pass `--build` in step 2: after `git pull` the build context is
the NEW code. `up -d` without it reuses the image that ran before the
upgrade. Fallback only if that image was pruned:

```bash
git checkout "$(cat ~/whisky-rollback/latest/HEAD-sha)"
docker compose -f docker-compose.prod.yaml up -d --build
git checkout main     # the checkout can go back right away; the image is built
```

### Post-checks (PATH A keeps the new schema — that is fine, it is additive)

1. **Stuck sync-run locks.** A crashed collector run leaves an open
   `sync_log` row, and the new partial unique index then blocks that store's
   next run. Detect and clear:

   ```bash
   docker exec -it whisky-db psql -U "$DB_USER" -d "$DB_NAME" -c \
     'SELECT id, "storeId", "createdAt" FROM sync_log WHERE success IS NULL;'
   docker exec -it whisky-db psql -U "$DB_USER" -d "$DB_NAME" -c \
     'UPDATE sync_log SET success = false, "finishedAt" = now(),
        "updatedAt" = now() WHERE success IS NULL;'
   ```

2. **Python collector still writes.** Wait for the next cron run or trigger
   one from the scrapper checkout (`docker compose run --rm collect-now`),
   then confirm a fresh `sync_log` row closed with `success = true`.

3. Known benign edge while old system + new schema coexist: a **second**
   collector run on the same day hits the new `(productId, capturedOn)`
   unique index (the first run's row already holds that day's price). No
   action needed — it self-heals the next day.

## PATH B — revert the 3 migrations

Only needed when the schema itself must go. Works **before or after PATH A**
— it needs the committed `docker-compose.yaml` (the `migrate` service) and
the new image, and PATH A removes neither. Do NOT run it after checking the
repo out to the old commit.

What `down()` cannot restore: same-day duplicate snapshots deleted by the
`capturedOn` migration (only a dump has them), and run rows it force-closed
(they stay stamped `success = false`). `store_config.group`/`engine` values
are dropped but recomputable.

```bash
# 1. Stop the app — DROP COLUMN/INDEX takes an ACCESS EXCLUSIVE lock
docker compose stop service          # or: docker compose -f docker-compose.prod.yaml stop

# 2. See what is applied
docker rm -f whisky-be-migrate 2>/dev/null || true
docker compose run --rm migrate \
  node node_modules/typeorm/cli.js migration:show -d dist/typeorm.config.js

# 3. Revert ONE migration, then look again
docker compose run --rm migrate \
  node node_modules/typeorm/cli.js migration:revert -d dist/typeorm.config.js
docker compose run --rm migrate \
  node node_modules/typeorm/cli.js migration:show -d dist/typeorm.config.js
```

Repeat step 3 **one invocation at a time** until the newest `[X]` line is
`WhiskyDomain1783840751031`, then **STOP**. Never batch the reverts: each
call reverts whatever is newest, and a fourth one starts unwinding the base
domain schema itself.

Then start the app you want (PATH A step 2 for the old one).

## PATH C — full DB restore (nuclear)

Restores the pre-upgrade dump: **everything written after it is lost**,
including that day's collector snapshots. The restored DB carries the
pre-upgrade `migrations` table, so the schema is effectively reverted too —
PATH B is unnecessary after this.

Run at a real interactive terminal (the script refuses piped stdin), with
the API stopped:

```bash
docker compose stop service   # or: docker compose -f docker-compose.prod.yaml stop
./scripts/db-backup.sh restore "$(cat ~/whisky-rollback/latest/dump-name)" --safe=false
# confirms by asking you to type the database name; single transaction
```

Then PATH A to start the old app, and its post-checks.

## Forensics and cleanup

Before any cleanup, save into `~/whisky-rollback/latest/`:

```bash
docker logs whisky-be-migrate          > ~/whisky-rollback/latest/migrate.log 2>&1
docker compose logs be            > ~/whisky-rollback/latest/service.log 2>&1
docker inspect whisky-be-migrate --format '{{.State.ExitCode}}' \
                                       > ~/whisky-rollback/latest/migrate-exit-code 2>&1
```

Only after the incident is closed and understood:

- remove the `whisky-be:failed-*` and `whisky-be:pre-upgrade` tags
  (`docker rmi <tag>`);
- remove stopped leftover containers (`docker ps -a` → `docker rm`);
- delete the `~/whisky-rollback/<ts>/` directory — **it contains plaintext
  secrets** (the copied compose file); do not let these accumulate.
