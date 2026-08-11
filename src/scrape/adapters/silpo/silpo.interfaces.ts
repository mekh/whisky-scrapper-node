/**
 * One product of the Silpo catalog API.
 */
export interface SilpoProduct {
  /**
   * Product name (`Віскі Jameson`); carries no volume or ABV.
   */
  title?: string | null;

  /**
   * Current price in hryvnia; may be fractional.
   */
  price?: number | null;

  /**
   * Pre-discount price in hryvnia, or null when there is none.
   */
  oldPrice?: number | null;

  /**
   * URL slug of the product page (`viski-jameson-58113`); the SKU fallback.
   */
  slug?: string | null;

  /**
   * The store's own numeric product id, also the slug's trailing segment;
   * the preferred SKU.
   */
  externalProductId?: number | string | null;

  /**
   * Remaining stock of the branch; 0 means out of stock, and out-of-stock
   * items stay in the listing with their price.
   */
  stock?: number | null;

  /**
   * Human-readable pack size the site displays (`0,7л`, `1л`); the volume
   * source.
   */
  displayRatio?: string | null;

  /**
   * Brand name (`Jameson`), or null when the store has none on file.
   */
  brandTitle?: string | null;
}

/**
 * One page of the catalog API response.
 */
export interface SilpoListing {
  /**
   * Total item count of the category, reported on every page.
   */
  total?: number | null;

  /**
   * Products of this page.
   */
  items?: SilpoProduct[] | null;
}

/**
 * One attribute of a product's detail response — a label/value pair the site
 * renders in its specification block.
 */
export interface SilpoAttribute {
  /**
   * The attribute itself; `key` is the stable machine name the adapter maps
   * on (`alcoholcontent`, `vydviski`, ...), while `title` is the Ukrainian
   * label the site displays and is not read.
   */
  attribute?: {
    key?: string | null;
  } | null;

  /**
   * The value. `title` carries the payload and arrives as a JSON **number**
   * for the numeric attributes (`46`, `53.9`) and as a string for the rest,
   * so it must be coerced before parsing.
   */
  value?: {
    title?: string | number | null;
  } | null;
}

/**
 * One group of a product's attributes (`generalInfo`, `nutrient`, ...). The
 * grouping carries no information the adapter needs — every group is flattened
 * into one key/value map.
 */
export interface SilpoAttributeGroup {
  /**
   * Attributes of this group; empty for the groups the product does not fill.
   */
  attributes?: SilpoAttribute[] | null;
}

/**
 * One product's detail response (`/products/<sku>`), the only place the store
 * states strength, whisky type, age and country.
 *
 * The response also carries top-level `description`, `brand` and
 * `countryOfOrigin` fields which are **placeholders, never data**: every
 * product measured holds the literal strings `'no desc yet'` and
 * `'implement with filters'`. They are deliberately absent from this shape so
 * they cannot be read by accident — the real values live in `attributeGroups`
 * and `descriptionRich`.
 */
export interface SilpoDetail {
  /**
   * Marketing/tasting prose as an HTML fragment, present on roughly two
   * thirds of the catalogue. Grounding text for the flavor passes only; it is
   * never parsed for fields.
   */
  descriptionRich?: string | null;

  /**
   * Specification groups holding the strength, type, age and country values.
   */
  attributeGroups?: SilpoAttributeGroup[] | null;
}

/**
 * Detail-response attribute keys the adapter reads. Where two keys feed one
 * snapshot field the first is preferred and the second is a fallback, and each
 * source is canonicalized on its own — the primary key is present on nearly
 * every product but often holds a value the project taxonomy drops, so a raw
 * `a ?? b` chain would never reach the fallback.
 */
export enum SilpoAttributeKey {
  /**
   * Alcohol by volume (`% спирту`) — present on every product measured, and
   * the reason this adapter fetches detail pages at all.
   */
  ABV = 'alcoholcontent',
  /**
   * Country of origin (`Країна`). Usually the umbrella `Велика Британія`,
   * which `canonicalCountry` drops so the brand pass can refine it to
   * `Шотландія`.
   */
  COUNTRY = 'country',
  /**
   * Country of bottling (`Країна розливу`) — the country fallback.
   */
  BOTTLING_COUNTRY = 'krayinarozlyvu',
  /**
   * Whisky type (`Вид віскі`), e.g. `Односолодове / Single Malt`.
   */
  WHISKY_TYPE = 'vydviski',
  /**
   * Alcohol subtype (`Підвид`), e.g. `Blended` — the type fallback.
   */
  SUBSPECIES = 'subspecies',
  /**
   * Age statement (`Строк витримки`) — a spec field, not marketing prose, so
   * it is a legitimate age source (the same rule the okwine and alcomag
   * adapters follow). Sometimes a range (`3-6 років`), which is reduced to its
   * lower bound.
   */
  AGE = 'strokvytrymky',
  /**
   * A second age statement the store also files under `Строк витримки`,
   * holding a bare number (`12`) — the age fallback.
   */
  AGE_ALT = 'ageofcognac',
  /**
   * Whisky flavor (`Смак віскі`), e.g. `Димний, торф'яний`.
   */
  FLAVOR = 'smakviski',
  /**
   * Legacy flavor attribute (`Смак`), still filled on a few products.
   */
  TASTE = 'taste',
  /**
   * Legacy secondary flavor attribute (`Додатковий смак`).
   */
  ADD_TASTE = 'addtaste',
  /**
   * Plain-text marketing copy, filled instead of `descriptionRich` on a few
   * products — the description fallback.
   */
  DESCRIPTION = 'descriptionforwebsite',
}
