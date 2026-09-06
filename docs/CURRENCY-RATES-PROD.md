# Currency rates — what production needs beyond the deploy

Shipped in `6cfab87`. `scripts/deploy.sh` applies the `currency-rate` migration and starts the new app on its own; everything below is what the deploy does **not** do.

Read `be/CLAUDE.md` → "API contract" → "Currency rates" for why any of this is shaped the way it is.

---

## 0. Before you start: what the deploy leaves you with

The migration creates `currency` and `currency_rate` and seeds three currency rows (UAH, USD, EUR). It seeds **no rates at all** — those come from an HTTP API, and a migration gates every deploy, so it must never depend on one.

So immediately after the deploy the tables exist and are empty, `GET /currency` works, and every conversion answers `404`. That is expected. Step 2 is what fixes it.

---

## 1. Check the container can reach bank.gov.ua — this is the real risk

**Do this first.** It is the one step that can genuinely fail, and the one nobody would guess.

`DOCKER-USER` on this host is a whitelist ending in `LOG` + `DROP` (see `docs/OUTAGE-2026-08-30-HANDOFF.md` §S, §G3). `bank.gov.ua` is a destination the containers have never talked to before. If the whitelist is by destination and does not include it, two things happen: the rate sync silently fails, **and** every dropped packet writes a kernel-log line that `psad` reads as a port scan — which is exactly the mechanism that took the API down for one to four hours a day between 2026-08-30 and 09-05.

```bash
sudo iptables -L DOCKER-USER -nv --line-numbers
```

Confirm outbound TCP 443 from the container subnets is allowed to arbitrary destinations. If the whitelist is by destination, add `bank.gov.ua` before going further.

Also confirm the `psad` hardening from the outage handoff (§G3) is in place, because it is the backstop if a packet does get logged:

```bash
sudo grep -n '172.16.0.0/12' /etc/psad/auto_dl        # expect: 172.16.0.0/12 0;
sudo grep -n 'AUTO_BLOCK_DL5_TIMEOUT' /etc/psad/psad.conf
sudo iptables -L PSAD_BLOCK_INPUT -n 2>/dev/null | head
```

The last one should not list any `172.*` container address. If it does, the API is already being blocked and that is a separate, more urgent problem.

**Quick reachability probe**, once the new app container is running:

```bash
docker compose exec service node -e "fetch('https://bank.gov.ua/NBU_Exchange/exchange?json',{signal:AbortSignal.timeout(15000)}).then(r=>console.log('HTTP',r.status)).catch(e=>console.error('FAILED:',e.message))"
```

Expect `HTTP 200`. Anything else — a timeout above all — means step 2 will fail, and the whitelist is where to look.

---

## 2. Backfill the history — one time, required

Without this the table only ever holds the trailing week the daily job fetches, so any purchase older than a week converts to `404`.

**`pnpm rates` does not work in production.** It runs through `ts-node`, which is a devDependency and is not in the image — the same reason migrations run as `dist/scripts/migrate.js`. The compiled script is in the image and `nest build` has already rewritten its `~/*` aliases to relative paths, so it runs under plain `node` (verified).

Run it inside the already-running app container:

```bash
docker compose exec service node dist/scripts/currency-rates.js --full
```

`docker compose exec` rather than `run`: the `service` entry has a fixed `container_name: whisky-be`, so `compose run` would collide with the running container.

Expect roughly this, in about 30 seconds (58 requests, ~4 MB):

```
Syncing NBU rates from 1996-01-01
USD 1996-01-01..1996-12-31: 360 day(s)
...
USD 2026-01-01..<today+1>: 250 day(s)
USD: carried the last known rate into 12 day(s) the source does not publish
Done: USD, EUR 1996-01-01..<today+1>, 21315 day(s) fetched, 21315 written
EUR: 10112 day(s), 1999-01-01..<today+1>
USD: 11203 day(s), 1996-01-06..<today+1>
Every currency is gap-free.
```

Three things to check in that output:

- **`Every currency is gap-free.`** The script exits `1` without it. The source publishes a rate for every calendar day, so a hole can only mean the stored copy lost days.
- **`carried the last known rate into 12 day(s)`** — the NBU's own series is missing twelve days of 1996-1997 (1996-11-18, and in 1997: 02-28, 03-31, 04-29, 06-02, 06-30, 07-01, 09-09, 11-08..11). They are filled by carrying the previous day's rate forward. Twelve is the expected number; a much larger one means something changed at the source.

  The per-year lines are the **raw** counts from the source, printed before the filling, so they are legitimately short of a full year in exactly those two: 1996 shows 360 (361 days from 01-06 to year end, less the one missing) and 1997 shows 354 (365 less eleven). Every other year is a full 365 or 366, and `EUR` shows `0 day(s)` for 1996-1998 because the euro did not exist yet. Only the summary lines at the end count the filled days.
- **`21315 day(s) written`** — matches `fetched`, because the write is an upsert rather than an insert.

It is safe to re-run, safe to interrupt, and safe to run while the daily job fires. If it fails partway, just run it again — it resumes by rewriting what it already has.

