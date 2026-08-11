# Curating the catalogue

The `product` table is the catalogue of bottlings; `store_product` holds each
store's offer of one. A bottling's identity is its `matchKey`, derived once
when a store first lists a SKU and then **frozen** — see the "Whisky domain"
section of [`CLAUDE.md`](CLAUDE.md) for how it is built and why.

Deriving identity from a name is never perfect, so roughly one or two per cent
of the catalogue needs a human. This file is the set of SQL recipes for that.
There is deliberately no endpoint and no UI yet; the link is a plain column, so
a correction is one `UPDATE`, and nothing a sync does can undo it — the offer
upsert leaves `productId` out of its conflict-update clause on purpose.

Run everything in a transaction and check the row counts before committing.

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

Two different whiskies share a bottling. Create a second one and move the
offers that belong to it.

```sql
-- 1. The new bottling. Give it a key nothing will collide with; a null key is
--    also fine and means "never match anything to this automatically".
INSERT INTO product ("matchKey", name, age, abv, "volumeMl",
                     "brandId", "typeId", "countryId")
SELECT NULL, 'Agitator Rye', age, 43, "volumeMl",
       "brandId", "typeId", "countryId"
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

Pick the row to keep — normally the one with the better name and the more
complete fields — then move everything onto it.

```sql
-- 1. Fill any gap on the survivor from the loser.
UPDATE product k SET
  name = COALESCE(k.name, l.name),
  abv = COALESCE(k.abv, l.abv),
  "brandId" = COALESCE(k."brandId", l."brandId"),
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

-- 4. Delete the loser. It has no offers now, so the RESTRICT foreign key lets
--    it go; its flavor links go with it.
DELETE FROM product WHERE id = '<loser-id>';
```

Step 4 is the check that step 3 was complete: the foreign key refuses the
delete while any offer still points at the loser.

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
- **Do not edit `age` or `volumeMl` expecting the grouping to change.** They
  are components of the key, but the key is frozen; use a re-key or a merge.
- **Do not fix a name by editing `store_product.nameOrig`.** That column is the
  store's own wording, rewritten on the next sync. Edit `product.name` (or use
  `POST /product/update`, which does exactly that).
