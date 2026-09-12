# Catalogue cache — what production needs beyond the deploy

`scripts/deploy.sh` ships the cache and starts it. Everything below is what the deploy does **not** do.

Read `be/CLAUDE.md` → "Catalogue cache" for why any of this is shaped the way it is.

---

## 0. What the deploy leaves you with

A working cache on its own instance, and nothing to run.

`docker-compose.yaml` defines the `cache` service — a `whisky-cache` container
on the app's own network — and the app is pointed at it by fixed
`CACHE_VALKEY_HOST`/`CACHE_VALKEY_PORT` values in the same file. `scripts/deploy.sh`
brings it up with everything else.

The first boot logs one line naming the counter it created:

```
Catalogue cache generation -> 1789074304 (boot)
```

---

## 1. Why it is a second instance, and what it is configured with

A cache and a session store want opposite things from a Valkey that fills up,
and `maxmemory-policy` is per instance, so no single policy serves both:

- **A cache should evict.** Its entries are regenerable; losing the oldest
  costs one recomputation.
- **A session store must never lose a key.** `AuthSessionService` reads a
  missing session as a revoked one and calls `revokeAll`, which signs that
  user out of **every** device.

On one instance with `allkeys-lru`, a large report entry can evict a session
and log somebody out. With `noeviction` and no `maxmemory`, the instance grows
until it is killed; with `noeviction` at a ceiling it refuses _every_ write,
including `register` and `refresh`, so **nobody can log in**. Neither is a
state to discover under load.

Hence the `cache` service runs `--maxmemory 512mb --maxmemory-policy
allkeys-lru --save '' --appendonly no`: it sheds its oldest entries, and it
keeps nothing on disk because every entry is regenerable and a reloaded
append-only file would only restore entries the boot bump has already
superseded.

**Sizing.** A full unfiltered `catalog` entry is ~800 KB compressed and most
entries are far smaller, so the default 512 MB is generous for a handful of
users. The cap matters more than its exact value: it is what turns "out of
memory" into "evict something". `evicted_keys` climbing steadily means the mix
outgrew it — nothing breaks, the hit rate falls.

Both numbers are variables (`CACHE_MAXMEMORY`, `CACHE_MEMORY_LIMIT`) and they
move together: the container limit has to stay above the Valkey cap, or the
container is killed by the kernel instead of evicting its oldest entries.

**Pointing it somewhere else.** Every `CACHE_VALKEY_*` setting falls back to
its `VALKEY_*` equivalent, so unsetting the two fixed values in the compose
file makes the cache share the session instance again. That is the
development default and an acceptable emergency, not a production posture —
see above for what it risks.

---

## 2. Checks

```bash
# The generation, and what is cached right now.
docker exec whisky-cache valkey-cli GET cache:gen:catalogue
docker exec whisky-cache valkey-cli --scan --pattern 'cache:*'

# One entry's lifetime and size.
docker exec whisky-cache valkey-cli TTL          '<key>'
docker exec whisky-cache valkey-cli MEMORY USAGE '<key>'

# Memory headroom and whether anything is being evicted.
docker exec whisky-cache valkey-cli INFO memory | grep -E 'used_memory_human|maxmemory_human|maxmemory_policy'
docker exec whisky-cache valkey-cli INFO stats  | grep evicted_keys

# Sessions live on the other instance and must show no evictions at all.
docker exec whisky-valkey valkey-cli INFO stats | grep evicted_keys
```

Keys read as `cache:report:g<generation>:<kind>:<day|->:<hash>`. Entries of an older generation than the counter states are simply unaddressed and expire on their own — seeing them is normal, not a leak.

---

## 3. Reading the heartbeat

Every `WATCHDOG_INTERVAL_MS` (10 s) the app logs one line ending in the cache's own segment:

```
... valkey 2 ms, cache 120h/8m/0e/0b gen 1789092974 ping 1 ms
```

- **`120h/8m/0e/0b`** — hits / misses / errors / bypasses, cumulative since boot. Read two consecutive lines and subtract, the way the pool numbers beside them are already read.
- **`errors` climbing** — the cache is failing commands and every one of them was served from the database instead. The request path is fine and slower.
- **`ping NO ANSWER`** — the cache instance is unreachable. Requests still answer, from the database. **Sessions are unaffected**, which is most of the point of the split.
- **`cache off`** — `CACHE_ENABLED` is false.
- **`cache DIRTY ...`** — see §4. This one deserves attention.

---

## 4. What `DIRTY` means, and how to clear it

A write to the catalogue committed and the cache could not be told. Entries stored before that write may now be stale with nothing to supersede them, so the cache **bypasses itself entirely** — every request goes to the database — until a bump succeeds. Every request retries the bump, so a transient outage clears on its own within one request of the instance coming back.

If it does not clear, the instance is still unreachable: fix that, and the next request clears the flag. Forcing it by hand is never necessary, but either of these does it:

```bash
docker compose restart service                  # boot bumps
docker exec whisky-cache valkey-cli INCR cache:gen:catalogue
```

The second is safe for the same reason the whole design is: a higher generation can only ever cause a recomputation, never a stale answer.

---

## 5. Turning it off

```
CACHE_ENABLED=false
```

and `docker compose up -d service`. Every read goes to the database and every bump is a no-op — exactly the behaviour that predates the cache. The connection is still opened; the switch stops commands, not the socket.

---

## 6. Things that are **not** steps

- **No warm-up.** The first request of each shape pays for itself and the rest are served from it.
- **No cache flush on deploy.** The application bumps the generation at every boot, which supersedes anything the migrations, the knowledge-base boot pass, or a script run while it was down may have changed.
- **No flush after a script.** The six writing scripts bump the generation themselves when they finish. A dry run deliberately does not.
- **No coordination with the browser cache.** `Cache-Control: private, max-age=600` governs the client alone; the two lifetimes are unrelated and never have to agree.