---

## 3. Verify

```bash
docker compose exec whisky-db psql -U "$DB_USER" -d "$DB_NAME" -c '
SELECT c.code, count(*) AS days,
       MIN(cr."effectiveOn") AS first_day,
       MAX(cr."effectiveOn") AS last_day,
       count(*) - (MAX(cr."effectiveOn") - MIN(cr."effectiveOn") + 1) AS holes
FROM currency_rate cr JOIN currency c ON c.id = cr."currencyId"
GROUP BY c.code ORDER BY 1;'
```

`holes` must be `0` for both rows. `EUR` starts 1999-01-01, `USD` 1996-01-06. `last_day` is normally **tomorrow** — the NBU publishes the next business day's rate after 15:30 Kyiv, and that is stored as-is rather than clamped.

Then the API, as any logged-in user:

```bash
curl -s -H "Authorization: Bearer $TOKEN" 'https://<host>/api/currency/rate/latest'
curl -s -H "Authorization: Bearer $TOKEN" 'https://<host>/api/currency/convert?amount=1200&from=UAH&to=USD&date=2015-06-01'
```

The second must answer `converted: 57.01`, `toRate: 21.048227`. **This is the check worth doing**: it exercises a pre-2020 date, and pre-2020 is where the NBU quoted USD per *100* units. If `toRate` ever comes back around `2104` instead of `21.05`, the normalization is broken and every historical amount is a hundred times off.

And confirm the schedule armed, in the app log:

```
CurrencyRateCronService: Currency rate schedule armed: "30 16 * * *" (Europe/Kyiv), next run ...
```

---

## 4. The day after

The daily job runs at **16:30 Kyiv** — after the bank's 15:30 publication cutoff, so each run stores the *next* business day's rate and a missed run costs nothing. Confirm one fired:

```bash
docker compose logs service --since 24h | grep -i 'Currency rates synced'
```

Expect `16 day(s) fetched, 16 written` — a trailing 7-day window plus tomorrow, times two currencies. The window is deliberate: a run missed to a restart or an outage heals itself at the next tick instead of leaving a permanent hole.

If it never fires, `POST /currency/rate/sync` (permission `store:sync`) runs the same pass by hand, any number of times a day.

---

## 5. Configuration — nothing is required

Every variable has a working default and the feature runs with none of them set. They are forwarded by `docker-compose.yaml`, so setting one in the host `.env` is enough.

| Variable | Default | When you would touch it |
| --- | --- | --- |
| `CURRENCY_RATE_CRON_ENABLED` | `true` | Set `false` to stop the daily job. |
| `CURRENCY_RATE_CRON_EXPRESSION` | `30 16 * * *` | Move the hour. `30 9,16 * * *` for twice daily — free, since the write is an upsert. |
| `CURRENCY_RATE_TIMEZONE` | `Europe/Kyiv` | |
| `CURRENCY_RATE_SYNC_WINDOW_DAYS` | `7` | How many trailing days each run re-fetches. |
| `CURRENCY_RATE_CODES` | `USD,EUR` | Adding a code needs a `currency` row too — a migration, not just this. |
| `NBU_BASE_URL` | `https://bank.gov.ua` | |
| `NBU_TIMEOUT_MS` / `NBU_RETRIES` | `30000` / `3` | |

**Note the cron ships enabled**, unlike `SYNC_CRON_ENABLED`. A scrape that starts on its own is a surprise worth opting into; a rates table that quietly stops updating shows wrong money on every screen that converts. An unusable cron expression fails the boot on purpose — a schedule that silently never fires is the worse failure.

---

## 6. Frontend — nothing now

`web/` uses none of these endpoints yet; the personal collection that will is being built separately. When it lands, the generated client picks them up through the usual `pnpm schema && pnpm codegen` (which needs `SWAGGER_ENABLED=true` on the backend — already the case in `docker-compose.yaml`).

---

## If something goes wrong

**Backfill fails with a timeout or a connection error.** The container cannot reach `bank.gov.ua`. Go back to step 1; do not retry in a loop, because every dropped packet is a kernel-log line `psad` can act on.

**Backfill ends `MISSING n day(s) between X and Y`.** The stored copy lost days. Re-run `--full`; it is an upsert and will refill them. If it repeats, the source changed shape and the mapper's assertions are worth reading.

**A conversion answers 404 for a date you expect to work.** Check the date is inside the stored range (step 3). Before 1996-01-06 for USD, or 1999-01-01 for EUR, there is no official rate and 404 is the correct answer — the alternative would be inventing one.

**Rates look a hundred times too large.** Only possible if the source stopped sending `units`/`rate_per_unit` in the shape the mapper asserts on, which would have thrown rather than written. Check `SELECT rate FROM currency_rate ... WHERE "effectiveOn" = '2010-01-04'` — it must be `7.985`, not `798.5`.

**Undoing it.** `pnpm migration:revert` (or `node dist/scripts/migrate.js` equivalents) drops both tables and everything in them. Nothing else references them, so nothing else breaks; re-running the backfill restores the data in half a minute.
