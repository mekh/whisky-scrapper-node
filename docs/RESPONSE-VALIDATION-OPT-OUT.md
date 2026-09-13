# Opting a route out of the outgoing DTO pipeline (2026-09-13)

## 1. What this is for

`GET /report/:kind` returns a page of 50 bottlings with their offers. Before it reaches the client that page is converted into DTO instances by `@Plain`/`@Paginated` and then validated by `ValidationInterceptor`. Both passes are per-field and per-row, and the load test's CPU profile puts the pair at **4.7 ms of the ~8.5 ms a cached page costs — 55 %** (see [`LOAD-TEST-HANDOFF-2026-09-13.md`](LOAD-TEST-HANDOFF-2026-09-13.md) §4). Since the page-addressable cache landed it is the single largest item left.

Measured split of that pair, on a synthetic page of 50 groups with 2–3 offers each (`plainToInstance` + `new` + `Object.assign` exactly as `resToDto` does it, then `validateOrReject(..., { whitelist: true })`):

| Pass                                       | ms / page |
| ------------------------------------------ | --------- |
| `JSON.parse` of the same data (a baseline) | 0.32      |
| `plainToInstance` (the conversion)         | **1.69**  |
| `validateOrReject` (the validation)        | **1.70**  |
| both, which is what a page pays today      | 3.48      |
| `JSON.stringify` of the page (a baseline)  | 0.15      |

Measured again over HTTP once the flag was applied, which is the number that matters: the built app on the local production-shaped copy (7 389 in-stock offers, 3 137 groups), four closed-loop callers on `GET /report/catalog?page=1&perPage=50`, cache warm, rate limiter off, 20 s after a 5 s warm-up, both arms from the same source with only the decorator removed and rebuilt.

| Arm                                           | requests/s | p50         | p95         | page   |
| --------------------------------------------- | ---------- | ----------- | ----------- | ------ |
| Pipeline runs (before)                        | 121.6      | 32.3 ms     | 39.2 ms     | 103 KB |
| Pipeline skipped (`@ValidateResponse(false)`) | **316.7**  | **12.5 ms** | **14.9 ms** | 103 KB |

2.6x the throughput, and ~5 ms of event loop returned per page — more than the 3.5 ms the synthetic page predicted, since a real group carries more offers than the fixture did. Reproduced across two boots (316.1 and 316.7 requests/s).

The two halves cost the same, which decides the shape of the fix: **one flag governs the whole outgoing DTO pipeline**, not the validation alone. Skipping only the validation would leave half the cost in place, and on a route with validation off the conversion buys nothing — it exists so `validateOrReject` has a decorated instance to inspect.

## 2. Why the conversion is waste on this route specifically

`ReportService` already emits the exact wire shape, by explicit field selection rather than by trusting a downstream filter:

- `toOffer()` builds each offer by naming its 19 fields.
- `toPublicGroup()` / `toPublicRow()` destructure `producerId`/`bottlerId` away, with a comment saying they are dropped here deliberately rather than left to the validator.
- `priceSeries()` selects exactly `date` and `price`.

Field-by-field comparison of `ReportRow`/`ReportGroup` against the decorated properties of `ReportRowType`/`ReportGroupType`: 35 against 35, no difference in either direction. `ReportOffer` is a `Pick` of the same 19 fields `ReportOfferType` picks. Neither DTO carries `@Transform`/`@Expose`, and Fastify serializes a class instance exactly as it serializes a plain object.

So on `/report` the pipeline changes nothing about the bytes on the wire. It is an assertion, and the point of this work is to move that assertion from every request to CI.

## 3. The trap this must document

`validateOrReject(item, { whitelist: true })` does not only validate — class-validator **deletes** every property that carries no validation decorator. Outgoing validation is therefore also a silent response filter, and turning it off makes the handler's return value the wire contract verbatim.

That is safe on `/report` for the reasons in §2, and it is the first thing to check before flagging any other route. It goes in the decorator's JSDoc and in CLAUDE.md's Validation section.

## 4. Design

A single boolean-valued metadata flag, `@ValidateResponse(enabled = true)`, applicable to a class and to a method, with the method winning.

- **Boolean payload, not a marker.** `Reflector.getAllAndOverride` returns the first value that is not `undefined`, so `false` on a method overrides `true` on the class _and_ the reverse. A marker-only decorator could turn validation off but never back on, which is exactly what `/report`'s own `history` handler may want.
- **Read by two consumers.** `ValidationInterceptor` reads it through `Reflector` from `[getHandler(), getClass()]`. `Plain`'s wrapper reads the same key with `Reflect.getMetadata`, lazily at call time — the class-level metadata does not exist yet when a method decorator runs, and reading at call time also makes the result independent of the order the two decorators are written in.
- **Where it lives.** `~decorators/http`, beside `CacheControl` and `RateLimit`: the other route-level metadata decorators that global infrastructure reads. The token joins `~constants/inject-tokens.constants.ts`.
- **Swagger is untouched.** `@Plain`/`@Paginated` keep emitting `ApiOkResponse` and `Permission`; only the runtime conversion is skipped. `/docs-json` — and therefore the generated `../web` client — is byte-identical.

