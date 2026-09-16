# Logs — search and analysis, with VictoriaLogs beside the existing Grafana

Prometheus, Grafana, Alertmanager, node-exporter, cAdvisor and the three
exporters are deployed and working (`docs/MONITORING-PLAN.md`, `infra/README.md`).
Logs are the one observability gap left, and §11 of that plan recorded it as a
decision rather than an omission:

> **Log aggregation.** Loki beside Grafana is the obvious pairing and the
> per-sync log files under `./log` are the obvious first source. Out of scope,
> and noted so it is a decision rather than an omission.

This document revisits that line and picks differently, on evidence. It is the
same shape as the monitoring plan: what is added, why each choice was made, and
what is deliberately left out.

## 0. Decisions taken before writing this

- **Log search is the goal, not log-based alerting.** Alerting on logs is a
  natural next step and is deliberately out of scope — §11 says why.
- **VictoriaLogs, not Loki.** §2 is the whole argument.
- **Vector as the collector**, not the lighter `vlagent` or Fluent Bit. §4.3
  is the reason: one of the three sources needs real parsing logic.
- **Three sources**: container stdout, the nginx files, and the per-sync scrape
  logs under `./log`. The monitoring stack's own containers are excluded.
- **The application's log format flips to JSON.** `docker-compose.yaml` pins
  `LOG_JSON=false` today, so production emits `pino-pretty` single-line output
  **with ANSI colour codes** — the worst possible input for a log pipeline.
- **It lives in the monitoring compose project**, not the application's. The
  reasoning is unchanged from `infra/README.md`: a broken collector config must
  never be able to abort `scripts/deploy.sh`.

## 1. What is added, in one paragraph

Two containers join the existing `whisky-monitoring` compose project:
**VictoriaLogs**, a single Go binary that stores and queries logs, and
**Vector**, which collects them from three places and pushes them in. Grafana
gains a second datasource and a fifth dashboard; Prometheus gains one scrape
job, because VictoriaLogs publishes its own metrics and nothing this stack runs
should be unwatched. On the application side two things change and neither is in
`src/`: the log format becomes JSON, and every service finally gets a `logging:`
block with rotation — an outstanding item in three documents already.

## 2. Why VictoriaLogs and not Loki

Loki was the assumption. The research behind reversing it was deliberately
weighted towards people running these systems rather than towards vendor
comparisons.

### What operators actually say about Loki

The positives are real and should not be waved away: it is simple to stand up,
its ingest is genuinely cheap, LogQL is a decent language, and it is native in
Grafana with no plugin to install. _"Loki offers 90% of the features with an OSS
model and very simple deployment"_ is a fair summary.

The complaints are structural rather than skill issues:

- **The cardinality trap.** Every unique label-value combination is a separate
  stream with its own chunk files. Operators report `chunks/` directories with
  tens of thousands of files of ~512 bytes, degraded query performance and
  outright ingest failures. One high-cardinality label — a request id, a client
  IP, a trace id — is enough to cause it.
- **LogQL cannot search without a stream selector.** `{labels}` is mandatory,
  so "find this string anywhere" is not expressible. It also cannot compute
  several statistics in one query.
- _"Notoriously difficult to know why ingestion of certain logs failed."_
- Grafana's own log view renders JSON and logfmt poorly; some operators wrote
  their own CLI rather than use it.
- Measured on 4 vCPU / 8 GiB against 500 GB over seven days: **6–7 GiB RAM
  steady, CPU pinned at the limit, and a full-scan query for a string that is
  not present timed out entirely.** The same workload on VictoriaLogs used
  0.6–2 GiB and answered in 2.2 s.

### What changed in 2026, and this is the part that decides it

- **Promtail is gone.** Deprecated in Loki 3.0, end-of-life 2026-03-02, and
  **removed outright in 3.7.3**. A new Loki deployment must run Grafana Alloy,
  an OpenTelemetry Collector distribution — 66 MiB and 0.578 cores at
  10k logs/s, against 28 MiB and 0.062 cores for the lightest alternative.
- **Bloom filters**, the flagship feature of 3.0, are still experimental and
  have already had their components rebuilt once (the bloom compactor was
  removed and replaced by a planner and a builder), with the feature's purpose
  repivoted from free-text search to structured metadata.
- **The Helm chart moved to a community-maintained repository** in March 2026.
- Loki 3.7 shipped four breaking changes.

