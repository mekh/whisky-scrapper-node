# `infra/` — the edge and the monitoring

Everything that describes how this deployment is reached and how it is
watched. Two edge configs the host applies by hand, and one compose project
that runs the monitoring stack.

```
infra/
├── haproxy/haproxy.cfg          mounted by ../docker-compose.yaml (the `lb` service)
├── nginx/nginx.conf             the host nginx server block; copied to the host by hand
├── docker-compose.monitoring.yaml
├── prometheus/                  scrape config + alert rules
├── alertmanager/                routing, and the Telegram receiver
├── postgres-exporter/           the extra queries the exporter runs
└── grafana/                     provisioned datasource and dashboards
```

## The two edge configs

**`haproxy/haproxy.cfg`** is mounted read-only by the application's compose
file; it needs no separate deploy. It is a **balancer config and stays one** —
routing policy belongs to nginx, which already owns that job, and a rule here
would be a second, divergent copy of it sitting next to the
`X-Forwarded-For` contract that nothing may disturb.

**`nginx/nginx.conf`** is a template. Nothing applies it automatically:

```bash
sudo cp infra/nginx/nginx.conf /etc/nginx/conf.d/whisky-web.conf
# …adjust root / server_name / proxy_pass / TLS…
sudo nginx -t && sudo systemctl reload nginx
```

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

Eight containers, of which Prometheus is the only heavy one: 15 days of
retention at these intervals is a few hundred megabytes, on the same disk as
`pg_data` — which is why disk usage is itself alerted, and why
`PROM_RETENTION_SIZE` is a second ceiling in case a cardinality mistake
outruns the time-based one.

On the application side the cost is two hook callbacks and one histogram
observation per request, against the ~8.5 ms of CPU a cached report page
already spends.
