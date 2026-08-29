# TODO

Work that is deferred by decision rather than by defect: it needs a sweep of
the stored catalogue, or a choice about identity that no single commit should
make on its own. Scrape-engine defects held back for other reasons live in
[`FOLLOWUPS.md`](FOLLOWUPS.md); the SQL for correcting the catalogue by hand is
in [`CURATION.md`](CURATION.md).

## One whisky split across two `product` rows

Measured on a production dump of 2026-08-12: **59 clusters covering 126
canonical rows and 390 in-stock offers** hold two `product` rows with the same
name, the same volume and the same age — the same bottling, listed twice.
Merging them takes the catalogue from 3 099 groups to 3 032.

The report now shows this instead of hiding it. Before the catalogue was
grouped, the duplicate rows were two of the fifty offers on a page and nobody
could see they were the same whisky; grouped, they sit next to each other as
two rows of one name, each with its own store count — «Aber Falls 0,7л» as
Auchan +7 and MauDau +5. Nothing regressed, the problem simply became legible.

### Root cause: the brand re-enters the key as a word the name already has

`ProductMatchUtils.key` (`src/utils/product-match.util.ts`) builds a key from
the significant words of the name plus **the brand collapsed to one token**:

```
Set(nameTokens(name)) + brandToken(brand)  ->  sorted, glued  ->  |v{ml}|a{age}
```

For most brands the brand _is_ the name, so that one token duplicates words
already in the set:

| Bottling   | brand at key time | matchKey                       |
| ---------- | ----------------- | ------------------------------ |
| Aber Falls | unknown           | `aberfalls\|v700\|a0`          |
| Aber Falls | `Aber Falls`      | `aberaberfallsfalls\|v700\|a0` |

Both keys are correct by the algorithm; which one a row got depends only on
whether the brand happened to be resolved when that row was created. And the
key is **frozen at creation** while `brandId` is fill-if-null, so a row keyed
before the brand-from-name pass existed still carries the short key even though
it has a brand today — 122 of the 126 duplicate rows have `brandId` set now.

Measured split of the 59 clusters: **58 differ in the key's name segment**
(this cause), **1 in the age segment**, none in the volume segment.

Real examples, in-stock offers only:

| Name                      | matchKey                                       | stores                                                                     |
| ------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------- |
| Aber Falls (NAS, 0.7 l)   | `aberaberfallsfalls\|v700\|a0`                 | alcomag, goodwine, maudau, okwine, rozetka, silpo                          |
| Aber Falls (NAS, 0.7 l)   | `aberfalls\|v700\|a0`                          | alcohub, auchan, epicentr, megamarket, novus, ultramarket, winetime, zaraz |
| Ballantine's Brasil (NAS) | `ballantinesballantinesbrasilbrasil\|v700\|a0` | alcohub, auchan, fozzy, rozetka, zaraz                                     |
| Ballantine's Brasil (NAS) | `ballantinesbrasil\|v700\|a0`                  | maudau, megamarket, metro, novus, ultramarket                              |
| Aberlour 12yo (0.7 l)     | `aberlour\|v700\|a0`                           | rozetka, winewine                                                          |
| Aberlour 12yo (0.7 l)     | `aberlour\|v700\|a12`                          | cosmos, fozzy, goodwine, metro, novus, silpo, wine-point, winetime         |

A maker with two brand rows produces a third variant: `chivasregal`,
`chivaschivasregalregal` and `chivaschivasbrothersregal` all exist.

### Secondary cause: the key froze before a spec was known

The `Aberlour` pair above is the other shape. Its key states `a0` because the
name carried no age when the row was created; `age` was filled in later by
another store's insert (canonical writes only ever fill a null), so the column
says 12 while the frozen key still says 0. One cluster of the 59.

### Finding them

```sql
WITH visible AS (
  SELECT DISTINCT p.id, p.name, p."volumeMl", p.age, p."matchKey", p."brandId"
  FROM product p
  JOIN store_product sp ON sp."productId" = p.id
  JOIN price_snapshot ps ON ps."storeProductId" = sp.id
  WHERE sp."inStock" AND p.name IS NOT NULL
),
dupes AS (
  SELECT lower(name) AS n, "volumeMl", age
  FROM visible
  GROUP BY 1, 2, 3
  HAVING count(*) > 1
)
SELECT v.name, v.age, v."volumeMl", v."matchKey",
       (SELECT string_agg(DISTINCT st.slug, ', ')
        FROM store_product sp
        JOIN store st ON st.id = sp."storeId"
        WHERE sp."productId" = v.id AND sp."inStock") AS stores
FROM visible v
JOIN dupes d
  ON lower(v.name) = d.n
 AND v."volumeMl" IS NOT DISTINCT FROM d."volumeMl"
 AND v.age IS NOT DISTINCT FROM d.age
ORDER BY lower(v.name), v."matchKey";
```

Restricting to in-stock rows with a snapshot is what scopes the result to what
the report actually shows; drop that join to sweep the whole catalogue.

### What the fix session has to decide

1. **Merge the stored duplicates.** Mechanically this is `CURATION.md`'s
   "move an offer to another bottling" applied per cluster, plus deleting the
   emptied row — but it ships as a **data migration**, not ad-hoc SQL, so
   production picks it up through the deploy's migrate gate. The surviving
   row's `matchKey` decides which spelling wins, and `product_flavor`,
   `brandId`/`typeId`/`countryId` and `lastLlmFlavorAt` have to be reconciled
   rather than dropped (the loser may hold a spec the winner is missing).

2. **Do not merge blind.** Same name, volume and age is evidence, not proof:
   strength is deliberately outside the key because stores disagree about it,
   and `Balvenie DoubleWood` genuinely exists at 40 % and 43 %. Each cluster
   needs eyeballing against its offers' `nameOrig`, and a cask or edition
   number that the name cleaner lifted out can hide there too.

3. **Whether to stop it recurring, and at what cost.** Deduplicating the brand
   token inside `ProductMatchUtils.key` is a two-line change that would make
   the two variants collapse — but it changes the key of _every_ product, and
   keys are frozen precisely so that a rename cannot detach the offers already
   linked. Changing the algorithm alone would only mint a fourth variant for
   the next store that lists an affected whisky. It is one migration or none:
   re-derive every stored key **and** merge the collisions the new key creates
   (`product_match_key_uindex` will not tolerate them), in the same file, with
   the counts asserted before it commits — the shape
   `1786450000000-product-canonical-split` already established.

4. **Whether the report should hint at it.** A grouped row could show that
   another row shares its name, which would turn the catalogue itself into the
   worklist for curation. Cheap, and it makes the remaining duplicates visible
   without a SQL prompt — but it is UI for a data defect, so it is worth
   deciding only if merging turns out to be a recurring chore rather than a
   one-off sweep.
