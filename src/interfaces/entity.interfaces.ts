import { DeepPartial, FindOptionsWhere } from 'typeorm';

import { Action, Resource } from '~enums';

export type ID = string; // guid v7

export interface EntityBase {
  id: ID;
}

export interface EntityBaseRich extends EntityBase {
  createdAt: Date;
  updatedAt: Date;
}

export type EntityCreateInputBase<
  T extends EntityBaseRich,
> = DeepPartial<
  Omit<
    T,
    | 'id'
    | 'createdAt'
    | 'updatedAt'
  >
>;

export type EntityUpdateInputBase<
  T extends EntityBaseRich,
> = Partial<EntityCreateInputBase<T>>;

export type EntityFindInput<
  T extends EntityBaseRich,
> = FindOptionsWhere<T> | FindOptionsWhere<T>[];

export interface EntityCreateManyResult {
  success: boolean;
  identifiers: ID[];
  errors?: string[];
}

export interface EntityUser extends EntityBaseRich {
  name?: string;
  email?: string;
  password: string;
  admin: boolean;
  active: boolean;
  lastActiveAt?: Date;
}

export interface EntityAuthUser extends
  Pick<
    EntityUser,
    | 'id'
    | 'active'
    | 'admin'
    | 'password'
  > {
  permissions: EntityPermission[];
}

export interface EntityPermission extends EntityBaseRich {
  userId: ID;
  resource: Resource;
  action: Action;
}

export interface EntityCountry extends EntityBaseRich {
  code: string;
  nameUa: string;
  icon?: string;
}

export interface EntityType extends EntityBaseRich {
  name: string;
}

export interface EntityFlavor extends EntityBaseRich {
  name: string;
}

export interface EntityStore extends EntityBaseRich {
  slug: string;
  name: string;
  baseUrl: string;
  color?: string;
  active: boolean;
}

export interface EntityStoreConfig extends EntityBaseRich {
  storeId: ID;
  tier: number;
  delayFrom: number;
  delayTo: number;
  needsBrowser: boolean;
  retailChain?: string;
  category?: string;
  group?: string;
  engine: string;
}

/**
 * A bottling, independent of who sells it: what the whisky is, not what it
 * costs. Several stores' offers (`EntityStoreProduct`) point at one of these,
 * which is what lets an edit, a flavor classification or a photo be stored
 * once and read everywhere.
 */
