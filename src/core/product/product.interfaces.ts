import type { ProductReviewStatus } from '~enums';
import type {
  ID,
  ReviewConflict,
  ReviewOffer,
  ReviewProducerRef,
} from '~types';

/**
 * One curation-queue row exactly as the detector query returns it.
 *
 * Internal to `core/product`: the repository produces it and the service turns
 * it into a {@link ReviewQueueRow}, adding the severity each issue code
 * carries and the brand token hidden in each raw name. Those two are
 * TypeScript's to add — the first from the one severity map the client also
 * reads, the second from `BrandHintUtils` — and putting either in SQL would be
 * a second copy of a rule that already exists.
 */
export interface ReviewQueueSqlRow {
  /**
   * The bottling.
   */
  id: ID;

  /**
   * Its canonical name.
   */
  name: string | null;

  /**
   * The longest raw name any shop uses.
   */
  nameOrig: string | null;

  /**
   * The frozen match key.
   */
  matchKey: string | null;

  /**
   * Age statement in years.
   */
  age: number | null;

  /**
   * Where the age came from.
   */
  ageSource: string | null;

  /**
   * Strength.
   */
  abv: number | null;

  /**
   * Where the strength came from.
   */
  abvSource: string | null;

  /**
   * Pack size in millilitres.
   */
  volumeMl: number | null;

  /**
   * Where the pack size came from.
   */
  volumeSource: string | null;

  /**
   * Whisky type name.
   */
  type: string | null;

  /**
   * Where the type came from.
   */
  typeSource: string | null;

  /**
   * ISO country code.
   */
  countryCode: string | null;

  /**
   * The country's Ukrainian name.
   */
  countryName: string | null;

  /**
   * The country's flag.
   */
  countryIcon: string | null;

  /**
   * Where the country came from.
   */
  countrySource: string | null;

  /**
   * Where the producer link came from.
   */
  producerSource: string | null;

  /**
   * The spelling a shop used for the maker.
   */
  brandOrig: string | null;

  /**
   * The whisky type the bottling's own name states, or null when it states
   * none — what the `type-vs-name` chip says out loud.
   */
  namedType: string | null;

  /**
   * How many shops stock it.
   */
  storeCount: number;

  /**
   * The resolved distillery, brand or blend.
   */
  producer: ReviewProducerRef | null;

  /**
   * The independent bottler.
   */
  bottler: ReviewProducerRef | null;

  /**
   * Its flavour tags.
   */
  flavors: string[];

  /**
   * Every shop's listing, without the brand token the service adds.
   */
  offers: Omit<ReviewOffer, 'brandHint'>[];

  /**
   * The contradictions recorded against it.
   */
  conflicts: ReviewConflict[];

  /**
   * The codes that fired, as bare strings.
   */
  issues: string[];

  /**
   * Its place in the queue.
   */
  reviewStatus: ProductReviewStatus | null;

  /**
   * When a person last decided about it.
   */
  reviewedAt: Date | null;

  /**
   * When the catalogue created it.
   */
  createdAt: Date;
}
