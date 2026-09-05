# API unreachable during the daily sync — handoff

**Status: UNRESOLVED.** The site becomes unreachable shortly after the daily
sync starts and recovers on its own about an hour later. It has happened every
day since 2026-08-30.

This document contains measurements only. Hypotheses, predictions and
suggested directions have been deliberately removed: the previous
investigation produced seven of them and every single one was wrong, so they
are worth nothing to the next reader and would only re-seed the same bias.
Written in English per the project's documentation rule.

---

## 0. The key question, which was never answered

> **How can a synchronisation running inside the container affect packet
> delivery on the host?**

The previous investigation localised the failure to the host's packet path
(§F6, §F7) but never produced a mechanism connecting that to the sync — even
though the failure occurs only while the sync runs, and never otherwise.

**This question was asked by the user and never answered.** Despite that, the
investigation kept directing attention outside the container. Treat that as an
unresolved contradiction, not as a conclusion.

## 0.1 Known bias of this investigation — read before trusting anything below

- **Code-side causes were dismissed rather than measured.** Database load from
  the knowledge-base pass, connection-pool behaviour, and other effects of the
  `feat/knowledge-base` release were declared "ruled out" on the basis of
  heartbeat samples and log line counts. **The database was never inspected
  during an outage** (see §G).
- **Every hypothesis that placed the cause outside the container failed:** CPU
  starvation, conntrack exhaustion, accept-queue overflow, a stale DNAT rule,
  overlapping docker subnets, stale ARP, host firewall rules, veth drops. Each
  was disproved by measurement.
- **One hypothesis placed the cause in the application** (a Valkey session
  lookup hanging inside `AuthJwtGuard`). Acting on it, a 49-file change was
  written and deployed as `v1.1.1`. It did not fix the outage, which recurred
  unchanged on 2026-09-02 and 2026-09-03.
- The user reported from the first day that the problem began with a specific
  release. That clue was set aside repeatedly and only examined on 2026-09-03.

---

## S. Symptoms, as measured

The shape of the failure, taken from a probe running every 5 s from outside
(public HTTPS) and every 10 s from the host during the 2026-09-03 reproduction.

**1. The site is completely healthy for the first ~11 minutes after the sync
starts.** No ramp, no degradation, no rising latency. Sync started 15:00:00;
external probes through 15:11:50 returned `401` from `/api/meta` with
`time_connect` 0.036–0.045 s and `time_starttransfer` 0.114–0.131 s — the same
figures as before the sync. Host-side probes over the same period: 1–3 ms.

**2. It then dies between two consecutive probes, in under 6 seconds.**

```
15:11:50  401  connect=0.040  ttfb=0.125
15:11:56  000  connect=0.037  ttfb=0.000
```

**3. From that moment the failure is stable and total, and it is specific to
the API.** Everything nginx serves itself keeps working; only responses from
the API never arrive. Measured at 16:03:09 UTC — **63 minutes after the sync
started, 51 minutes after the onset, and 35 minutes after the sync itself had
finished** — production was still down:

```
/api/meta   code=000  connect=0.079  ttfb=0.000
/           code=200                 ttfb=0.126
```

Note `connect` versus `ttfb` in every one of these: **the TCP connection is
always established normally; the response never begins.** That distinction
holds at every layer measured — from the internet, from the host to the
published port, and from the host to the container address.

**4. The sync itself completes normally while the site is down.** On
2026-08-30 the sync finished at 09:27:40 (27 m 41 s, 22 stores, all
successful) while the outage ran from 09:10:07 to 10:18:05.

**5. Recovery is spontaneous, and takes roughly an hour from onset.** On
2026-08-30 the first request was served again at 10:18:05, **68 minutes** after
the last one at 09:10:06, with no restart (`RestartCount=0`) and no human
action. On 2026-09-03 the site was measured down at 16:03:09 and up again at
16:12:48, so it recovered **51–61 minutes** after the 15:11:56 onset — again
with no restart and no intervention, and long after the sync itself had
finished.

