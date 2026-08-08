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
- Postgres (`whisky-db`) and Valkey (`whisky-valkey`) live in their own
  compose project and are never restarted by any step here.
- The Python collector is a separate checkout with its own cron; nothing
  here deploys or rolls it back. Its interaction with the new schema is
  covered in the post-checks.
- Migrations apply in **one transaction** — a failed apply leaves the schema
  exactly as it was. There is nothing to roll back after a failed
  `migrate` step; only after a _successful_ one.

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
docker compose logs service            > ~/whisky-rollback/latest/service.log 2>&1
docker inspect whisky-be-migrate --format '{{.State.ExitCode}}' \
                                       > ~/whisky-rollback/latest/migrate-exit-code 2>&1
```

Only after the incident is closed and understood:

- remove the `whisky-be:failed-*` and `whisky-be:pre-upgrade` tags
  (`docker rmi <tag>`);
- remove stopped leftover containers (`docker ps -a` → `docker rm`);
- delete the `~/whisky-rollback/<ts>/` directory — **it contains plaintext
  secrets** (the copied compose file); do not let these accumulate.
