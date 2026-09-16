# `infra/` — the edge and the monitoring

Everything that describes how this deployment is reached and how it is
watched. Two edge configs the host applies by hand, and one compose project
that runs the monitoring stack.

```
infra/
├── haproxy/haproxy.cfg          mounted by ../docker-compose.yaml (the `lb` service)
├── nginx/nginx.conf             the nginx server block; applied to the host by hand
├── docker-compose.monitoring.yaml
├── prometheus/                  scrape config + alert rules
├── alertmanager/                routing, and the Telegram receiver
├── postgres-exporter/           the extra queries the exporter runs
├── vector/vector.yaml           what the log collector reads, and how it parses it
└── grafana/                     provisioned datasources and dashboards
```

## The two edge configs

**`haproxy/haproxy.cfg`** is mounted read-only by the application's compose
file; it needs no separate deploy. It is a **balancer config and stays one** —
routing policy belongs to nginx, which already owns that job, and a rule here
would be a second, divergent copy of it sitting next to the
`X-Forwarded-For` contract that nothing may disturb.

**`nginx/nginx.conf`** is a template, and nothing applies it automatically.

**nginx here is a CONTAINER, `nginx-proxy`, not a host service** (confirmed by
the owner, 2026-09-16). Earlier revisions of this file said
`sudo cp … /etc/nginx/conf.d/` and `systemctl reload nginx`; that was wrong,
and it is the kind of stale instruction that costs an hour in the middle of an
incident. The shape of the work is the same — edit the template here, put it
where that container reads its config from, check it, reload — but every
command is the container form:

```bash
# Where it reads config and where it writes logs. Both are bind mounts, and
# this is the command that says what the host paths actually are:
docker inspect nginx-proxy --format '{{json .Mounts}}' | tr ',' '\n' | grep -iE 'conf|log'

# …then copy the template to the host side of its config mount, adjust
# root / server_name / proxy_pass / TLS, and:
docker exec nginx-proxy nginx -t && docker exec nginx-proxy nginx -s reload
```

**Two consequences for the log stack.** The container writes its access and
error logs to _files_, not to stdout — `docker logs nginx-proxy` shows none of
it (`docs/OUTAGE-2026-08-30-HANDOFF.md`) — which is why Vector tails files for
this source rather than collecting it over the Docker API like the others.
And `NGINX_LOG_DIR` in `infra/.env` must be the **host** side of that log
mount. `/var/log/nginx` is the default and is what the outage runbook's
`sudo grep -a … /var/log/nginx/access.log` implies, but the `docker inspect`
above is what confirms it.

It lives here rather than in `../web` because it is a deployment-topology
document, and the topology is here — the compose project, the private-interface
addresses, the replica count and HAProxy. Roughly half of it is about serving
the SPA, so a frontend-only edge change now lands in this repository; that is
the price of one place describing the edge.

**What it blocks, and why it matters now**: `/api/metrics`, `/api/health` and
`/api/health/ready` return 404. `/api/health/live` stays open — it discloses
nothing and is what an external uptime monitor can watch without a credential.

> **Apply it after the app is deployed, not before.** The block removes
> `/api/health` from the public internet and `/api/health/live` does not
> exist until this version of the API is running. If something outside is
> watching `/api/health` today, move it to `/api/health/live` first.

## Running the monitoring stack

It is a compose project of its own, so a broken exporter config can never
abort `scripts/deploy.sh` and looking at a dashboard never requires
redeploying the API.

```bash
cp infra/.env.example infra/.env     # fill in GRAFANA_ADMIN_PASSWORD and the DB credentials
docker compose -f infra/docker-compose.monitoring.yaml --env-file infra/.env up -d
docker compose -f infra/docker-compose.monitoring.yaml ps
```

The application stack must be up first: this project attaches to the networks
it creates (`whisky-be`, `whisky_db`, `whisky_valkey`) as external, so that
an exporter can never land on a network where its target does not exist and
report everything down.