export interface EntityProduct extends EntityBaseRich {
  /**
   * The cross-store identity of the bottling (`ProductMatchUtils.key`): a
   * normalized signature of name, brand, volume and age. Unique, and **frozen
   * at creation** — a later rename or a filled-in volume does not re-derive
   * it, because re-keying would silently detach the offers already linked.
   * Two rows that turn out to be one product are merged by hand.
   *
   * Null when no significant word survived normalization, which means the row
   * cannot be matched and stays on its own.
   */
  matchKey?: string;
  name?: string;
  age?: number;
  abv?: number;
  volumeMl?: number;
  /**
   * The brand string a shop stated for this bottling, canonicalized — the one
   * thing the knowledge base does not record.
   *
   * It is **not** a label and **not** a filter dimension: a report prints
   * `producer.name`, falling back to the bottler's. This column exists so the
   * makers the knowledge base is still missing stay findable — a bottling
   * with no `producerId` and a `brandOrig` is exactly one row of the
   * `/producer/unresolved` queue that `pnpm research-brands` works through.
   * Written on insert and filled when null, never overwritten.
   */
  brandOrig?: string;
  typeId?: ID;
  countryId?: ID;
  /**
   * When the LLM flavor pass last answered for this product. Set even when the
   * answer was "unknown" (which links no flavor at all), so the marker is the
   * only way to tell "never asked" from "asked, recognized nothing" — a
   * product with no flavor links looks identical either way.
   */
  lastLlmFlavorAt?: Date;
  /**
   * When someone last set this product's flavors by hand. Once set, the tag set
   * is a person's decision and both automatic passes leave it alone: the
   * keyword pass adds nothing to it and the LLM pass is never asked about it.
   * Without that lock a removed tag would come back on the next sync, since the
   * keyword pass re-contributes whatever the listing still says.
   */
  flavorsCuratedAt?: Date;
  /**
   * The distillery or blender whose spirit this is, resolved from the
   * knowledge base. For an independent bottling it is the **distillery named
   * inside the product name**, not the bottler: `Gordon & MacPhail Caol Ila
   * 12` resolves to Caol Ila.
   *
   * Null when no producer could be resolved, which is an explicit "we do not
   * know" — undisclosed bottlings (`XOP Speyside Finest 1967`) are meant to
   * stay null rather than be guessed at.
   */
  producerId?: ID;
  /**
   * The independent bottler, when the brand is one. A non-null value **is**
   * the IB flag; there is no separate boolean to disagree with it.
   */
  bottlerId?: ID;
  /**
   * Where the cleaned `name` came from ({@link FactSource}).
   */
  nameSource?: string;
  /**
   * Where `typeId` came from. The knowledge base overwrites this wherever the
   * resolved producer states a default type.
   */
  typeSource?: string;
  /**
   * Where `countryId` came from. The knowledge base overwrites this whenever a
   * producer resolves — a distillery's country does not vary by bottling.
   */
  countrySource?: string;
  /**
   * Where `abv` came from. Physical and per-bottling, so it is never
   * knowledge-base-owned; disagreements between stores are logged to
   * `product_fact_conflict` instead.
   */
  abvSource?: string;
  /**
   * Where `age` came from.
   */
  ageSource?: string;
  /**
   * Where `volumeMl` came from.
   */
  volumeSource?: string;
  /**
   * How `producerId` / `bottlerId` were decided — `kb` for the resolver's own
   * answer, `manual` for a hand relink.
   */
  producerSource?: string;
}

/**
 * A curated knowledge-base entry: a distillery, a named brand, a blend or an
 * independent bottler, with the facts that are properties of the **producer**
 * rather than of one bottling — country, region, house peat level, default
 * type.
 *
 * This is the single source of truth the catalogue was missing. A store's
 * listing and an LLM's answer are both evidence about a fact; this row states
 * it. Rows are keyed by `slug` and reached through `EntityProducerAlias`, never
 * by `brandId`, because the catalogue's brand names carry typos and duplicate
 * spellings that must all resolve to one researched entry.
 */
export interface EntityProducer extends EntityBaseRich {
  /**
   * Stable identifier used by the seed files and by `flavor_rule`, e.g.
   * `tobermory`, `ledaig`, `gordon-macphail`. Unique.
   */
  slug: string;
  /**
   * Display name.
   */
  name: string;
  /**
   * Which kind of entity this is ({@link ProducerKind}).
   */
  kind: string;
  /**
   * Country FK. Drives `product.countryId` for every bottling that resolves
   * here.
   */
  countryId?: ID;
  /**
   * Region as the market uses it ({@link ScotlandRegion}), including
   * `islands`. This is the value exposed for display and filtering. Null
   * outside Scotland and for most blends.
   */
  region?: string;
  /**
   * The protected region under the Scotch Whisky Regulations
   * ({@link ScotlandLegalRegion}), which does not recognise `islands` —
   * Tobermory is legally Highland while every shop lists it as an island malt.
   */
  legalRegion?: string;
  /**
   * Current owner, for review and display.
   */
  owner?: string;
  /**
   * The distillery this brand belongs to, for a `brand`-kind row: `ledaig` ->
   * `tobermory`, `williamson` -> `laphroaig`.
   *
   * The resolver **never follows this to inherit facts** — a sibling brand
   * exists precisely because its facts differ from its parent's, which is the
   * whole Tobermory/Ledaig bug. It is used for display, for review grouping,
   * and to arbitrate when a name matches both the brand and its distillery.
   */
  parentId?: ID;
  /**
   * The bottler that owns this brand or range: `big-peat` ->
   * `douglas-laing`. Lets a bottling resolve its bottler even when the brand
   * value names the range rather than the company.
   */
  bottlerId?: ID;
  /**
   * Whisky type name written onto resolving bottlings. Must match a row in
   * `type`. Null for bottlers and for brands spanning several types, where the
   * store's or the name's value survives.
   */
  defaultTypeName?: string;
  /**
   * How peated the standard line is ({@link PeatProfile}). The only source the
   * `peated` tag has.
   */
  peatProfile: string;
  /**
   * How far this row has been checked ({@link KbStatus}). Only `verified` and
   * `auto` rows are loaded by the resolver.
   */
  status: string;
  /**
   * Confidence the research pass reported, kept for review triage.
   */
  confidence?: string;
  /**
   * Newline-separated citations. Required for a `verified` row.
   */
  sourceUrls?: string;
  /**
   * Reviewer notes, and the place a withheld research proposal is recorded
   * (for example a peat level that failed the corroboration gate).
   */
  note?: string;
  /**
   * When a person confirmed this row. Set only by human review.
   */
  verifiedAt?: Date;
}

