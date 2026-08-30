# Retry lane (batch 20) — per-slug goals

This lane re-runs rows that earlier batches could not finish for tooling
reasons (exhausted search quota, 403-walled domains), plus five famous peated
producers whose positive claim lacks only a producer-domain citation. The
Claude Browser gets past most 403s that WebFetch hits — use it aggressively.

Rules of the lane:

- Your input is `in/retry-20.tsv` (18 fields, same shape as any batch).
- The earlier batch's verified row is your **baseline** — read it in
  `out/NN/producer.tsv` (NN below) and copy it, changing only what your goal
  needs plus anything you can genuinely improve. Do not regress a field the
  earlier batch verified.
- Write full outputs to `out/20/` exactly per `BRIEF.md`. Your rows override
  the earlier batch's rows at merge time, which is the point of the lane.
- Everything else in `BRIEF.md` applies unchanged (evidence bar, peat
  asymmetry, never invent a URL).

## Peat corroboration via browser (baseline row is already high)

| slug | out | goal |
| ---- | --- | ---- |
| springbank | 05 | Open springbank.scot (browser) and cite its own statement of Springbank's lightly peated style; restore `light` if corroborated. |
| longrow | 06 | Same site: Longrow is Springbank's heavily peated line; restore `heavy` if the domain states it. |
| lagg | 06 | Open laggwhisky.com or arranwhisky.com past the age gate; restore `heavy` (~50ppm) if stated. |
| yoichi | 05 | Open nikka.com's Yoichi pages; restore `medium` if the house style (coal-fired, peaty) is stated on-domain. |
| hakushu | 06 | Open suntory.com / house.suntory.com Hakushu pages; restore `light` if the lightly-peated house style is stated on-domain. |

If the producer's own domain still cannot be opened or does not state the
claim, keep `unknown` with the withheld note — that is a valid outcome.

## Quota-starved and 403-walled rows (baseline confidence low)

| slug | out | goal |
| ---- | --- | ---- |
| big-moustache | 05 | Never searched at all (quota). Full verification. |
| the-speaker | 05 | Sources 403/406d. Browser them: identify producer, country. |
| egans | 05 | egansirishwhiskey.com and variants 403d. Browser it. |
| cedar-ridge | 05 | Old domain parked; find the current one (cedarridgedistillery.com or similar) via browser. |
| clan-campbell | 05 | Identity confirmed, current owner unresolved (Pernod Ricard sold it 2023 — to whom?). |
| crabbie | 05 | Current owner of the whisky line (Halewood?) unresolved. |
| kentucky-jack | 06 | Quota-starved, never verified. Full verification. |
| kindilan | 06 | Quota-starved. Full verification (likely Australian?). |
| maen | 06 | Quota-starved. Full verification. |
| meikle-toir | 06 | Quota-starved. GlenAllachie's peated brand per trade press — verify on theglenallachie.com (browser), set parentSlug if confirmed. |
| lord-elcho | 06 | Quota-starved. Wemyss Malts brand? Verify. |
| hatozaki | 06 | Ownership conflict (Mossburn vs Akashi Sake Brewery/Yonezawa). Kaikyo Distillery is the maker; settle owner via kaikyodistillery.com. |
| ry3 | 07 | Quota-starved. Rare Character / Phenomenal Spirits? Verify. |
| stronachie | 07 | Quota-starved. A.D. Rattray's brand per legacy sources — verify on adrattray.com. |
| the-charles-house | 07 | Identity never verified; find who makes it. |
| wise-salmon | 07 | Quota-starved. Full verification. |
| yakusun | 07 | May be a Japanese flavored liqueur rather than whisky — settle it; reject with evidence if it is not whisky. |
| 15-stars | 07 | Quota-starved. Full verification (US bourbon?). |
| alexander | 07 | Italian-producer guess unconfirmed. Verify. |
| back-to-black | 07 | Quota-starved. Full verification. |
| masthouse | 15 | copperrivetdistillery.com 403d twice. Browser it; assert peat (`none` likely) only from what it states. |