That is a lot of churn to absorb for a stack whose entire value here is being
boring and staying up.

### What operators say about VictoriaLogs

Negative operator reports were searched for specifically and none were found.
What there is:

- _"Deployed VictoriaMetrics almost 5 years ago and have had zero regrets…
  later my coworker deployed VictoriaLogs in about 15 minutes. Night and day
  compared to Elastic."_
- _"I use it in docker on a NAS — VictoriaMetrics, VictoriaLogs, Grafana. Low
  resource usage, fast, so far zero issues."_
- _"Switched to VictoriaLogs. It is much better and faster than Loki."_

Apache 2.0, one binary, a `/metrics` endpoint of its own, LogsQL, a built-in web
UI, and a signed datasource in the official Grafana catalog.

### Why it fits this host in particular

- **The cores are already committed.** Eight of them carry three Node replicas,
  Postgres, two Valkeys, HAProxy and eight monitoring containers — and
  `docs/LOAD-TEST-2026-09.md` records the database pool being _cut_ 50 → 24
  because 48 backends was six times the core count and the database then did
  **more** work, not less. A collector that wants 0.578 cores where another
  wants 0.062 is not a rounding error on this box.
- **One disk carries everything**: `pg_data`, the session Valkey's AOF, the
  bind-mounted `./log`, and the Prometheus TSDB, with an 85 %-full alert as the
  only guard. `-retention.maxDiskSpaceUsageBytes` maps exactly onto the
  `PROM_RETENTION` / `PROM_RETENTION_SIZE` pair that already exists in
  `infra/.env` for the same reason.

### The hedge, stated plainly

**VictoriaLogs ingests the Loki push protocol.** If it disappoints, the
collector configuration does not change — only the sink URL does. Choosing it
is therefore close to reversible, which is not true in the other direction: a
Loki deployment's labels, its LogQL dashboards and its Alloy configuration do
not carry across.

### The honest costs of this choice

- **LogsQL is a second query language**, and a less widely known one. Answers
  to odd questions are easier to find for LogQL.
- **The datasource is a plugin** where Loki needs none — §6.1 and §6.2 are two
  real traps that follow from exactly that.
- **The standalone repository has ~2.3k stars against Loki's ~28.9k.** The code
  is older than that number suggests (it lived in the VictoriaMetrics monorepo
  until July 2025), but the ecosystem around it is genuinely smaller.
- **The benchmarks quoted above are vendor benchmarks** where VictoriaMetrics
  published them, and were read as such. The operator reports are not.

## 3. Layout

```
infra/
├── docker-compose.monitoring.yaml     + victorialogs, + vector
├── vector/vector.yaml                 NEW  the three sources, the transforms, the sink
├── grafana/provisioning/datasources/
│   ├── prometheus.yml                 (unchanged)
│   └── victorialogs.yml               NEW
├── grafana/dashboards/whisky-logs.json  NEW
├── prometheus/prometheus.yml          + the victorialogs scrape job
├── .env.example                       + a Logs section
└── README.md                          + the operator section
docker-compose.yaml                     LOG_JSON=true; `logging:` blocks
docs/LOGS-PLAN.md                       this file
docs/MONITORING-PLAN.md                 §9 and §11 no longer say "no log aggregation"
ROLLBACK.md                             + §0.3
CLAUDE.md                               + the log pipeline under "Logging"
```

Images are pinned, as everything else here is:

- **`victoriametrics/victoria-logs:v1.52.0`** — note **no `-victorialogs`
  suffix**. That suffix was the tag convention while the code lived in the
  VictoriaMetrics monorepo; the repository split in July 2025 and the tags are
  clean `v1.52.0` now. Every older tutorial still shows the suffix, and such a
  tag does not exist.
- **`timberio/vector:0.58.0-debian`** — debian rather than alpine or
  distroless, because this container reads bind-mounted host files and a shell
  is worth having the first time a permission question comes up.

## 4. The three sources

### 4.1 The sink, and one line that has to be right

Vector's **`elasticsearch` sink** against
`http://whisky-vlogs:9428/insert/elasticsearch/`, `api_version: v8`,
`compression: gzip`, and **`healthcheck: enabled: false`**. That last one is
not a preference: Vector's Elasticsearch health probe requests an endpoint
VictoriaLogs does not implement, so leaving it enabled makes the sink refuse to
start. This is the path VictoriaMetrics documents for Vector; the `http` sink
against `/insert/jsonline` is the documented alternative and buys nothing here.