/**
 * One spelling that resolves to a producer. The resolver's entire match index
 * is built from this table, which is why it holds the catalogue's typos
 * (`Isiay Mist`, `Douglas Laingcompany`) alongside canonical names.
 */
export interface EntityProducerAlias extends EntityBaseRich {
  /**
   * The normalized key (`KbKeyUtils.key`). Unique across all producers, so one
   * spelling can never resolve two ways.
   */
  key: string;
  /**
   * The producer this spelling names.
   */
  producerId: ID;
  /**
   * Where this alias may be matched ({@link ProducerAliasScope}). A short or
   * generic alias must stay `brand`-scoped, or it mis-fires as a substring of
   * a product name.
   */
  scope: string;
  /**
   * Why this alias exists, when it is not obvious (a typo, a transliteration,
   * a historical name).
   */
  note?: string;
}

/**
 * A curated statement about a producer's house style, for the thirteen
 * non-peat flavor tags.
 *
 * `peated` may never appear here: peat has exactly one source of truth
 * (`producer.peatProfile` plus the peat rules), and a second one would
 * reintroduce the disagreement this design removes. `smoky` **is** allowed,
 * because non-peat smokiness is a real house characteristic — Jack Daniel's
 * charcoal mellowing being the catalogue's clearest case.
 */
export interface EntityProducerFlavor {
  /**
   * The producer this statement is about.
   */
  producerId: ID;
  /**
   * The flavor tag.
   */
  flavorId: ID;
  /**
   * What the row asserts ({@link KbFlavorEffect}).
   */
  effect: string;
  /**
   * Confidence the research pass reported.
   */
  confidence?: string;
  /**
   * Newline-separated citations.
   */
  sourceUrls?: string;
  /**
   * Reviewer notes.
   */
  note?: string;
  /**
   * When the row was created.
   */
  createdAt: Date;
}

/**
 * A deterministic rule keyed on a pattern in the product name, for the facts
 * that vary between one producer's bottlings.
 *
 * This is what replaces the `variable` peat band: `Bruichladdich` is unpeated,
 * and `Port Charlotte` / `Octomore` in the name make a bottling heavily
 * peated. A rule is either a peat rule or a tag rule, never both — enforced by
 * a CHECK constraint, so a row cannot half-state two different things.
 */
