#!/usr/bin/env bash
# Samples what the API's dependencies are doing while k6 runs — from the load
# generator, over the VPN, so no shell on the host is needed: Postgres
# activity and both Valkey instances, one TSV line per INTERVAL seconds.
# Counters (xact_commit, blks_*, keyspace_*) are cumulative; difference two
# lines to get a rate. Stop it with Ctrl-C or kill.
#
#   ENV_FILE=.env.loadtest loadtest/observe.sh loadtest/out/<run>/observer.tsv
#
# ENV_FILE     dotenv file with DB_* and VALKEY_* (default .env.loadtest)
# INTERVAL     seconds between samples (default 5)
# MAX_SAMPLES  stop after this many lines; 0 runs until killed (default 0)
# CACHE_VALKEY_HOST / CACHE_VALKEY_PORT  the cache instance (default: the
#              session host, port 10380)
set -euo pipefail

OUT=${1:?usage: observe.sh <out.tsv>}
ENV_FILE=${ENV_FILE:-.env.loadtest}
INTERVAL=${INTERVAL:-5}
MAX_SAMPLES=${MAX_SAMPLES:-0}

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

export PGPASSWORD="$DB_PASS"
CACHE_HOST=${CACHE_VALKEY_HOST:-$VALKEY_HOST}
CACHE_PORT=${CACHE_VALKEY_PORT:-10380}
CACHE_PASSWORD=${CACHE_VALKEY_PASSWORD:-}

PG_SQL="select
  count(*) filter (where state = 'active'),
  count(*) filter (where state = 'idle'),
  count(*) filter (where state like 'idle in transaction%'),
  count(*) filter (where state = 'active' and wait_event_type is not null),
  count(*),
  (select xact_commit from pg_stat_database where datname = current_database()),
  (select blks_read from pg_stat_database where datname = current_database()),
  (select blks_hit from pg_stat_database where datname = current_database())
from pg_stat_activity
where datname = current_database() and backend_type = 'client backend'"

# One Postgres sample; eight tab-separated fields, blank on failure.
sample_pg() {
  psql -X -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
    -At -F $'\t' -c "$PG_SQL" 2>/dev/null || printf '\t\t\t\t\t\t\t'
}

# One Valkey sample: hits, misses, ops/s, used memory, clients, keys in db0.
sample_valkey() {
  local host=$1 port=$2 password=$3
  local auth=()

  if [ -n "$password" ]; then
    auth=(-a "$password" --no-auth-warning)
  fi

  redis-cli -h "$host" -p "$port" ${auth[@]+"${auth[@]}"} INFO 2>/dev/null \
    | tr -d '\r' \
    | awk -F: '
      /^keyspace_hits:/ { h = $2 }
      /^keyspace_misses:/ { m = $2 }
      /^instantaneous_ops_per_sec:/ { o = $2 }
      /^used_memory:/ { u = $2 }
      /^connected_clients:/ { c = $2 }
      /^db0:/ { split($2, a, ","); sub("keys=", "", a[1]); k = a[1] }
      END { printf "%s\t%s\t%s\t%s\t%s\t%s", h, m, o, u, c, k }'
}

mkdir -p "$(dirname "$OUT")"

printf '%s\n' "$(IFS=$'\t'; echo "ts	pg_active	pg_idle	pg_idle_tx	pg_waiting	pg_conns	pg_xact_commit	pg_blks_read	pg_blks_hit	cache_hits	cache_misses	cache_ops	cache_used_mem	cache_clients	cache_keys	sess_hits	sess_misses	sess_ops	sess_used_mem	sess_clients	sess_keys")" >> "$OUT"

count=0

while true; do
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  pg=$(sample_pg)
  cache=$(sample_valkey "$CACHE_HOST" "$CACHE_PORT" "$CACHE_PASSWORD")
  sess=$(sample_valkey "$VALKEY_HOST" "$VALKEY_PORT" "${VALKEY_PASSWORD:-}")

  printf '%s\t%s\t%s\t%s\n' "$ts" "$pg" "$cache" "$sess" >> "$OUT"

  count=$((count + 1))

  if [ "$MAX_SAMPLES" -gt 0 ] && [ "$count" -ge "$MAX_SAMPLES" ]; then
    break
  fi

  sleep "$INTERVAL"
done