### 4.2 `_stream_fields` — the cardinality decision

This is the one thing in this document that must not be got wrong, because it
is the same trap Loki is being avoided for. VictoriaLogs tolerates high
cardinality far better than Loki does, which is a reason to be careful rather
than a licence to be careless.

```
_stream_fields=source,container_name,store
```

Three fields, all drawn from closed sets:

| Field            | Values                                           | Cardinality |
| ---------------- | ------------------------------------------------ | ----------- |
| `source`         | `docker`, `nginx`, `sync`                        | 3           |
| `container_name` | the Docker API's name for a collected container  | ~7          |
| `store`          | a store slug, or `full-run`; set for `sync` only | ~20         |

Everything else — request ids, client addresses, URLs, SKUs, levels, the
message itself — stays an ordinary field. Ordinary fields are fully searchable
in LogsQL; they simply do not multiply streams. `_msg_field` and `_time_field`
are set per source.

The expected total is tens of streams. §8 gives the command that checks it, and
a four-figure answer means a high-cardinality field reached this list.

### 4.3 Why Vector rather than vlagent or Fluent Bit

Measured at 10k logs/s: vlagent 28 MiB / 0.062 cores, Fluent Bit 78 MiB /
0.260, Vector 154 MiB / 0.412. On resource grounds vlagent wins outright, and
on this host that argument has teeth.

It is overruled by source 4.6, and by more than first appeared. Those files
carry **the date only in their filename**, so the collector has to read a
field out of the file path, parse a clock-only timestamp and combine the two —
and a failure additionally writes a multi-line stack trace whose frames carry
no clock at all, so they have to be folded into the line above them before any
of that runs. Vector does the first in a few lines of VRL and the second
declaratively; vlagent does no custom format parsing at all, and Fluent Bit's
Lua would make it an awkward script. Paying ~120 MiB on a 16 GB host to keep
that logic readable is the right trade — and if the per-sync files ever leave
scope, vlagent becomes the obvious swap.

**The cost of the Docker source, stated**: `docker_logs` keeps no read offset
(`vectordotdev/vector#7358`), so it resumes from the moment Vector starts
rather than from where it stopped. A Vector restart therefore loses whatever
the containers printed while it was down. What makes that acceptable is the
`logging:` block in §5: those json files are still on disk for `docker logs`
across the gap. The two file sources do checkpoint, in a named volume.

### 4.4 Container stdout

Vector's **`docker_logs` source**, not a `file` source over
`/var/lib/docker/containers/*/*-json.log`. The file path carries only container
ids, so the labels would be useless without consulting the Docker API anyway,
and then two mechanisms are in play instead of one.

It needs `/var/run/docker.sock:ro`. That is established precedent in this
project rather than a new exposure: cAdvisor already has it, with a comment
justifying it on the grounds that it is read-only, terminates no public traffic
and publishes nothing — the distinction from the Traefik case the socket was
refused for (`docs/MULTI-PROCESS-PLAN.md`).

Scope: `whisky-be-*`, `whisky-lb`, `whisky-db`, `whisky-valkey`, `whisky-cache`.

Once `LOG_JSON=true` the API replicas emit pino JSON — `level` as a string
name, `time` as an ISO timestamp, plus `context` and `msg`. A VRL transform
parses it, lifts `msg` to the message and `time` to the timestamp, and **falls
back to the raw line when parsing fails** rather than dropping the event. That
fallback is what keeps a replica that has not been redeployed yet, a Postgres
startup line and a HAProxy failure line arriving as plain text instead of
vanishing silently — which is the failure mode operators complain about most in
Loki, and it would be self-inflicted here.

### 4.5 nginx

A `file` source over the host side of the **`nginx-proxy` container's** log
mount, `:ro` into Vector. nginx is a container here, not a host service
(confirmed by the owner, 2026-09-16) — so this is a bind mount of a path both
containers see, and Vector needs no access to the host's service manager.

That confirmation settled a contradiction this repository carried:
`infra/README.md` described a host service reloaded with `systemctl` while
only `docs/OUTAGE-2026-08-30-HANDOFF.md` named the container. That file is now
corrected to the container form.