export interface EntityFlavorRule extends EntityBaseRich {
  /**
   * The producer this rule is scoped to, or null for a global rule
   * (`unpeated`, `peated`, `торф`).
   */
  producerId?: ID;
  /**
   * The normalized pattern to look for in the product name. A plain string,
   * never a regular expression — a rule has to be reviewable by someone who
   * does not read regex.
   */
  pattern: string;
  /**
   * How the pattern is matched ({@link FlavorRuleMatchMode}).
   */
  matchMode: string;
  /**
   * The flavor tag this rule requires or forbids. Null on a peat rule.
   */
  flavorId?: ID;
  /**
   * Whether the tag is required or forbidden ({@link KbFlavorEffect}; only
   * `require` and `forbid` are meaningful here). Null on a peat rule.
   */
  effect?: string;
  /**
   * The peat level this pattern implies ({@link PeatProfile}). Null on a tag
   * rule.
   */
  peatProfile?: string;
  /**
   * Higher wins. Negations sit at 100 so `Benromach Unpeated` outranks both
   * the producer's own light profile and any positive keyword; explicit
   * qualifiers (`lightly peated`, `heavily peated`) sit above the bare
   * `peated` keyword so a real catalogue row is not over-stated.
   */
  priority: number;
  /**
   * Newline-separated citations.
   */
  sourceUrls?: string;
  /**
   * Reviewer notes.
   */
  note?: string;
}

/**
 * A recorded disagreement between what the catalogue holds for a bottling and
 * what one store's listing claims.
 *
 * This is the log the "different sources of truth give different data" problem
 * needs: the canonical write silently discards a store's value whenever the
 * column is already filled, and this row is that discarded claim, kept so it
 * can be reviewed instead of lost. One row per (product, store, attribute) —
 * `seenCount` is bumped rather than a new row written, so a long-standing
 * disagreement does not grow the table daily.
 *
 * `age` and `volumeMl` are deliberately never compared: both are components of
 * the frozen match key, so a store that states a different one is describing a
 * **different bottling**, which is a merge question rather than a fact
 * conflict.
 */
export interface EntityProductFactConflict {
  /**
   * The bottling whose stored fact is disputed.
   */
  productId: ID;
  /**
   * The store making the conflicting claim.
   */
  storeId: ID;
  /**
   * Which fact is disputed ({@link ProductFactField}; one of `type`,
   * `country`, `brand`, `abv`).
   */
  attribute: string;
  /**
   * The catalogue's value at the time the conflict was seen, rendered for
   * reading.
   */
  storedValue?: string;
  /**
   * What this store's listing said instead.
   */
  claimedValue?: string;
  /**
   * The provenance of the stored value at the time — which is what tells a
   * reviewer whether the claim is worth acting on. A store contradicting an
   * `llm` value is a likely correction; one contradicting `kb` is a likely
   * store error.
   */
  storedSource?: string;
  /**
   * How many syncs have seen this same disagreement.
   */
  seenCount: number;
  /**
   * When the disagreement was first recorded.
   */
  firstSeenAt: Date;
  /**
   * When it was last seen.
   */
  lastSeenAt: Date;
  /**
   * When it was settled, by a person or by a knowledge-base overwrite.
   */
  resolvedAt?: Date;
}

/**
 * One store's offer of a bottling: its own SKU, page, availability and the
 * dates it was seen. Prices hang off this row, not off the product, and the
 * sweep flips `inStock` here.
 */
export interface EntityStoreProduct extends EntityBaseRich {
  storeId: ID;
  /**
   * The bottling this is an offer of. Assigned once, when the SKU is first
   * seen, and never rewritten by a sync — so moving an offer to another
   * product is a durable manual correction.
   */
  productId: ID;
  sku: string;
  url: string;
  nameOrig: string;
  inStock: boolean;
  firstSeen: string;
  lastSeen: string;
}

export interface EntityPriceSnapshot extends EntityBaseRich {
  storeProductId: ID;
  price: number;
  oldPrice?: number;
  currency: string;
  inStock: boolean;
  promo: boolean;
  capturedOn: string;
}

/**
 * One user's favorite bottling. Composite-keyed on `(userId, productId)` with
 * no surrogate id and no `updatedAt`: the row either exists or it does not, and
 * there is nothing about it to update.
 */
export interface EntityFavorite {
  /**
   * The user who favorited the bottling.
   */
  userId: ID;

  /**
   * The favorited bottling (`product.id`), never a store offer — a favorite is
   * a whisky, not one shop's listing of it.
   */
  productId: ID;