| Service           | Container                                          | Reached at                 | What it is for                                              |
| ----------------- | -------------------------------------------------- | -------------------------- | ----------------------------------------------------------- |
| Grafana           | `whisky-grafana`                                   | `http://$MON_BIND_IP:3000` | The dashboards. Log in as `admin`                           |
| Prometheus        | `whisky-prom`                                      | `http://$MON_BIND_IP:9090` | Ad-hoc queries, and `/targets` when something reads as down |
| Alertmanager      | `whisky-alerts`                                    | `http://$MON_BIND_IP:9093` | What is firing and what is silenced                         |
| node-exporter     | `whisky-node-exporter`                             | host namespace, `:9100`    | The host's own CPU, memory, disk                            |
| cAdvisor          | `whisky-cadvisor`                                  | compose network only       | Per-container CPU and memory, by name                       |
| Postgres exporter | `whisky-exporter-pg`                               | compose network only       | Connections, commits, `pg_stat_statements`, table sizes     |
| Valkey exporters  | `whisky-exporter-session`, `whisky-exporter-cache` | compose network only       | One per instance, because they have opposite jobs           |

`MON_BIND_IP` is set in `infra/.env`; the published services are on that
address alone. Nothing is reachable from the internet and the host nginx has
no location for any of it.

**node-exporter is the one exception to "one address".** It runs in the host's
network namespace so that the interfaces it measures are the host's own, and
it therefore listens on `:9100` everywhere rather than on `MON_BIND_IP` —
Prometheus scrapes it through the bridge gateway (`host.docker.internal`,
mapped by an `extra_hosts` entry), which binding to one private address would
have excluded. What keeps that port off the internet is the host firewall, the
same `DOCKER-USER` whitelist that already guards Postgres and both Valkeys.
The earlier form bound it to `MON_BIND_IP` and hard-coded the same address as
the scrape target, which silently broke the moment that variable changed —
Prometheus expands no environment variables in its own config, so the two
could not be kept in step.

**That firewall needs a rule in `INPUT`, and `DOCKER-USER` is not where it
goes.** This is the one scrape that terminates _on the host_ rather than
crossing between containers: Prometheus addresses the bridge gateway, so the
packet arrives on the host's own `INPUT` chain, while `DOCKER-USER` is
consulted from `FORWARD` and never sees it. A whitelist written for the
container-to-container traffic therefore drops it, and the symptom is narrow
enough to be misread as a dashboard problem — every panel in the infra
dashboard's **Host** row reads `No data` while Postgres, Valkey and the
containers below it are fine, and `WhiskyDiskFilling`, `WhiskyHostSaturated`
and `WhiskyHostMemoryLow` are silent rather than firing. Allow the subnet of
every network Prometheus is attached to, since which one it sources from
depends on the container's default route:

```bash
for n in whisky_monitoring whisky-be; do
  docker network inspect "$n" -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}'
done
# then, for each, and persisted the way the rest of the whitelist is:
sudo iptables -I INPUT -p tcp -s <SUBNET> --dport 9100 -j ACCEPT
```

The target's own error says which half is wrong, and the three answers do not
overlap: `no such host` is `extra_hosts` never reaching the container,
`connection refused` is nothing listening on 9100, and `i/o timeout` is this
rule missing — a DROP times out where a REJECT would have refused.

### Turning on Telegram

The stack ships **delivering nowhere on purpose**: alerts fire and are visible
in Prometheus and Alertmanager, routed to the null receiver.

The chat id and the active receiver have to be written into the config file
itself, so a deployment edits a **git-ignored copy** rather than the tracked
file — which is what keeps `git pull` from meeting a modified config:

```bash
printf '%s' '<token from @BotFather>' > infra/alertmanager/telegram-token
cp infra/alertmanager/alertmanager.yml infra/alertmanager/alertmanager.local.yml
# In the copy: uncomment the `telegram` receiver, put the real chat id in it,
# and change `receiver:` on the route from 'null' to telegram.
echo 'ALERTMANAGER_CONFIG=./alertmanager/alertmanager.local.yml' >> infra/.env

docker run --rm --entrypoint /bin/amtool -v "$PWD/infra/alertmanager:/a:ro" \
  prom/alertmanager:v0.28.1 check-config /a/alertmanager.local.yml
docker compose -f infra/docker-compose.monitoring.yaml --env-file infra/.env \
  up -d alertmanager
```

The token file is read by Alertmanager **at notification time, not at config
load**, and the container runs as `nobody` — so a token written with a
restrictive umask passes `check-config`, starts cleanly and then delivers
nothing, saying so only in the container's log. `chmod 644` it.

`up -d`, not `restart`: a restart reuses the container, and with it the mount
it was created with. A relative path resolves against `infra/`; an absolute
path outside the repository works as well, and is the stronger answer if the
deployment would rather the file were not in the tree at all.
`*.local.yml`, `*.local.yaml` and `telegram-token` are all git-ignored.