**It writes files rather than stdout, which is why this source is a file tail
— and that has a corollary.** A config test failing on reload, or a container
that cannot start at all, appears on stdout and in **none** of these files. So
`nginx-proxy` is in the Docker source's include list as well, arriving as
`source:docker` with `container_name:nginx-proxy` while its request traffic
arrives as `source:nginx`. Two different questions — one about the process,
one about the traffic — and deliberately two answers.

Two branches in VRL: the `combined` access log parsed into status, method,
path, bytes, referrer and user agent; `error.log` parsed loosely and otherwise
kept whole, because its format varies by module.

**The first start must not ingest three years of history.** These files have
not been rotated since March 2023 — 1.25 GB and 877 MB as of
`docs/OUTAGE-2026-08-30-HANDOFF.md`, which is why its runbook needs `grep -a`.
So `read_from: end` and a bounded `ignore_older_secs`. This is deliberate: the
old content stays on disk and stays greppable, while back-filling it would
spend hours of CPU and a large share of the disk ceiling on data nobody is
going to query by label.

### 4.6 The per-sync scrape logs

A `file` source over `/app/log/*.log` — the same `./log` the application
writes, mounted `:ro` rather than read-write, since Vector must never be able
to disturb the files the retention sweep and `GET /store/:slug/sync-log/:id/file`
depend on.

The format is `HH:MM:SS LEVEL message`, `LEVEL` padded to seven characters, and
**the date exists only in the filename**:
`<YYYY-MM-DD>_<HH-MM-SS>_<slug>.log`. So VRL:

1. reads `YYYY-MM-DD` and the slug out of the `file` field; the slug becomes
   the `store` stream field, with `full-run` as a value of its own;
2. parses `HH:MM:SS LEVEL message` and combines the filename's date with the
   line's clock into the timestamp;
3. **on no match, keeps the line and ships it as-is.** Failure stack traces are
   multi-line and are precisely what somebody will search for; dropping
   unparseable lines would discard the most valuable content in the file.

**The glob is the date prefix, and `*.log` was a bug** — found on the first
production run rather than in review. That directory is not only sync runs:
`scripts/db-backup.sh` appends to `db_backup.log` beside them, and a checkout
also carries a stray `gen-verify-inputs.ts`. The looser glob handed this
source 155 backup lines, which the filename regex then correctly refused — so
they arrived as `source:sync` with **no `store`**, and, worse, stamped with
Vector's read time although every one of them carries its own ISO timestamp.
The stream listing is what surfaced it: a stream missing a field it should
have is as much a signal as one carrying a field it should not.

`db_backup.log` now has a source of its own (`source:backup`, its timestamp
parsed from the line) rather than merely being excluded — a backup that has
quietly stopped is exactly the thing worth being able to ask about, and the
file was already in hand. Two `tests:` cases pin both halves.

Two mechanics: the files are `chmod 777` and written by uid 10001 while
Vector's container runs as root, so reading them is fine; and Vector's
checkpoint directory must be a **named volume**, or every restart re-reads
every file inside the `ignore_older_secs` window and duplicates it.

## 5. What the application changes

Neither change is in `src/`.

**`LOG_JSON=true`.** This reverses a pinned decision — the current comment
states that the four `LOG_*` lines are "this deployment's settled answers" — so
it gets a comment saying why. Production currently runs `pino-pretty` with
`singleLine: true` and `colorize: true`, which means every line carries ANSI
escape codes and no structure: a pipeline would have to strip the colour and
regex the line back apart, and the fields would break on any `pino-pretty`
change. The cost is that `docker compose logs be` stops being pleasant to read
directly, and the mitigation belongs in the comment:
`docker compose logs be | npx pino-pretty`.

**`logging:` blocks with `max-size` / `max-file`.** The `json-file` driver runs
with no rotation at all today, on the disk that also holds `pg_data` — an
outstanding item in `docs/LOAD-TEST-HANDOFF-2026-09-13.md`,
`docs/LOAD-TEST-2026-09.md` and `docs/LOAD-TEST-PLAN.md`. It becomes a
prerequisite here rather than a nice-to-have, because this change is the one
that makes the container logs worth keeping.

## 6. Prerequisites and traps

