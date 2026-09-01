import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * goodwine names its departments `&wine`, `&whisky` and `&food`, and one of
 * its listings carried that label in the brand slot:
 *
 *     Віскі & whisky Oak & Palomino & Oxidation & Sitting 8yo, 0.7 л
 *
 * The legacy pre-port import dropped the leading Cyrillic `Віскі` and
 * canonicalized the remainder into a permanent `brand` row. The seed research
 * already suspected it — `1787851000000-kb-seed-producer.tsv` records
 * "Likely a catalogue category/parsing artifact, not a real brand" — but the
 * row was never removed, and the KB round then minted a `producer` for it.
 *
 * The damage is done by the brand-from-name pass. `brandHaystack` deletes
 * every non-alphanumeric run, so `& Whisky` reduces to the bare key `whisky`;
 * the index is sorted longest key first, so at six characters it outranked
 * every real brand no longer than the word and claimed each listing whose name
 * ends in it. `Віскі Umiki Whisky` was stored as `& Whisky` while its own
 * `Umiki` row sat one character shorter in the same index, and measured over
 * the catalogue the collision was suppressing the right answer on 63 listings
 * (`Jura`, `Arran`, `Nikka`, `Bell's` among them).
 *
 * `ProductMatchUtils.carriesIdentity` now keeps such a brand out of the index
 * and out of `BrandUtils.canonical`, so nothing re-creates or re-applies it.
 * This removes what is already stored.
 *
 * The name is the identifier on purpose: an id would not exist outside the
 * environment this artifact was measured in, and every statement below is a
 * no-op where the row was never imported.
 */
const ARTIFACT_BRAND = '& Whisky';

/**
 * The `producer` the seed round minted from the same string. Its only alias is
 * `whisky` — `KbKeyUtils.key` deletes the ampersand exactly as the brand
 * matcher does — which is a key no producer can be identified by.
 */
const ARTIFACT_PRODUCER = 'and-whisky';

export class BrandWhiskyArtifact1788284978149 implements MigrationInterface {
  public name = 'BrandWhiskyArtifact1788284978149';

  public async up(queryRunner: QueryRunner): Promise<void> {
    /**
     * Detached explicitly rather than through the FK's own `ON DELETE SET
     * NULL`, because that would clear the value and leave the provenance
     * column stating where it came from — the invariant the fact-source work
     * holds is that a null value has a null source.
     *
     * Every row is cleared whatever its source says, `store` and `legacy`
     * included: the brand is a category label, so no provenance makes it
     * right. A `manual` value would deserve the usual exemption, and there is
     * none — the 14 rows split 10 `name`, 3 `legacy`, 1 `store`.
     */
    await queryRunner.query(
      `
      UPDATE "product" SET "brandId" = NULL, "brandSource" = NULL
      WHERE "brandId" = (SELECT "id" FROM "brand" WHERE "name" = $1)
    `,
      [ARTIFACT_BRAND],
    );

    /**
     * `blacklist_brand` cascades; the dump this was measured on holds no row
     * for this brand, and a user who had hidden a category label loses a rule
     * that was hiding an arbitrary slice of the catalogue anyway.
     */
    await queryRunner.query(
      `
      DELETE FROM "brand" WHERE "name" = $1
    `,
      [ARTIFACT_BRAND],
    );

    /**
     * The alias is degenerate by construction, so there is nothing to rescope
     * it to: every normalizer in the codebase folds `& Whisky` to `whisky`.
     */
    await queryRunner.query(
      `
      DELETE FROM "producer_alias"
      WHERE "producerId" = (SELECT "id" FROM "producer" WHERE "slug" = $1)
        AND "key" = 'whisky'
    `,
      [ARTIFACT_PRODUCER],
    );

    /**
     * `rejected` rather than deleted, the mechanism the `bayadera` retailer
     * row already uses: the verdict stays auditable, `pnpm research-brands`
     * never pays to look the string up again, and `pnpm kb-export --all`
     * carries the decision to the next environment instead of a fresh seed
     * resurrecting it. The row is inert either way — the resolver's index
     * whitelists `verified`/`auto` — and a reviewer can undo it from the
     * review screen.
     *
     * This overrides a hand-set `verified`, which is the point: the promotion
     * contradicted the row's own seed note.
     */
    await queryRunner.query(
      `
      UPDATE "producer"
      SET "status" = 'rejected',
          "note" = 'Not a producer: goodwine''s own category label '
            || '("&wine" / "&whisky" / "&food" name its departments), left in '
            || 'the brand table by the legacy import. Its only possible alias '
            || 'key is the bare word "whisky".',
          "updatedAt" = now()
      WHERE "slug" = $1
    `,
      [ARTIFACT_PRODUCER],
    );

    /**
     * `producerId` is deliberately not written here. `SET_PRODUCERS_SQL` is
     * its only writer, and a rejected producer leaves the resolver index, so
     * `KbApplyService` resolves those bottlings to nothing and clears the
     * column — including the one stale row that carries the producer without
     * the brand. `KbBootApplyService` runs that pass at the next bootstrap;
     * where `KB_APPLY_ON_BOOT` is off, `pnpm reconcile-flavors` does it.
     */
  }

  public async down(): Promise<void> {
    /**
     * Deliberately a no-op. Re-creating the brand row would restore the
     * defect, and nothing cleared here is lost: the next sync's
     * brand-from-name pass refills `brandId` (`fillMissing` treats a null as
     * beaten by any incoming source) and the boot apply re-resolves the
     * producer. Reverting is a revert of the code, not of this data.
     */
  }
}