**`receivers:` cannot be a file of its own.** Alertmanager has no include
directive — `templates:` covers message bodies, not configuration — and
expands no environment variables either, which is why the token is read from
a file (`bot_token_file`) and the chat id, which has no such form, is not.
What is configurable is the path of the whole config, hence the copy.

**The copy is a whole copy**, and that is its cost: a routing or inhibit rule
added to the tracked file does not reach a deployment until someone carries it
across. After a pull that touched it, `diff` the two.

The receiver is commented out rather than stubbed because Alertmanager
validates **every** receiver whatever the routing says — a zero chat id would
stop the container starting.

## Checking the configs before deploying

Every one of these runs without the stack up, and all four are part of what
was verified when this was built:

```bash
# alert rules and the scrape config
docker run --rm --entrypoint /bin/promtool -v "$PWD/infra/prometheus:/etc/prometheus:ro" \
  prom/prometheus:v3.6.0 check config /etc/prometheus/prometheus.yml

# alert routing (name the file that is actually mounted — see
# ALERTMANAGER_CONFIG in infra/.env)
docker run --rm --entrypoint /bin/amtool -v "$PWD/infra/alertmanager:/a:ro" \
  prom/alertmanager:v0.28.1 check-config /a/alertmanager.yml

# the balancer
docker run --rm -v "$PWD/infra/haproxy/haproxy.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro" \
  haproxy:3.2-alpine haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg

# the log collector. TWO commands, and both earn their place. `validate`
# compiles the VRL and does catch type errors — it rejected three in the
# first draft of this file. What it cannot judge is whether a program that
# compiles produces the RIGHT fields, so `test` runs the `tests:` block at
# the foot of vector.yaml against real sample lines — including the sync-log
# date-from-filename join and the midnight crossing, which are the only
# things in that file that can produce a plausible-looking WRONG answer
# rather than an obviously missing one.
docker run --rm -v "$PWD/infra/vector:/etc/vector:ro" \
  timberio/vector:0.58.0-debian validate --no-environment /etc/vector/vector.yaml
docker run --rm -v "$PWD/infra/vector:/etc/vector:ro" \
  timberio/vector:0.58.0-debian test /etc/vector/vector.yaml

# the edge (needs the limit_req zone declared in an http{} context)
sudo nginx -t
```

## The dashboards

Four, provisioned from `grafana/dashboards/*.json` and **not editable in the
browser**: an edit there would be reverted on the next restart, so the UI
refuses it and a change goes through git instead.

| Dashboard                 | Answers                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------- |
| `Whisky — API`            | Is it up and fast. Rate, latency, errors, the limiter, per route                      |
| `Whisky — Runtime`        | Which replica is struggling. Event loop, heap, GC, the pool, dependencies, HAProxy    |
| `Whisky — Infrastructure` | What the host is doing. CPU, memory, disk, per container, Postgres, both Valkeys      |
| `Whisky — Domain`         | Is the product working. Cache, per-store sync freshness, scrape outcomes, model spend |

They are generated rather than hand-written, and every PromQL expression in
them is checked by `promtool` against the metric names the application
declares in `src/constants/metrics.constants.ts` — so a typo cannot ship as a
silently empty panel.

## Logs

Two containers, added 2026-09-16: **VictoriaLogs** (`whisky-vlogs`) stores and
queries, **Vector** (`whisky-vector`) collects. Why this and not Loki is
argued in [`../docs/LOGS-PLAN.md`](../docs/LOGS-PLAN.md) §2; the short version
is that Loki removed Promtail outright in 3.7.3, its replacement wants ten
times the CPU of the alternatives on a host whose eight cores are already
oversubscribed, and its cardinality model is a foot-gun this deployment does
not need.

Three sources, and each one is read a different way:

| Source                                                           | How                                                                                                        | Stream field     |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------- |
| Container stdout — the replicas, HAProxy, Postgres, both Valkeys | the Docker API, over the socket cAdvisor already uses                                                      | `container_name` |
| nginx access and error logs                                      | the host side of the `nginx-proxy` container’s log mount, bind-mounted `:ro` — it writes files, not stdout | —                |
| The per-sync scrape logs under `../log`                          | bind-mounted `:ro`; the date is read out of the **filename**                                               | `store`          |

### Before the first deploy: the plugin download is a firewall question

**On this host the answer is already known — the Grafana container does reach
`grafana.com` (owner, 2026-09-16) — so the default download path in
`docker-compose.monitoring.yaml` works as shipped, and the offline fallback
below is documentation rather than a step.** The check is kept because it is
the right procedure on any host that has not been asked, and because a
whitelist can change under you.