1. **The Grafana plugin download was a firewall question, and the answer is
   yes**: the Grafana container reaches `grafana.com` (owner, 2026-09-16), so
   the shipped download path works and the offline fallback is documentation
   rather than a step. The reasoning below is kept because it is the right
   procedure on a host that has not been asked, and because a whitelist can
   change under you. `DOCKER-USER` here is a whitelist ending in `LOG` +
   `DROP`, and every dropped packet writes a kernel line `psad` reads as a
   port scan — the mechanism that took the API down for one to four hours a
   day between 2026-08-30 and 09-05. Worse than a missing panel, because the
   install blocks startup and **retries**. The offline fallback, where it is
   needed: fetch the plugin zip on the host, verify its checksum, unpack it
   and bind it read-only over `/var/lib/grafana/plugins/<id>` — **and set
   `GRAFANA_PLUGINS_PREINSTALL` to the empty string in the same breath**,
   because the two are mutually exclusive. Installing a plugin is a write, so
   a read-only bind at the directory the preinstall targets fails the boot
   with `mkdir …: read-only file system`. That is not hypothetical: it is how
   this shipped on 2026-09-16 and what the next commit fixed. The plugin is
   signed on either path, so no unsigned-plugin allowance is needed.
   `infra/README.md` has the procedure.
2. **`GF_PLUGINS_PREINSTALL_SYNC`, not `GF_INSTALL_PLUGINS` — and not the
   asynchronous form either.** `GF_INSTALL_PLUGINS` was deprecated in Grafana
   **12.1.0** and this deployment runs **12.1.1**; it still works, but it warns
   and carries a known bug where a newer plugin version is not upgraded unless
   the installed one is removed by hand. The `_SYNC` suffix is a correctness
   requirement rather than a preference: **datasource provisioning runs during
   startup**, so the asynchronous form races it and loses — Grafana finishes
   provisioning before the plugin exists, the datasource never registers, and
   every query answers `datasource not found` until somebody restarts the
   container. Plugin id `victoriametrics-logs-datasource`; requires Grafana
   ≥ 10.4.0.
3. **Retention is two ceilings, not one**, mirroring Prometheus exactly:
   `-retentionPeriod` (30 days, matching `SYNC_LOG_RETENTION_DAYS`) **and**
   `-retention.maxDiskSpaceUsageBytes`, so one noisy day cannot fill the disk
   the database is on before the time limit would have trimmed it.
4. **Nothing this stack runs should be unwatched** — the standing rule in
   `infra/README.md`. VictoriaLogs publishes `/metrics`, so it gets a scrape
   job in the same change rather than being the one component nobody measures.
5. **The image tag has no `-victorialogs` suffix** (§3), and the sink's
   healthcheck must be disabled (§4.1). Both are the kind of thing that costs
   twenty minutes and looks like a broken deployment.

## 7. Grafana

One provisioned datasource (`victorialogs.yml`, `editable: false`, matching
`prometheus.yml`) and one dashboard (`whisky-logs.json`, in the existing
`Whisky` folder under `allowUiUpdates: false`). Dashboards here are provisioned
from files so that none exists only inside somebody's browser and every change
is a diff.

Most of the value is in **Explore** rather than in the dashboard — a log search
is an ad-hoc act — so the dashboard stays small and answers the questions that
are worth a glance: volume by source and container, the API's error rate by
replica, nginx status-code classes, and the most recent sync failures.

## 8. Verification

**Both `vector validate` and `vector test` are gates, and they catch
different things.** `validate` does compile the VRL — run against the first
draft of this file it rejected three real type errors (a dead error-coalesce,
a `parse_nginx_log` format argument that must be a literal rather than a
variable, and an unhandled fallible `from_unix_timestamp`). What it cannot
judge is whether a program that compiles produces the _right_ fields, and that
is the failure mode this pipeline actually has. The `tests:` block at the foot of
that file runs the real transforms against real sample lines — nine cases,
including the sync-log date-from-filename join and the midnight crossing,
which is the only thing in this pipeline that can produce a
plausible-looking _wrong_ answer rather than an obviously missing one:

```bash
docker run --rm -v "$PWD/infra/vector:/etc/vector:ro" \
  timberio/vector:0.58.0-debian validate --no-environment /etc/vector/vector.yaml
docker run --rm -v "$PWD/infra/vector:/etc/vector:ro" \
  timberio/vector:0.58.0-debian test /etc/vector/vector.yaml
```

Each source is arriving, named rather than assumed:

