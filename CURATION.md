# Curating the catalogue

The `product` table is the catalogue of bottlings; `store_product` holds each
store's offer of one. A bottling's identity is its `matchKey`, derived once
when a store first lists a SKU and then **frozen** — see the "Whisky domain"
section of [`CLAUDE.md`](CLAUDE.md) for how it is built and why.

Deriving identity from a name is never perfect, so roughly one or two per cent
of the catalogue needs a human. Since 2026-09-06 the two everyday corrections
have an endpoint and a UI, and the SQL below is for what those cannot express.

- **Two rows are one whisky** → edit either one (`POST /product/update`, the
  pencil in the product card) so its name, volume and age match the other's.
  The server folds the two together on its own: the edited row moves onto the
  most-listed twin, the person's values win the merge, the vanishing row's key
  is retired into `product_match_alias` so the next listing keyed like it lands
  on the survivor, and the response's `merged` says it happened.
- **One listing is on the wrong whisky** → `POST /product/relink` (the card's
  «Лише <store>» scope): pick the target bottling from the catalogue search, or
  fill the fields and let the server find it by identity — creating it only
  when nothing matches. The rest of the group stays where it is, and a row the
  offer leaves empty is deleted when nothing refers to it.

What is still SQL: a key alias that should be dropped or pointed elsewhere, a
merge where the survivor must be a _less_-listed row and nothing on it may be
renamed, and the inspection queries. Run everything in a transaction and check
the row counts before committing. The link is a plain column, so a correction is
one `UPDATE`, and nothing a sync does can undo it — the offer upsert leaves
`productId` out of its conflict-update clause on purpose.

## Find candidates

Two bottlings that are really one whisky — same name, same size, same age, but
separate rows because their keys differ:

```sql
SELECT p.id, p."matchKey", p.name, p."volumeMl", p.age,
       count(sp.id) AS offers,
       string_agg(DISTINCT st.slug, ', ') AS stores
FROM product p
JOIN store_product sp ON sp."productId" = p.id
JOIN store st ON st.id = sp."storeId"
GROUP BY p.id
HAVING count(*) FILTER (WHERE true) > 0
ORDER BY lower(p.name), p."volumeMl", p.age;
```

One bottling that is really two — the giveaway is offers whose raw names
disagree about something the key ignores, most often strength:

```sql
SELECT sp."productId", st.slug, sp.sku, sp."nameOrig"
FROM store_product sp
JOIN store st ON st.id = sp."storeId"
WHERE sp."productId" IN (
  SELECT sp2."productId"
  FROM store_product sp2
  GROUP BY sp2."productId"
  HAVING count(*) > 1
)
ORDER BY sp."productId", st.slug;
```

A bottling nothing can ever match, which always needs a decision:

```sql
SELECT id, name FROM product WHERE "matchKey" IS NULL;
```

## Move an offer to another bottling

The single most common fix — a listing was linked to the wrong whisky.

```sql
UPDATE store_product
SET "productId" = '<target-product-id>', "updatedAt" = now()
WHERE id = '<offer-id>';
```

The offer keeps its price history, because the history hangs off the offer.

## Split a false merge

Two different whiskies share a bottling. Prefer the relink: opening the
misfiled listing and using the «Лише <store>» scope with the right name,
volume and age does all three steps below in one request, creating the second
bottling only when the catalogue lacks it. The SQL is for a split where the
new row needs a key of its own, or where several offers move at once.

```sql
-- 1. The new bottling. Give it a key nothing will collide with; a null key is
--    also fine and means "never match anything to this automatically" — a
--    listing can still reach it by identity (name, volume, age).
INSERT INTO product ("matchKey", name, age, abv, "volumeMl",
                     "typeId", "countryId")
SELECT NULL, 'Agitator Rye', age, 43, "volumeMl",
       "typeId", "countryId"
FROM product WHERE id = '<wrong-product-id>'
RETURNING id;

-- 2. Move the offers that are really the new product.
UPDATE store_product
SET "productId" = '<new-product-id>', "updatedAt" = now()
WHERE id IN ('<offer-id>', '<offer-id>');

-- 3. Flavors do not follow automatically — copy the ones that still apply.
INSERT INTO product_flavor ("productId", "flavorId", source)
SELECT '<new-product-id>', "flavorId", source
FROM product_flavor WHERE "productId" = '<wrong-product-id>'
ON CONFLICT ("productId", "flavorId") DO NOTHING;
```

Clear `lastLlmFlavorAt` on the new row if you want the classification pass to
answer for it on the next sync:

```sql
UPDATE product SET "lastLlmFlavorAt" = NULL WHERE id = '<new-product-id>';
```

## Merge two bottlings

Prefer the edit: renaming, re-aging or re-sizing one row to match the other
makes the server run exactly the steps below, plus the key retirement. Use the
SQL only when the survivor has to be the row the server would not pick (it
keeps the row a person named, else the most listed), and nothing on either row
may be renamed to get there.

Pick the row to keep — normally the one with the better name and the more
complete fields — then move everything onto it.