Two shapes were considered and dropped. A `NODE_ENV` gate is all-or-nothing and makes production behave differently from development precisely where a mistake would only surface in production. Dropping `@ValidateNested({ each: true })` from the `Paginated` envelope is one line and the same saving, but it applies silently to every paginated endpoint at once and cannot be reasoned about per route.

Moving the conversion out of `Plain`'s handler wrapper into the interceptor — which would delete `copyMeta` and leave one consumer instead of two — is the natural follow-up and is deliberately **not** in this plan: 74 call sites in 16 files and 9 controller specs.

## 5. Checkpoints

| # | Checkpoint                                                        | Gate                                                                                             | Status |
| - | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------ |
| 1 | The flag: token, `@ValidateResponse`, `ValidationInterceptor`     | New unit spec covers skip / validate / method-over-class; `tsc`, `eslint`, `dprint`, `pnpm test` | done   |
| 2 | `Plain` honours the same flag and skips `resToDto`                | New unit spec covers both paths; the 9 controller specs still pass                               | done   |
| 3 | Apply to `ReportController`; contract test replaces the assertion | Integration spec asserts the report's key sets equal the DTOs' decorated properties              | done   |
| 4 | Document and re-measure                                           | CLAUDE.md updated; before/after ms per page recorded here                                        | done   |

### Checkpoint 1 — the flag

`RESPONSE_VALIDATION_META_INJECT_TOKEN` in `~constants`, `validate-response.decorator.ts` in `~decorators/http`, and a `Reflector` in `ValidationInterceptor` that returns the payload untouched when the flag reads `false`. Nothing is applied to a controller yet, so behaviour is unchanged everywhere.

Done. `test/validate.interceptor.spec.ts` pins seven cases, including the two that matter: a handler opting back in inside an opted-out controller is still validated, and a handler opting out inside a validated controller is not. It also pins the whitelist trap of §3 in both directions — an undeclared property is stripped while validation runs and survives when it does not. Suite after: 1169 tests in 88 suites.

### Checkpoint 2 — the conversion

`Plain`'s wrapper returns the raw handler result when the flag reads `false`. `Paginated` needs no change of its own — it delegates to `Plain`.

Done. The wrapper is a named function expression so it can read its own metadata, and the flag is read when the handler runs rather than when it is decorated — which is what makes `@ValidateResponse` work written either above or below `@Plain`. `test/plain-type.decorator.spec.ts` pins seven cases: both decorator orders, both override directions, an empty result, and that an opted-out handler still carries its `swagger/apiResponse` metadata, so `/docs-json` is unchanged. Suite after: 1176 tests in 89 suites.

### Checkpoint 3 — apply and re-assert

`@ValidateResponse(false)` on `ReportController`. The assertion the pipeline used to make is replaced by an integration test that runs a seeded report and compares `Object.keys` of a group and of an offer against the class-validator metadata of `ReportGroupType` and `ReportOfferType`. That is the failure this protects against: a column added to `CURRENT_SQL` would previously have been stripped in silence and would now reach the client.

Done. The flag sits on the controller, so it covers `history` too, and `test/integration/report-contract.integration.spec.ts` asserts all five shapes against `declaredFields()` — the same set `whitelist: true` computes: the group (35), its offer (19), the page envelope, the history product (34) and a history point.

The gate was falsified before it was trusted: comparing the group against `ReportOfferType`'s 19 fields instead of its own 35 fails the suite, so the assertion is not passing vacuously. Suites after: 1176 unit tests in 89 suites, 211 integration tests in 21.

### Checkpoint 4 — document and re-measure

CLAUDE.md gains the flag under "Validation", together with the `whitelist` trap the old wording never stated and the `/report` application with its numbers. The measurements are in §1 above.

Done, and it turned up one thing the plan did not predict: **the responses are not byte-identical, only value-identical.** `plainToInstance` was normalizing JSON key order to the DTO's declaration order; without it the order is the one the service constructed the object in (`enrich`'s spread puts `referencePrice`, `discountPct`, `isNew`, `daysNew`, `daysDiscount` last). Same 35 keys, same values, same 3 137 groups, same 103 KB — a canonicalised comparison of both arms' bodies is equal, and a repeated request is byte-identical, so the new order is stable rather than arbitrary. Nothing should depend on JSON key order and `../web` reads a generated typed client, but it is observable and is now recorded in CLAUDE.md.

`/docs-json` was diffed across both arms and is **identical**, so the generated client is unaffected — the promise the unit spec only checked the mechanism of.