**6. Onset is consistently ~10–11 minutes after the sync starts**: 09:10:07
against a 09:00 start on 2026-08-30, and 15:11:56 against a 15:00 start on
2026-09-03.

## F1. Timeline

| When (UTC)                     | Event                                                                                                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-30 08:02               | `v1.1.0` merged                                                                                                                                                 |
| 2026-08-30 08:08               | `v1.1.0` deployed (`StartedAt=2026-08-30T08:08:37Z`)                                                                                                            |
| 2026-08-30 09:00–09:27         | scheduled sync: 27 m 41 s, 22 stores, 12 tracks, 4 in parallel                                                                                                  |
| 2026-08-30 09:10:07 → 10:18:05 | outage, 68 min. Last served request 09:10:06.738, next 10:18:05.491                                                                                             |
| 2026-09-02 ~09:00              | outage (reported by user)                                                                                                                                       |
| 2026-09-03 ~09:00              | outage (reported by user)                                                                                                                                       |
| 2026-09-03 15:00               | sync rescheduled to 18:00 Europe/Kyiv to observe it live                                                                                                        |
| 2026-09-03 15:11:50            | last healthy external probe (`401`, connect 40 ms, ttfb 125 ms)                                                                                                 |
| 2026-09-03 15:11:56            | outage begins: `code 000`, `time_connect=0.037`, `time_starttransfer=0`                                                                                         |
| 2026-09-03 15:45               | still down                                                                                                                                                      |
| 2026-09-03 16:03:09            | still down, verified externally: `/api/meta` `code=000 connect=0.079 ttfb=0.000`, `/` `200` in 126 ms — 63 min after the sync started, 35 min after it finished |
| 2026-09-03 16:12:48            | recovered on its own, verified externally: `/api/meta` `401` in 158 ms. No restart, no intervention                                                             |

The outage starts ~11 minutes after the sync starts and outlives the end of the
sync by ~50 minutes.

## F2. Versions

| Tag      | Commit                                                | Date       | On production                                  |
| -------- | ----------------------------------------------------- | ---------- | ---------------------------------------------- |
| `v1.0.0` | `af73efe`                                             | 2026-08-27 | last version with no reported outage           |
| `v1.1.0` | `11b965e` (merge of `368ca88`, `feat/knowledge-base`) | 2026-08-30 | **first version after which outages began**    |
| `v1.1.1` | `2fe9584`                                             | 2026-08-30 | timeouts + watchdog; outage recurred unchanged |
| `v1.1.2` | `d861665`                                             | 2026-09-01 | current; outage persists                       |

## F3. Contents of the `v1.0.0..v1.1.0` diff

```
git diff v1.0.0..v1.1.0 --stat -- src/scrape src/domain/store package.json
```

- `package.json`: no dependency added, changed or removed — new npm scripts only.
- No change to the HTTP client, the Playwright/browser layer, socket handling,
  connection pooling or concurrency limits.
- `src/scrape/adapters/scrape-adapter.base.ts`: +7 lines (one object field).
- The remainder is knowledge-base logic, LLM passes and Postgres writes:
  `kb-apply` (+306), `kb-resolver` (+423), `kb-reconcile` (+169),
  `kb-boot-apply` (+75), `llm-research` (+284), `scrape-persist` (+267).
- `scrape-persist.service.ts` now calls `applyKb()` **inside each store's
  `@Transactional()` persist**.
- `KbBootApplyService` runs a full catalogue reconcile at every boot
  (`KB_APPLY_ON_BOOT`, default true).

## F4. Application-side measurements during the outage

Source: the heartbeat added in `v1.1.1` (`src/lib/watchdog`), one line per 10 s.

- `grep heartbeat | cut -c1-13 | uniq -c` → **360 lines per hour, every hour**,
  2026-09-02 08:00 through 2026-09-03 14:00, including both outage windows. No
  gaps (`awk '$1<6'` on per-minute counts returns only boundary rounding).
