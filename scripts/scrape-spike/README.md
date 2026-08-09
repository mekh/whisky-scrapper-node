# Scrape spike (fingerprint canary)

Decision gate for moving the Python scraper (`../scrapper`) into this backend:
can Node reach every store, and with which client?

Three clients are compared per store, cheapest first:

| Client       | What it is                                                        |
| ------------ | ----------------------------------------------------------------- |
| `plain`      | Node's global `fetch` (undici) with a realistic Chrome header set |
| `impit`      | `impit` impersonating Chrome — real browser TLS/JA3 + HTTP/2      |
| `playwright` | Headless Chromium, stealth context, fresh context per page        |

The Python scraper uses `curl_cffi` with `impersonate="chrome"` for **every**
store, so "plain `fetch` is enough" is a hypothesis this spike has to prove,
not an assumption — see `../../../scrapper/whisky/adapters/base.py`.

## Why the IP matters

Cloudflare fingerprints the TLS handshake passively and answers differently
depending on the client's address: a residential IP can pass with plain
`fetch` while a datacenter IP gets a 403 for the same request. Production runs
on a datacenter host, so a residential-IP PASS proves only that the wiring
works.

Every run prints the public IP it used. Record it with the results.

- **Phase A (local, no VPN)** — wiring check. Not a verdict.
- **Phase B (VPN, datacenter IP)** — the real verdict.

## Usage

```bash
# full default matrix, quick pass (3 attempts x 2 pages per pair)
pnpm exec ts-node -r tsconfig-paths/register scripts/scrape-spike/run.ts

# one store, one client
pnpm exec ts-node -r tsconfig-paths/register scripts/scrape-spike/run.ts \
  --store goodwine --client impit --pages 2 --repeat 3

# soak pass: keep repeating for N minutes instead of a fixed attempt count
pnpm exec ts-node -r tsconfig-paths/register scripts/scrape-spike/run.ts \
  --store goodwine --client impit --pages 20 --soak 45 --out /tmp/soak.json
```

Flags: `--store <slug[,slug]|all>`, `--client plain|impit|playwright`,
`--pages <n>` (default 2), `--repeat <n>` (default 3), `--soak <minutes>`,
`--out <path>` (JSON report). Exit code is 1 when any pair failed.

Stores: `metro`, `novus` (two Zakaz.ua networks — `novus` uses the bare
`whiskey` category, the historical exception), `maudau`, `okwine`, `winewine`,
`wine-point`, `goodwine`, `rozetka`. `silpo` is out of scope: it stays
disabled regardless of the outcome.

## Pass criteria

- **Quick pass** — every attempt returns HTTP 200 for each page, parses a
  plausible number of items, and shows no Cloudflare interstitial marker.
  An attempt with zero parsed items or a detected challenge is a FAIL.
- **Soak pass** (`goodwine`, `rozetka` only) — full pagination cadence for
  30-60 minutes, ideally repeated in a second session on another day, to
  catch rate-based escalation a three-request pass cannot see.

## Decision mapping

- Tier-1 store passes `plain` → it stays on plain `fetch`.
- Tier-1 store fails `plain` → escalate that one store to `impit` before
  considering a browser.
- `goodwine` passes `impit` → tier 2 needs no browser.
- `goodwine` fails `impit` → `goodwine` moves to the browser tier.
- `rozetka` fails `playwright` → that store goes to the hybrid contingency
  (Python keeps it and posts results through the API).

## Keep this folder

After the gate, the scripts stay as a re-runnable canary: rerun them whenever
a store starts failing in production to tell "Cloudflare changed its mind"
apart from "our code broke".

## Layout

| File                  | Purpose                                            |
| --------------------- | -------------------------------------------------- |
| `run.ts`              | CLI: argument parsing, matrix/escalation, summary  |
| `clients.ts`          | The three clients, stealth context, challenge wait |
| `probes.ts`           | One probe per store: pagination + parsing          |
| `spike.interfaces.ts` | Shared shapes                                      |
| `RESULTS.md`          | Recorded verdicts per phase                        |

## Porting gotchas found here

- **`page.evaluate(string)` does not call a function in the JS API.** The
  Python scraper passes `() => {...}` as a string and Python's Playwright
  invokes it; the JS API evaluates the string as an expression and returns the
  function object, so the result silently comes back `undefined`. The browser
  client wraps the source in an IIFE (`(${script})()`).
- Playwright's `headless: true` uses `chromium-headless-shell`. Rozetka's
  Cloudflare challenge cleared in both that and the full-Chromium new-headless
  mode (`channel: 'chromium'`), so the default is fine.
- Node's `fetch` negotiates and decodes compression itself, so unlike the
  Python client there is no reason to omit `br` from `Accept-Encoding` — the
  header is left unset entirely.