**Where it has not been confirmed: do this before touching the compose file,
and do not "just try it and see".**

The log datasource is a Grafana _plugin_, fetched from `grafana.com` when the
container starts. `GF_ANALYTICS_CHECK_FOR_UPDATES` is already `false`, so that
is a destination this container has **never** reached — exactly the position
`bank.gov.ua` was in before the currency work
([`../docs/CURRENCY-RATES-PROD.md`](../docs/CURRENCY-RATES-PROD.md) §1).
`DOCKER-USER` here is a whitelist ending in `LOG` + `DROP`, and every dropped
packet writes a kernel line `psad` reads as a port scan — the mechanism that
took the API down for one to four hours a day between 2026-08-30 and 09-05.

It is worse than a missing panel, because the install **blocks startup and
retries**: a whitelist miss is a sustained stream of dropped packets rather
than one.

```bash
sudo iptables -L DOCKER-USER -nv --line-numbers
# Confirm outbound TCP 443 from the container subnets reaches arbitrary
# destinations. If the whitelist is by DESTINATION, stop here and take the
# offline path below.
```

If that says egress is open, one request — not a loop — confirms it:

```bash
docker compose -f infra/docker-compose.monitoring.yaml exec grafana \
  wget -q -T 15 -O /dev/null https://grafana.com/api/plugins/victoriametrics-logs-datasource \
  && echo reachable
```

A timeout is the tell, the same one this file documents for the node-exporter
scrape: `DROP` times out where a `REJECT` would refuse.

**The offline path**, which needs no egress from the container at all.

**It is mutually exclusive with the download above, and that is not a style
note.** Installing a plugin is a _write_, so a read-only bind at the directory
the preinstall targets fails the boot outright with `mkdir …: read-only file
system` — which is how this first shipped on 2026-09-16. So this path means
_both_ mounting the plugin _and_ emptying `GRAFANA_PLUGINS_PREINSTALL`, never
one without the other.

Use the **official release zip** — it carries the `MANIFEST.txt` that makes
the plugin signed, and a source build does not:

```bash
V=v0.32.0
cd infra/grafana/plugins
curl -fLO "https://github.com/VictoriaMetrics/victorialogs-datasource/releases/download/$V/victoriametrics-logs-datasource-$V.zip"
curl -fLO "https://github.com/VictoriaMetrics/victorialogs-datasource/releases/download/$V/victoriametrics-logs-datasource-${V}_checksums_zip.txt"
sha256sum -c "victoriametrics-logs-datasource-${V}_checksums_zip.txt"
unzip -q "victoriametrics-logs-datasource-$V.zip" && rm -f ./*.zip ./*_checksums_zip.txt
cd ../../..

# Uncomment the plugin bind in infra/docker-compose.monitoring.yaml (it is
# one commented line on the grafana service), then stop Grafana reaching for
# the network — with the bind in place, a non-empty value here is the
# read-only failure above rather than a wasted request:
echo 'GRAFANA_PLUGINS_PREINSTALL=' >> infra/.env

# `up -d`, never `restart`: a restart reuses the container and with it the
# mounts it was created with, so the new bind would not exist.
docker compose -f infra/docker-compose.monitoring.yaml --env-file infra/.env up -d grafana
```

`infra/grafana/plugins/` is git-ignored but for its `.gitkeep`. Either way
**VictoriaLogs serves its own log-explorer UI** on `VLOGS_BIND_PORT`, so a
plugin that cannot be installed is a degraded experience rather than no log
search at all.

### Checking it works

Substitute the address from `infra/.env`:

```bash
V=http://192.168.180.1:10428
```

All three sources are arriving, named rather than assumed:

```bash
for s in docker nginx sync; do
  printf '%-7s ' "$s"
  curl -s "$V/select/logsql/query" \
    --data-urlencode "query=_time:1h source:=$s | stats count() lines"
done
```

**The cardinality check — the number that says whether the trap Loki was
rejected for has actually been avoided:**

```bash
curl -s "$V/select/logsql/streams" \
  --data-urlencode 'query=*' --data 'start=24h' --data 'end=now' \
  | jq -r '.values[] | "\(.hits)\t\(.value)"' | sort -rn
```