- 8 WARN heartbeats in 30 hours.
- Sample from inside the window:

```
[09:30:09] heartbeat: loop lag 0.2/2.1 ms (mean/max), rss 270 MB, heap 102 MB,
handles 5, db pool 0 open/0 idle/0 waiting, valkey 1 ms
```

- Later in the same outage: `rss 595 MB`, `handles 11–14`, `db pool 0–1 open`,
  `0 waiting`, `valkey 0–1 ms`, container limit 2048 MB.
- For the whole 09:00 UTC hour on 2026-09-03: `incoming req data` = **0**,
  `processing time` = **0**, `Request timed out` = **0**. The heartbeat (same
  `debug` level) was being written throughout, so log level does not explain
  the zeros.
- `docker inspect`: `RestartCount=0`, `OOMKilled=false`.
- 2026-08-30, inside the container: `ListenOverflows 0`, `ListenDrops 0`,
  `SyncookiesSent 0`, `TCPBacklogDrop 0`; `Recv-Q 0` on `0.0.0.0:4000`; 34 open
  file descriptors of a 1 048 576 limit.

## F5. Reachability during the outage (2026-09-03, 15:12–15:45)

| From             | To                                          | Result                                          |
| ---------------- | ------------------------------------------- | ----------------------------------------------- |
| inside container | `127.0.0.1:4000`                            | `OK 401`, instant                               |
| inside container | `172.26.0.2:4000` (own bridge address)      | `OK`, 2 ms                                      |
| host             | `172.26.0.2:4000`                           | timeout, `time_connect=0.000000`                |
| host             | `192.168.179.2:9977` (published port)       | timeout, `time_connect=0.000000`                |
| internet         | `https://whisky.vlm.com.ua/api/meta`        | TCP connect 37 ms, then no response; curl `000` |
| internet         | `https://whisky.vlm.com.ua/` (nginx static) | `200` in 111 ms                                 |
| host             | `172.26.0.3:4000` (probe container, §F8)    | `200`                                           |

Inside the container at the same moment: **10 sockets in `SYN_RECV`**,
2 `CLOSE_WAIT`, 16 `ESTABLISHED`, 44 `TIME_WAIT`.

## F6. Packet capture

`tcpdump` on the bridge and on the veth, while the host curls the container:

```
sudo timeout 12 tcpdump -ni br-d3f300009036 -c 20 tcp port 4000
```

```
15:31:34.522089  172.26.0.1.57078 > 172.26.0.2.4000: Flags [S]
15:31:34.522133  172.26.0.2.4000 > 172.26.0.1.57078: Flags [S.]
15:31:35.527819  172.26.0.1.57078 > 172.26.0.2.4000: Flags [S]
15:31:35.527871  172.26.0.2.4000 > 172.26.0.1.57078: Flags [S.]
15:31:36.551839  172.26.0.1.57078 > 172.26.0.2.4000: Flags [S]
15:31:36.551910  172.26.0.2.4000 > 172.26.0.1.57078: Flags [S.]
...
```

- The container answers the SYN in **43 microseconds**.
- The SYN-ACK is present on both `vethb834c85` and `br-d3f300009036`.
- The host retransmits the same SYN 6–8 times.
- No `RST` appears in either capture.
- `0 packets dropped by kernel` in both captures.
- The captures were taken **without** `-e`, so the MAC headers of these frames
  were never examined.

## F7. Host-side counters during the same failing connection

- `iptables -L INPUT -nv --line-numbers`, diffed around one failing `curl`:
  only `f2b-sshd` and the `internet` chain move, both fed by unrelated `eth0`
  scan traffic. No rule matches the container's packets.