```bash
for s in docker nginx sync; do
  echo -n "$s: "
  curl -s 'http://192.168.180.1:9428/select/logsql/query' \
    --data-urlencode "query=source:$s" --data-urlencode 'limit=1' | wc -l
done
```

The cardinality decision held — the number that says whether §4.2 worked:

```bash
curl -s 'http://192.168.180.1:9428/select/logsql/streams' \
  --data-urlencode 'query=*' --data-urlencode 'limit=10000' | jq '.values | length'
```

Tens, not thousands. A four-figure answer means a high-cardinality field
reached `_stream_fields`.

The Prometheus counterpart is `vl_streams_created_total`, and it has a nuance
worth knowing before reading it as an alarm: **VictoriaLogs registers every
stream again in each new daily partition**, so `increase(...[1d])` legitimately
equals the stream count once a day and is _not_ expected to be flat at zero.
What is a bug is a spike inside a day.

The JSON flip produced fields rather than text:

```bash
curl -s 'http://192.168.180.1:9428/select/logsql/query' \
  --data-urlencode 'query=container_name:~"whisky-be" AND level:error' \
  --data-urlencode 'limit=5'
```

The date-from-filename logic is right — a sync line's timestamp must be its
filename's day, not today:

```bash
curl -s 'http://192.168.180.1:9428/select/logsql/query' \
  --data-urlencode 'query=source:sync AND store:silpo' --data-urlencode 'limit=3'
```

And the question this whole change exists to answer — edge failures the API's
own metrics structurally cannot see, which is what 2026-08-30 was:

```bash
curl -s 'http://192.168.180.1:9428/select/logsql/query' \
  --data-urlencode 'query=source:nginx AND status:>=500' --data-urlencode 'limit=20'
```

Then the footprint and the ceilings:

```bash
docker exec whisky-vlogs wget -qO- http://127.0.0.1:9428/metrics \
  | grep -E '^vl_(data_size_bytes|rows_ingested_total|rows_dropped_total|storage_is_read_only|free_disk_space_bytes)'
docker stats --no-stream whisky-vlogs whisky-vector
```

`vl_rows_dropped_total` is the one to read first, because it is the **silent**
failure: a line outside the retention period is dropped at ingestion and the
insert is still answered `HTTP 200` with an empty body, so nothing else in
this stack would ever mention it. `too_small_timestamp` means older than the
retention period, `too_big_timestamp` means dated in the future — a clock or
timezone mistake. Every metric name in the dashboard was checked against
VictoriaLogs' and Vector's own published metric lists rather than taken from
an example, which is the same discipline `infra/README.md` states for the
application's own metrics.

Finally that nothing regressed: the API's own `/metrics`, the four existing
dashboards, and `docker compose logs be` still showing something a person can
act on.

## 9. Cost, honestly

- **On the host**: two containers. VictoriaLogs is the only one holding state;
  thirty days of this fleet's logs is single-digit gigabytes compressed, and
  bounded by the disk ceiling either way. Vector is ~150 MiB of RAM and a
  fraction of a core. Both get memory limits — which makes them the first two
  containers in this compose project that have any, an inconsistency worth
  stating rather than hiding.
- **On the application**: `LOG_JSON=true` removes a `pino-pretty` transport
  from the logging path, so it is marginally cheaper rather than dearer.
  Nothing in `src/` changes, so there are no new log call sites and the
  `LOG_REDACT_PATHS` rule has nothing new to check — the rule still stands for
  anything added later, and now matters more, because a redaction miss is
  retained for thirty days and searchable instead of scrolling past.
- **On the operator**: no third compose invocation. The two services join the
  existing monitoring project, so the host is still two commands.

## 10. Checkpoints

Executed one at a time, each with its own gate, reported before the next
begins.