  /**
   * When the favorite was added. Kept so the eventual management screen can
   * order by it; nothing in the report reads it.
   */
  createdAt: Date;
}

/**
 * A bottling one user has hidden. Every report filters these out, in every
 * store, for that user only.
 */
export interface EntityBlacklistProduct {
  /**
   * The user who hid the bottling.
   */
  userId: ID;

  /**
   * The hidden bottling (`product.id`).
   */
  productId: ID;

  /**
   * When the bottling was hidden.
   */
  createdAt: Date;
}

/**
 * A producer one user has hidden. Broader than a product entry: it removes
 * every bottling the producer is resolved on, including ones listed later.
 *
 * The API calls this a brand rule, and keeps doing so — what changed is that
 * it now names one curated producer rather than one of the several `brand`
 * rows a maker used to be spelled across.
 */
export interface EntityBlacklistProducer {
  /**
   * The user who hid the producer.
   */
  userId: ID;

  /**
   * The hidden producer (`producer.id`). Matched against the bottling's
   * distillery **and** its bottler, so hiding an independent bottler hides
   * what it released. A bottling the knowledge base cannot place is never
   * matched — there is no "unknown producer" to hide.
   */
  producerId: ID;

  /**
   * When the producer was hidden.
   */
  createdAt: Date;
}

/**
 * One browser's push subscription, owned by one user. A browser profile holds
 * at most one subscription per origin, so `endpoint` is globally unique and a
 * re-subscribe from the same profile is an upsert, not a second row.
 */
export interface EntityPushSubscription extends EntityBaseRich {
  /**
   * The user notified through this subscription. Reassigned on upsert when
   * the same browser profile signs into another account.
   */
  userId: ID;

  /**
   * The push service URL the payload is POSTed to. Unique — it identifies the
   * browser installation, not the user.
   */
  endpoint: string;

  /**
   * Client public key (base64url), used by the `web-push` library to encrypt
   * the payload for this subscription.
   */
  p256dh: string;

  /**
   * Client auth secret (base64url), the second half of the encryption input.
   */
  auth: string;

  /**
   * The subscribing browser's User-Agent, kept only so a device list is
   * tellable apart by a human.
   */
  userAgent?: string;

  /**
   * When a push was last accepted by the push service for this subscription.
   */
  lastSuccessAt?: Date;
}

/**
 * One offer's price drop already claimed by a digest dispatch. Composite-keyed
 * on `(userId, storeProductId, capturedOn)` like the preference memberships:
 * the row either exists or it does not, and its presence is what makes a
 * second dispatch of the same day skip the drop.
 */
export interface EntityPushDigestLog {
  /**
   * The user the drop was included in a digest for.
   */
  userId: ID;

  /**
   * The store offer whose price dropped.
   */
  storeProductId: ID;

  /**
   * The capture day (`YYYY-MM-DD`) the drop was observed on.
   */
  capturedOn: string;

  /**
   * The dropped price, kept for auditing what was actually announced.
   */
  price: number;

  /**
   * The previous recorded price the drop was measured against.
   */
  previousPrice: number;

  /**
   * When the digest claimed the drop.
   */
  createdAt: Date;
}

/**
 * One user's named, saved catalogue filter set.
 */
export interface EntityQuickFilter extends EntityBaseRich {
  /**
   * The owning user. Sets are strictly private — nothing shares them.
   */
  userId: ID;

  /**
   * The user-chosen name, unique per user (case-insensitively).
   */
  name: string;

  /**
   * The saved filters, stored as `jsonb` and never interpreted here. See
   * `QuickFilterPayload` for why the backend stays blind to its keys.
   */
  filters: Record<string, unknown>;
}

export interface EntitySyncLog extends EntityBaseRich {
  storeId: ID;
  added: number;
  removed: number;
  updated: number;
  total: number;
  success?: boolean;
  error?: string;
  finishedAt?: Date;
  group?: string;
  trigger?: string;
  logFile?: string;
}