- `iptables -t mangle -L -nv`, same diff: no change.
- `netstat -s`, same diff: `TCPSynRetrans +6`, `TcpTimeoutRehash +6` (the
  host's own retransmits) and generic totals. **No PAWS, checksum, martian,
  invalid or drop counter of any kind changed.**
- `dmesg`: `INPUT DROP` entries exist but all have `IN=eth0` (internet
  scanners). None from `172.26.0.2`, none with `SPT=4000`.
- `ip -s link show vethb834c85`: `errors 0`, `dropped 0` in both directions,
  while packet counters keep increasing (50 085 → 50 926 RX over 4 minutes).
- `ip neigh`: `172.26.0.2 dev br-d3f300009036 lladdr da:d4:87:57:77:10
  REACHABLE`. The same MAC appears as the source in the kernel's own log lines
  for that container's traffic.
- `/proc/sys/net/netfilter/nf_conntrack_count`: 210–870 during the sync,
  494–555 during the outage. `nf_conntrack_max` = 65536.
- `ss -s` on the host: `TCP: 100 (estab 10, closed 67, orphaned 0, timewait 14)`.
- Kernel log, 15:11:33 and 15:11:49 (inside the outage): the container is
  sending traffic outward normally —
  `IN=br-d3f300009036 OUT=eth0 PHYSIN=vethb834c85 SRC=172.26.0.2 DST=157.240.0.6`.

## F8. Probe container

Created 2026-09-03 15:38, same image, same docker network, **no published
port**, no workload:

```
docker run -d --name probe --network whisky-be --entrypoint node whisky-be \
  -e 'require("http").createServer((q,s)=>s.end("ok")).listen(4000)'
```

At 15:45, with production still down:

```
curl http://172.26.0.3:4000/    -> 200
curl http://172.26.0.2:4000/    -> timeout
```

## F9. nginx

- All `upstream timed out` entries for this incident read **`while reading
  response header from upstream`**, never `while connecting to upstream`.
  Example: `upstream: "http://192.168.179.2:9977/store"`.
- `docker logs nginx-proxy` shows none of this: the container writes to files
  (`/var/log/nginx/{access,error}.log`), not stdout.
- Those files have not been rotated since March 2023: `access.log` 1.25 GB,
  `error.log` 877 MB. `grep` on them needs `-a`.

## F10. docker-proxy state during the outage

```
root 1426335 0.0 0.1 1745432 5420 ? Sl 14:58 0:00 /usr/bin/docker-proxy
  -proto tcp -host-ip 192.168.179.2 -host-port 9977
  -container-ip 172.26.0.2 -container-port 4000 -use-listen-fd
```

`sudo ss -tanp | grep 9977` at the same moment:

```
LISTEN     0    4096  192.168.179.2:9977   0.0.0.0:*         docker-proxy pid=1426335
ESTAB      615  0     192.168.179.2:9977 <- 172.18.0.2:38270 docker-proxy pid=1426335
CLOSE-WAIT 764  0     192.168.179.2:9977 <- 172.18.0.2:60368 docker-proxy pid=1426335
CLOSE-WAIT 616  0     192.168.179.2:9977 <- 172.18.0.2:43144 docker-proxy pid=1426335
SYN-SENT   0    1     192.168.179.2:40746 -> 192.168.179.2:9977  curl pid=1456939
```

- `172.18.0.2` is the `nginx-proxy` container.
- 615–764 bytes of request data are queued unread on those sockets.
- `Recv-Q 0` on the LISTEN socket; backlog 4096.

## F11. Environment

- Host `backup` (Hetzner), 3 vCPU, 3.8 GB RAM, ~1.1 GB in swap, `wa` ≈ 0 %
  averaged over 6 days of uptime. `poste.io` was consuming ~2 of the 3 cores
  until it was stopped on 2026-08-30; the outage recurred after that unchanged.
- `whisky-be`: published `192.168.179.2:9977 → 4000`, memory limit 2048 MB,
  `stop_grace_period 60s`, three networks — `whisky-be 172.26.0.2`,
  `whisky_db 172.23.0.3`, `whisky_valkey 172.19.0.3`.
- Bridge `br-d3f300009036` = `172.26.0.1`, MAC `92:fd:e1:3b:e5:e1`; veth
  `vethb834c85`; container MAC `da:d4:87:57:77:10`.
- `iptables`: `INPUT` policy DROP with a LOG rule; `FORWARD` policy DROP;
  `DOCKER-USER` is a whitelist ending in `LOG` + `DROP`; port 4000 is
  whitelisted for `ctstate NEW`. The `FORWARD` chain contains **two
  generations of Docker rules side by side**: the `DOCKER-FORWARD` chain and
  legacy per-bridge `-o br-… -j DOCKER` rules.
- nat: `-A DOCKER -d 192.168.179.2/32 ! -i br-d3f300009036 -p tcp --dport 9977
  -j DNAT --to-destination 172.26.0.2:4000` — target matches the live
  container address.
- Sync: `0 9 * * *` UTC (`SYNC_TIMEZONE=Europe/Kyiv`), 22 stores in 12 tracks,
  `SYNC_MAX_PARALLEL_TRACKS=4`, ~28 minutes, one track drives Chromium
  (`rozetka`).
- `tcpdump` was installed on the host during the investigation.
  `conntrack-tools` is **not** installed; `/proc/net/stat/nf_conntrack` does
  not exist on this kernel.

## F12. What `v1.1.1` added

Timeouts for Valkey (`commandTimeout`, keep-alive, no offline queue),
PostgreSQL (`connectionTimeoutMillis`, `statement_timeout`,
`idle_in_transaction_session_timeout`, socket keep-alive), a 30 s request
budget (`TimeoutInterceptor`), a 45 s in-flight socket deadline
(`RequestDeadlineMiddleware`), the heartbeat (`src/lib/watchdog`) and step
tracing on the auth path. Documented in `CLAUDE.md`, section "Resilience and
observability". **The outage recurred unchanged after it was deployed.** The
measurements in §F4 come from it.

---

## F13. Per-store sync timings against the onset (2026-09-03)

From `GET /store` (`lastSuccessfulSyncAt`), sorted, taken after the run:

```
15:00:48  bayadera
15:01:09  alcohub
15:01:32  fozzy
15:01:52  auchan
15:02:50  megamarket
15:03:09  metro
15:03:54  novus
15:04:47  ultramarket
15:06:09  winetime
15:06:19  ekomarket
15:06:50  epicentr
15:07:54  zaraz
15:08:31  cosmos
15:10:32  goodwine      <- last store of chunk 1
15:11:57  maudau        <- OUTAGE ONSET at 15:11:56
15:12:00  wine-point
15:12:44  okwine
15:22:44  rozetka       <- the only browser/Chromium store
15:23:00  silpo
15:24:28  winebutik
15:26:02  winewine
15:26:15  alcomag
```

The orchestrator runs 12 tracks in chunks of `SYNC_MAX_PARALLEL_TRACKS=4`:

- chunk 1 — `zakaz` (11 stores, sequential), `bayadera`, `fozzy`, `goodwine`;
  ends when the slowest of them finishes, **15:10:32**;
- chunk 2 — `maudau`, `wine-point`, `okwine`, **`rozetka`** (starts 15:10:32);
- chunk 3 — `winewine`, `alcomag`, `winebutik`, `silpo` (starts 15:22:44).

**On both observed days the outage begins within the first ~90 seconds of
chunk 2 — the chunk that contains `rozetka`, the only store that launches
Chromium.**

- 2026-08-30, from the application log: `Sync finished for goodwine` at
  09:10:07.020, then `Sync started for maudau/wine-point/okwine/rozetka` at
  09:10:07.042–09:10:07.113. The last request the API ever served that morning
  was logged at **09:10:06.738** — 0.3 s before chunk 2 started.
- 2026-09-03: chunk 2 started at 15:10:32; onset **15:11:56**, 84 s later.

The outage does **not** end when the browser track ends: `rozetka` finished at
15:22:44 and the site recovered between 16:03:09 and 16:12:48, some 40–50
minutes later. Chunk 3 ran entirely inside the outage without changing
anything.

This is a correlation across two occurrences, recorded as an observation. No
test has been run to establish whether the browser tier is causal — see §G.

---

## G. What was never measured

These gaps are listed because they are the reason the key question in §0
remains unanswered.

- **`pg_stat_activity` was never captured during an outage.** Backend states,
  wait events, lock waits, longest-running query — none of it is known for any
  outage window.
- **The database's load profile under the knowledge-base pass was never
  measured**: how long `applyKb()` holds its transaction per store, how many
  statements it issues, what it locks, or how any of that differs from
  `v1.0.0`.
- **Sync duration and resource profile before `v1.1.0` were never compared**
  with those after it.
- **It was never tested whether the outage occurs without the sync** (cron
  disabled), or with a reduced sync (one store, `SYNC_MAX_PARALLEL_TRACKS=1`,
  or with `KB_APPLY_ON_BOOT=false`).
- **It was never tested whether the outage occurs without the browser tier**,
  which §F13 shows is running when the onset happens on both observed days.
  `rozetka` is the only store with `needsBrowser=true`; deactivating it for one
  run, or running it alone, would settle whether Chromium is involved. This is
  the cheapest untried experiment and it does not touch the host.
- **It was never tested whether a container with a published port but no
  workload is affected.** The probe in §F8 has no published port, so it does
  not isolate workload from port publishing.
- MAC headers of the SYN-ACK frames were never captured (`tcpdump -e`).
- `rp_filter` settings and the presence of a parallel `nft` ruleset were never
  checked.
- Whether anything changed on the host itself around 2026-08-30 08:00 UTC
  (docker daemon upgrade, firewall reload, kernel update) was never checked.

## H. Artifacts left behind

- Container `probe` is running (idle Node from the `whisky-be` image, no
  published port). Remove with `docker rm -f probe`.
- `tcpdump` was installed on the host.
- The sync cron may still be set to 18:00 Europe/Kyiv rather than 09:00 UTC.

---

## F14. Local measurements, 2026-09-05

Added after the user isolated the trigger (§F13's untried experiment): on
2026-09-04 `rozetka` was deactivated for the scheduled run, then re-activated
and synced **alone** as a manual run at 13:57:02 UTC (`store.updatedAt`
13:56:56, `sync_log` 13:57:02–14:08:21, no other store running). The site went
down. On 2026-09-05 the scheduled run (13:30:28–13:42:20 UTC) took the site
down again: **HTTP 403 for ~4 hours**, `sudo systemctl restart docker` did not
restore it, `sudo shutdown -r now` did. Whatever holds the block therefore
lives on the host, outside Docker's own state, and outlives the container.

Everything below was measured on the dev machine against the live store, with
the production browser setup (Playwright 1.62.0, Chromium 151 headless, the
same launch arguments, UA, locale, viewport and stealth script as
`browser-context.factory.ts`). Scripts and raw captures are in the session
scratchpad (`rozetka-probe.cjs`, `rozetka-probe-hardened.cjs`,
`probe-out/*.requests.json`).

### What one Rozetka listing page makes Chromium do

Per page, fresh context, no request filtering — as production ran it:

| Measure                                                                     | Value                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Requests                                                                    | 359–364                                                                                                                                                                                                                                         |
| Distinct hosts                                                              | 16 (13 distinct remote IPs)                                                                                                                                                                                                                     |
| Requests to `*.rozetka.com.ua`                                              | ~343 (271 to `xl-static`, ~50 to the three `content*` image hosts)                                                                                                                                                                              |
| Third-party hosts                                                           | `www.clarity.ms`, `scripts.clarity.ms`, `c.clarity.ms`, `f.clarity.ms`/`l.`/`o.`/`e.` (Microsoft), `o4511387512274944.ingest.de.sentry.io` (34.160.81.0, Google Cloud), `accounts.google.com` (142.251.127.84), `static.cloudflareinsights.com` |
| **HTTP/3 (QUIC over UDP 443)**                                              | 8–9 requests per page, to `api-analytics.rozetka.com.ua` = 35.241.36.79 (Google Cloud)                                                                                                                                                          |
| **UDP sockets open after the page** (`lsof -nP -i UDP`, Chromium processes) | `->34.160.81.0:443`, `->35.241.36.79:443` (×2), `->142.251.127.84:443` — every page, all Google addresses                                                                                                                                       |

With request interception on, the page was additionally seen _asking_ for
`connect.facebook.net`, `www.google.com` (×4), `www.google-analytics.com`,
`www.googletagmanager.com`, `ad.doubleclick.net`, `static.criteo.net`,
`tags.creativecdn.com`, `analytics.tiktok.com`, `cc.cloudad.icu`, `c.rzk-m.com`
— requests the first capture never saw complete.

Two consequences for the earlier sections:

- **§F7's kernel log line was misread.** `IN=br-d3f300009036 OUT=eth0
  PHYSIN=vethb834c85 SRC=172.26.0.2 DST=157.240.0.6` at 15:11:33 was cited as
  "the container is sending traffic outward normally". 157.240.0.0/16 is
  Facebook's range; that packet is Chromium fetching `connect.facebook.net`
  for a Rozetka page, and a packet that appears in the kernel log **matched a
  LOG rule** — per §F11 the only LOG rules are `INPUT`'s and the `LOG` + `DROP`
  tail of the `DOCKER-USER` whitelist. So during the `rozetka` track the host
  is writing firewall log lines with `SRC=172.26.0.2`, one per blocked packet,
  and the browser tier is the only store that produces packets the whitelist
  has to think about: UDP 443 flows to Google addresses on every page, plus a
  dozen third-party hosts. The 21 HTTP stores open TCP 443 to one host each.
- **The timing fits.** Onset 84 s into chunk 2 (§F13) is roughly the fourth
  or fifth listing page — a few pages' worth of dropped UDP/third-party
  packets accumulating in a log.

None of this proves what turns the log lines into a block of `172.26.0.2`;
that lives on the host and has to be read there (§G2 below). It does establish
that `rozetka`'s sync is the only workload of this service whose network
behaviour a host firewall would log, and that a block on the container's
address reproduces every symptom in §S/§F5–F10 exactly: SYN-ACKs from the
container refused before `INPUT`'s LOG rule, no RST, no counter the previous
investigation looked at, container→internet still forwarded, probe container
unaffected, docker-proxy queuing nginx's bytes, recovery when the ban
expires (1 h, later 4 h — the escalation shape of `bantime.increment` in
fail2ban and the 4 h default of CrowdSec), and a restart of Docker changing
nothing because the container comes back on the same address.

### Hardened run, same pages

`--disable-quic` added to the launch arguments, and a `context.route()` that
lets through only `*.rozetka.com.ua` and `challenges.cloudflare.com` and drops
images/media/fonts (now `browser-request.policy.ts`):

| Measure                          | Value                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| Requests reaching the network    | ~305, all to `*.rozetka.com.ua`                                                    |
| Requests aborted                 | 72–128 per page (the CDN images plus every third-party host above)                 |
| HTTP/3                           | 0                                                                                  |
| UDP sockets                      | 0                                                                                  |
| Tiles extracted, pages 1/7/41/42 | 60 / 60 / 10 / 60 (page 42 redirected to page 1) — identical to the unfiltered run |

Cloudflare did not challenge any request on 2026-09-05, so the challenge
clearing behind the allowlist is not yet observed live; `challenges.cloudflare.com`
and the same-origin `/cdn-cgi/` paths are allowed by construction.

### A second, unrelated change at Rozetka (2026-09-04)

Every `rozetka` run since 2026-09-04 13:57 UTC ends `Listing incomplete
(ambiguous)` and skips the out-of-stock sweep (2026-09-03 15:10 UTC was the
last run that swept; `store_product.inStock` for the store has been frozen
since). Cause, verified live: the listing now states «Знайдено 2410 товарів»,
its sold-out tail renders tiles **with an empty price slot**, and the tail has
grown so that page 41 exists and holds ten such tiles. The extractor dropped
price-less tiles, so page 41 read as an empty page — the Cloudflare-challenge
signature — and the run as incomplete. Fixed in the adapter (price-less tiles
count as seen, the stated figure is reconciled by `listing()`, page 42 still
redirects to page 1 and ends the walk). This has nothing to do with the
outage; it is noted because the two started within a day of each other and
could be mistaken for one thing.

## G2. What to read on the host

In this order, ideally while the block is active (run `rozetka` manually and
wait for the onset) — none of it changes anything:

1. **Is the container address blocked, and by which chain.**
   `sudo iptables -S | grep -n 172.26.0.2`;
   `sudo iptables -L INPUT -nv --line-numbers | head -40` (any chain jumped
   to _before_ the LOG rule — `f2b-*`, `crowdsec-*`, `internet`, …);
   `sudo nft list ruleset | grep -n -B3 -A3 172.26.0.2`;
   `sudo ipset list 2>/dev/null | grep -n -B8 172.26.0.2`.
2. **Which ban tool is installed.**
   `systemctl list-units --type=service --all | grep -Ei 'fail2ban|crowdsec|bouncer|ufw|shorewall|firewalld|psad|sshguard|denyhosts'`;
   `sudo fail2ban-client status` then `sudo fail2ban-client status <jail>` per
   jail; `sudo grep -a 'Ban ' /var/log/fail2ban.log | tail -50` (look for
   `172.26.0.2` and for the times in §F1); `sudo cscli decisions list -a`;
   `sudo cscli alerts list`.
3. **What the firewall logged from the container during the sync** —
   `sudo journalctl -k --since '2026-09-05 13:30' --until '2026-09-05 13:45' | grep -c 'SRC=172.26.0.2'` and
   `... | grep 'SRC=172.26.0.2' | grep -oE 'DST=[0-9.]+ .*PROTO=[A-Z]+ .*DPT=[0-9]+' | sed -E 's/ (LEN|TOS|PREC|TTL|ID|SPT)=[^ ]*//g' | sort | uniq -c | sort -rn | head -30`
   (expected: `PROTO=UDP … DPT=443` to Google addresses, and third-party TCP
   if the whitelist is by destination).
4. **The whitelist itself.** `sudo iptables -L DOCKER-USER -nv --line-numbers`
   — whether UDP 443 from the containers is allowed at all.
5. **Who answered 403.** `sudo grep -a ' 403 ' /var/log/nginx/access.log | tail -30`;
   `sudo grep -a -Ei 'forbidden|denied|access forbidden by rule|limiting' /var/log/nginx/error.log | tail -30`;
   `sudo nginx -T 2>/dev/null | grep -n -Ei 'deny|allow |satisfy|return 403|error_page 403|limit_req|limit_conn|include .*(fail2ban|crowdsec|bouncer|block|ban)'`.
   The API itself can only answer 403 to an authenticated user lacking a
   permission (`PermissionGuard`) or to a login of a deactivated account, so
   a 403 seen by an anonymous request is nginx's or a bouncer's: check whether
   the body is NestJS's `{"statusCode":403,"message":"Forbidden resource"}` or
   an nginx/CrowdSec page.

If a ban tool is found, the container networks (`172.16.0.0/12`) belong in its
ignore list (`ignoreip` in fail2ban's `jail.local`, `cscli allowlists` in
CrowdSec) regardless of the code fix — the fix removes the trigger, the ignore
list removes the failure mode.