```sql
-- 1. Fill any gap on the survivor from the loser.
UPDATE product k SET
  name = COALESCE(k.name, l.name),
  abv = COALESCE(k.abv, l.abv),
  "typeId" = COALESCE(k."typeId", l."typeId"),
  "countryId" = COALESCE(k."countryId", l."countryId"),
  "lastLlmFlavorAt" = GREATEST(k."lastLlmFlavorAt", l."lastLlmFlavorAt"),
  "updatedAt" = now()
FROM product l
WHERE k.id = '<keep-id>' AND l.id = '<loser-id>';

-- 2. Move the flavor links, letting `llm` win where both rows have a tag.
INSERT INTO product_flavor ("productId", "flavorId", source)
SELECT '<keep-id>', "flavorId", source
FROM product_flavor WHERE "productId" = '<loser-id>'
ON CONFLICT ("productId", "flavorId") DO UPDATE
  SET source = 'llm'
  WHERE product_flavor.source = 'scrape'
    AND EXCLUDED.source = 'llm';

-- 3. Move the offers.
UPDATE store_product
SET "productId" = '<keep-id>', "updatedAt" = now()
WHERE "productId" = '<loser-id>';

-- 4. Move the collection rows, dropping the ones that would collide.
--    `user_collection` is unique per (userId, productId), so a user holding
--    both bottlings already has a row on the survivor; the loser's row is
--    then a duplicate of a whisky they own once. Move its purchases onto the
--    surviving row first so the bottles are never lost, then drop it.
UPDATE user_collection_purchase p
SET "collectionId" = k.id, "updatedAt" = now()
FROM user_collection l
JOIN user_collection k
  ON k."userId" = l."userId" AND k."productId" = '<keep-id>'
WHERE p."collectionId" = l.id AND l."productId" = '<loser-id>';

DELETE FROM user_collection l
WHERE l."productId" = '<loser-id>'
  AND EXISTS (
    SELECT 1 FROM user_collection k
    WHERE k."userId" = l."userId" AND k."productId" = '<keep-id>'
  );

UPDATE user_collection
SET "productId" = '<keep-id>', "updatedAt" = now()
WHERE "productId" = '<loser-id>';

-- 5. Retire the loser's key, so the next listing keyed like it lands on the
--    survivor instead of recreating the row this merge removes. Skip it when
--    the key names a wider identity than the survivor (a bare `arran|v700|a0`
--    is any ageless Arran, not the Amarone Cask).
INSERT INTO product_match_alias (key, "productId")
SELECT "matchKey", '<keep-id>' FROM product
WHERE id = '<loser-id>' AND "matchKey" IS NOT NULL;

UPDATE product_match_alias SET "productId" = '<keep-id>'
WHERE "productId" = '<loser-id>';

-- 6. Delete the loser. It has no offers and no collection rows now, so the
--    RESTRICT foreign keys let it go; its flavor links go with it.
DELETE FROM product WHERE id = '<loser-id>';
```

Step 6 is the check that steps 3 and 4 were complete: both foreign keys are
`RESTRICT`, so the delete is refused while any offer — or anyone's collection
row — still points at the loser. The collection step is the one that is easy to
forget, because most bottlings are in nobody's collection and the delete then
succeeds without it.

## Key aliases

`product_match_alias` holds the keys of merged-away rows, each pointing at the
bottling it now resolves to; the find-or-create step of every persist consults
it before `product.matchKey`. Two things a person may need to do to it:

```sql
-- What a retired key resolves to.
SELECT a.key, p.name, p."volumeMl", p.age
FROM product_match_alias a JOIN product p ON p.id = a."productId"
WHERE a.key LIKE 'arran%';

-- Drop an alias whose key names a wider identity than its target, so a
-- listing keyed like it becomes a new row for a person to place instead.
DELETE FROM product_match_alias WHERE key = '<key>';
```

An alias key is never also a live `product.matchKey`: the merge that records it
deletes the row that held it in the same transaction, and the find-or-create
step excludes every key it resolved through the table from its insert.

## Re-key a bottling

Only needed when a future listing should match a row it currently misses —
after a rename, say. The key is otherwise left alone.

```sql
UPDATE product SET "matchKey" = '<new-key>' WHERE id = '<product-id>';
```

The new key has to be exactly what `ProductMatchUtils.key` would produce for
the name, brand, volume and age you expect the listing to have; anything else
will simply not match. The unique index will reject a key another bottling
already holds — that is the signal to merge instead.

## What not to do

- **Do not delete a bottling that still has offers.** The foreign key stops
  you, and it is stopping you from deleting a store's whole price history.
- **Do not delete a bottling that sits in someone's collection.** The same kind
  of foreign key stops you, and it is stopping you from deleting a rating,
  tasting notes and a purchase history nothing can reconstruct.
- **Do not edit `age` or `volumeMl` expecting the key to change.** They are
  components of the key, but the key is frozen. What an edit _does_ change is
  the identity the catalogue compares rows by, so an edit that makes two rows
  agree on name, volume and age merges them — which is usually what was wanted.
- **Do not fix a name by editing `store_product.nameOrig`.** That column is the
  store's own wording, rewritten on the next sync. Edit `product.name` (or use
  `POST /product/update`, which does exactly that).