| # | Step                                                                                                                                                                                                                                                                                                                                                                                 | Gate                                                                                                                                                                        | Status   |
| - | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 0 | This plan                                                                                                                                                                                                                                                                                                                                                                            | reviewed                                                                                                                                                                    | **done** |
| 1 | **Host pre-flight** — both questions answered by the owner, 2026-09-16: the Grafana container **does** reach `grafana.com`, so the shipped plugin path works and the offline fallback stays documentation; and nginx is the **`nginx-proxy` container**, which corrected a stale `systemctl` instruction in `infra/README.md` and added that container's stdout to the Docker source | answered; `NGINX_LOG_DIR` still wants one `docker inspect` on the host to pin the log mount's host side                                                                     | **done** |
| 2 | `docker-compose.yaml`: a `logging:` anchor on all six services, `LOG_JSON=true` with its comment                                                                                                                                                                                                                                                                                     | `dprint` clean; then on the host `docker compose config -q`, and after deploy `docker logs whisky-be-1 --tail 1 \| jq .level` prints a string                               | **done** |
| 3 | `victorialogs` service, both retention ceilings, memory limit, and its Prometheus scrape job                                                                                                                                                                                                                                                                                         | `dprint` clean; then `promtool check config`, the container up, the target reading `up`                                                                                     | **done** |
| 4 | `vector` service, `infra/vector/vector.yaml`, all three sources, and its own scrape job                                                                                                                                                                                                                                                                                              | `dprint` clean and nine `tests:` cases written; then **`vector test`** on the host — see §8, this is the gate `vector validate` cannot be                                   | **done** |
| 5 | Grafana datasource, the `GF_PLUGINS_PREINSTALL_SYNC` install with its offline fallback, and `whisky-logs.json`                                                                                                                                                                                                                                                                       | valid JSON, no grid overlap, and every metric name checked against VictoriaLogs' and Vector's published lists; then the datasource tests green and every panel returns data | **done** |
| 6 | Docs: `infra/README.md` (operator section, the two Vector checks, the nginx discrepancy, Cost), `infra/.env.example`, `CLAUDE.md`, `ROLLBACK.md` §0.3, `docs/MONITORING-PLAN.md` §9/§11                                                                                                                                                                                              | every compose variable documented; no document still claims there is no log aggregation                                                                                     | **done** |

**Steps 2–6 are verified locally, not merely written.** The development
machine runs podman, so every gate below was actually executed here:

| Gate                                                                                | Result                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vector validate`                                                                   | clean — after it rejected **three** real type errors in the first draft                                                                                                                                                                                                   |
| `vector test`                                                                       | **9/9 passing, zero warnings**, including the date-from-filename join and the midnight crossing                                                                                                                                                                           |
| `promtool check config`                                                             | clean; 3 rule files, 29 rules                                                                                                                                                                                                                                             |
| `promtool check rules` over the dashboard's PromQL                                  | 12/12 expressions parse                                                                                                                                                                                                                                                   |
| `docker compose config` on both projects                                            | both parse; `LOG_JSON: true` and a `logging:` block on all six services resolve                                                                                                                                                                                           |
| A live VictoriaLogs v1.52.0, fed through the sink's own endpoint and `VL-*` headers | 6 rows in, 0 dropped; **5 streams** of exactly the intended shape; all three dashboard queries return; `reqId`, a client IP, a status range and a free-text substring all still filter as ordinary fields; a malformed query is refused `400` rather than answering empty |

What remains is genuinely host-only: the real containers, the real log files,
and the two questions in step 1 — which is the owner's and comes first.

## 11. What is deliberately not here

- **Log-based alerting (`vmalert`).** It is the natural pairing, it would reach
  the Alertmanager and Telegram receiver that already exist, and there is a
  genuinely valuable rule waiting — nginx 5xx and 429s at the edge, which the
  API's own metrics structurally cannot see, as 2026-08-30 proved. It is left
  out to keep this change to what was asked, and because the rule is worth
  writing against a week of real data rather than on spec. Recorded here so it
  is a decision rather than an omission.
- **Pointing nginx at stdout.** `access_log /dev/stdout` would let the
  `docker_logs` source collect it for free and would fix the unrotated files at
  the root. Rejected because the incident runbook in
  `docs/OUTAGE-2026-08-30-HANDOFF.md` is built on
  `sudo grep -a /var/log/nginx/access.log`, and an observability change should
  not remove the tool people reach for when observability itself is what is
  broken.
- **The monitoring stack's own container logs.** Low value, and a collector
  that ships its own output is a feedback loop worth not having.
- **Rotating or back-filling the existing ~2 GB of nginx history.** Rotation
  belongs to whoever owns the `nginx-proxy` container; back-filling would spend
  the disk ceiling on data nobody will query by label. §4.5.
- **Tracing.** Unchanged from `docs/MONITORING-PLAN.md` §11 — the request path
  is short and the interesting latency is already attributable. Still its own
  project.