Read it against three rules. **Tens of lines, not thousands** — about seven
containers, two nginx files and one per store slug. **No line contains an IP
address, a URL, a request id or a container id**; `grep -E
'[0-9]{1,3}(\.[0-9]{1,3}){3}|/api/'` over that output must come back empty.
And **every line has a meaningful hit count** — a stream with one hit is a
field that should never have been a stream field. The list lives in
`VL-Stream-Fields` in `vector/vector.yaml`, and adding anything per-request to
it is what turns this into the problem it was chosen to avoid.

Two counters nothing else surfaces:

```bash
curl -s "$V/metrics" | grep -E '^vl_rows_(ingested|dropped)_total|^vl_storage_is_read_only'
```

`vl_rows_dropped_total` is the **silent** failure. A line outside the
retention period is dropped at ingestion and the insert is still answered
`HTTP 200` with an empty body, so nothing else in this stack would ever
mention it — `too_small_timestamp` means older than `VLOGS_RETENTION`,
`too_big_timestamp` means dated in the future, which is a clock or timezone
mistake. `vl_storage_is_read_only` at `1` means VictoriaLogs has stopped
accepting writes to avoid filling the disk the database is on.

And the one the whole change exists for — edge failures the API's own metrics
structurally cannot see, because no handler ever ran:

```bash
curl -s "$V/select/logsql/query" \
  --data-urlencode 'query=_time:24h source:=nginx AND status:>=500 | limit 20'
```

### Two things to know when operating it

**Retention is two limits, and the disk one is not a wall.** `VLOGS_RETENTION`
drops lines by age; `VLOGS_RETENTION_SIZE` drops whole per-day partitions,
oldest first. The documented caveats are real: usage can exceed the ceiling
between two checks, at least the last two days are kept whatever it says, and
below roughly 20 % free disk VictoriaLogs turns itself read-only. So
`WhiskyDiskFilling` stays the real guard, exactly as it is for
`PROM_RETENTION_SIZE`.

**A Vector restart loses container lines for the length of the gap.** The
Docker API source keeps no read offset (`vectordotdev/vector#7358`), so it
resumes from the moment Vector starts rather than from where it left off. The
file sources do checkpoint, in the `vector_data` volume. What makes the gap
acceptable is the `logging:` block added to `../docker-compose.yaml` in the
same change: those json files are still on disk for `docker logs` across it.

## When something fires

**`WhiskyCacheDirty`** — a generation bump failed, so that replica trusts no
cached entry and serves every report from the database. Check the cache
instance; it clears itself as soon as a bump succeeds. The site is slow, not
wrong.

**`WhiskyStoreSyncStale`** — nothing has successfully synced that store in two
days, and it is still switched on. Its per-run log files under `./log` say
what happened; a shop changing its markup is the usual cause.

**`WhiskyListingIncomplete`** — a walk could not prove it reached the end of
the listing, so the out-of-stock sweep was skipped and that store's
availability is frozen. Correct behaviour, and invisible without this.

**`WhiskyRateLimiterFailingOpen`** — the limiter's store could not answer and
requests went through uncounted. The edge `limit_req` and the login ladder
still stand, but the per-account cap does not.

**`WhiskySessionStoreEvicting`** — critical. That instance is configured with
no eviction policy precisely so this cannot happen; an eviction here destroys
sessions and signs users out of every device.

**`WhiskyDbPoolExhausted`** — callers are queueing for a connection. Raising
the pool is usually the wrong answer here: cutting it from 50 to 24 once made
the database do _more_ work, because the backends were competing with
everything else for the same eight cores. See `docs/LOAD-TEST-2026-09.md`.

**`WhiskyEventLoopLagging`** — that replica is queueing rather than working.
This is the number the API's original ceiling was diagnosed by.

## Cost

Ten containers, of which two hold state. Prometheus keeps 15 days at these
intervals — a few hundred megabytes — and VictoriaLogs keeps 30 days of this
fleet's logs, which compresses to single-digit gigabytes. Both sit on the same
disk as `pg_data`, which is why disk usage is itself alerted and why each has
a size ceiling as well as a time one, in case a cardinality mistake outruns
the time-based limit.

Vector is ~150 MiB of RAM and a fraction of a core. It and VictoriaLogs are
the only two containers here with memory limits — an inconsistency worth
naming rather than hiding — and Vector alone has a CPU ceiling, because the
one thing it does that can peg a core is its first read of a large file, on a
host whose eight cores the load tests already named as the constraint.

On the application side the cost is two hook callbacks and one histogram
observation per request, against the ~8.5 ms of CPU a cached report page
already spends. Logging got marginally _cheaper_: `LOG_JSON=true` means pino
installs no `pino-pretty` transport at all.
