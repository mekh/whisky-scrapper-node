import { Injectable } from '@nestjs/common';
import { Transactional } from 'typeorm-transactional';

import { SEARCH_DEFAULT_LIMIT } from '~constants';
import { CoreCountryService } from '~core/country';
import { CoreFlavorService } from '~core/flavor';
import { CoreProductService } from '~core/product';
import { CoreStoreProductService } from '~core/store-product';
import { CoreTypeService } from '~core/type';
import { FactSource, ProductFactField } from '~enums';
import { BadRequestError, NotFoundError } from '~errors';
import type {
  ID,
  ProductCanonicalInput,
  ProductManualPatch,
  ProductRelinkInput,
  ProductSearchItem,
  ProductUpdateInput,
  SearchQuery,
  TypeProduct,
} from '~types';

@Injectable()
export class ProductService {
  public constructor(
    private readonly products: CoreProductService,
    private readonly offers: CoreStoreProductService,
    private readonly countries: CoreCountryService,
    private readonly types: CoreTypeService,
    private readonly flavors: CoreFlavorService,
  ) {}

  /**
   * Autocomplete search over the whole catalogue, one row per bottling.
   *
   * Deliberately not filtered by the caller's preferences: the settings
   * screen's picker must be able to find an already-hidden bottling so it can
   * be un-hidden. The default limit is applied here rather than in the
   * controller — it is business policy, not transport.
   *
   * @param query - The term and an optional row limit.
   * @returns Matching bottlings, best matches first.
   */
  public async search(query: SearchQuery): Promise<ProductSearchItem[]> {
    return this.products.search(query.q, query.limit ?? SEARCH_DEFAULT_LIMIT);
  }

  /**
   * Applies a manual product edit: writes only the fields that were provided
   * (undefined fields are ignored), resolving the country code and type name
   * to their FK ids. A `null` value clears the field.
   *
   * Every editable field belongs to the bottling rather than to one store's
   * listing, so **the edit applies to every store at once** — which is the
   * whole point of keeping a canonical catalogue. The incoming id may be either
   * a report row (a store offer, which is what the client has) or a canonical
   * product; both resolve to the same bottling.
   *
   * **An edit that makes two rows one whisky merges them.** After the patch
   * the bottling is compared against the rest of the catalogue by identity —
   * name, volume and age — and every row that now agrees on all three is
   * folded into one: the edited row moves onto the most-listed twin, taking
   * its offers, its lists and the fields the person just set with it (a
   * `manual` value wins the merge). That is what turns "rename `Arran Amarone
   * Casc` to `Arran Amarone Cask`" into a one-step correction instead of a
   * rename followed by a SQL merge. The check runs on every edit, not only
   * when an identity field changed, so an older duplicate is folded away the
   * first time either row is touched.
   *
   * Editing `age` or `volumeMl` does **not** re-derive the bottling's match
   * key. The key is frozen when the row is created (see `EntityProduct`); the
   * merge above is what reconciles the catalogue instead, and the vanishing
   * row's key is retired into `product_match_alias` so a later listing keyed
   * like it lands on the survivor.
   *
   * `flavors` is the one field that is not a column on `product`: it replaces
   * the bottling's whole tag set and marks it curated, so the automatic passes
   * stop contributing to it. It is written after the column patch, and only if
   * the patch succeeded — an unknown country code must not leave a product with
   * new tags and an old country.
   *
   * @param input - The product or offer id plus the fields to update.
   * @returns The requested id, the bottling it now belongs to, the updated
   * name and a raw fallback.
   * @throws {NotFoundError} When the id matches neither an offer nor a
   * product.
   * @throws {BadRequestError} When a country code, type name or flavor name is
   * unknown.
   */
  @Transactional()
  public async update(input: ProductUpdateInput): Promise<TypeProduct> {
    const ref = await this.offers.findOfferRefById(input.id);

    if (!ref) {
      throw new NotFoundError('Product not found', { id: input.id });
    }

    const patch = await this.buildPatch(input);

    const updated = await this.products.updateByIdOrThrow(
      ref.productId,
      patch as never,
    );

    if (input.flavors !== undefined) {
      await this.setFlavors(ref.productId, input.flavors);
    }

    const survivorId = await this.mergeTwins(
      ref.productId,
      updated.name ?? null,
      updated.volumeMl ?? null,
      updated.age ?? null,
    );

    const survivor = survivorId === ref.productId
      ? updated
      : await this.products.findByIdOrThrow(survivorId);

    /**
     * The caller's own id is echoed back rather than the canonical one, so the
     * response still names the thing the client asked about. `nameOrig` has to
     * come from the resolved offer — the bottling carries no raw name.
     */
    return {
      id: input.id,
      productId: survivorId,
      name: survivor.name ?? null,
      nameOrig: ref.nameOrig,
      merged: survivorId !== ref.productId,
      created: false,
    };
  }

  /**
   * Moves one store offer onto another bottling, leaving the rest of its
   * group where it is — the correction for a listing the matcher filed under
   * the wrong whisky.
   *
   * The target is either named outright by `productId`, or described by the
   * attribute fields and looked up **by identity**: the most-listed bottling
   * with that name, volume and age is used, and one is created only when
   * nothing matches. A found bottling's own facts stand — the attributes are
   * the address of the target, not an edit of it — while a created one is
   * stamped `manual` throughout, since every value on it is a person's.
   *
   * The bottling the offer leaves is deleted when nothing refers to it any
   * more: a row whose only listing was just moved is an empty shell that
   * would otherwise keep answering searches. A row anyone still lists or
   * holds in a collection is kept.
   *
   * @param input - The offer id and the target, by id or by attributes.
   * @returns The offer id, the bottling it now belongs to and whether that
   * bottling had to be created.
   * @throws {NotFoundError} When the id names no offer, or `productId` names
   * no bottling.
   * @throws {BadRequestError} When neither a product id nor a name is given,
   * or a country code, type name or flavor name is unknown.
   */
  @Transactional()
  public async relink(input: ProductRelinkInput): Promise<TypeProduct> {
    const offer = await this.offers.findById(input.id);

    if (!offer) {
      throw new NotFoundError('Offer not found', { id: input.id });
    }

    const target = await this.resolveRelinkTarget(input);
    const previous = await this.offers.relink(offer.id, target.id);

    if (previous !== null && previous !== target.id) {
      await this.products.deleteIfUnreferenced(previous);
    }

    return {
      id: offer.id,
      productId: target.id,
      name: target.name,
      nameOrig: offer.nameOrig,
      merged: false,
      created: target.created,
    };
  }

  /**
   * Resolves the fields of an edit into a column patch, each value stamped
   * with its provenance.
   *
   * @param input - The edit.
   * @returns The patch to apply to the bottling.
   * @throws {BadRequestError} When a country code or type name is unknown.
   */
  private async buildPatch(
    input: ProductUpdateInput,
  ): Promise<ProductManualPatch> {
    const patch: ProductManualPatch = {};

    if (input.name !== undefined) {
      this.stamp(patch, 'name', ProductFactField.NAME, input.name);
    }

    if (input.age !== undefined) {
      this.stamp(patch, 'age', ProductFactField.AGE, input.age);
    }

    if (input.abv !== undefined) {
      this.stamp(patch, 'abv', ProductFactField.ABV, input.abv);
    }

    if (input.volumeMl !== undefined) {
      this.stamp(patch, 'volumeMl', ProductFactField.VOLUME, input.volumeMl);
    }

    if (input.countryCode !== undefined) {
      const countryId = await this.resolveCountryId(input.countryCode);

      this.stamp(patch, 'countryId', ProductFactField.COUNTRY, countryId);
    }

    if (input.typeName !== undefined) {
      const typeId = await this.resolveTypeId(input.typeName);

      this.stamp(patch, 'typeId', ProductFactField.TYPE, typeId);
    }

    return patch;
  }

  /**
   * Folds a bottling together with every other row that shares its identity.
   *
   * The most-listed twin survives and the edited row is merged into it — the
   * person's `manual` values win the merge, so the edit still lands — and any
   * further twins follow. Nothing happens when the bottling stands alone.
   *
   * @param productId - The bottling just edited.
   * @param name - Its name after the edit.
   * @param volumeMl - Its volume after the edit.
   * @param age - Its age after the edit.
   * @returns The id of the bottling that holds the group now.
   */
  private async mergeTwins(
    productId: ID,
    name: string | null,
    volumeMl: number | null,
    age: number | null,
  ): Promise<ID> {
    const twins = await this.products.findIdentityTwins(
      name,
      volumeMl,
      age,
      productId,
    );

    const [survivorId, ...rest] = twins;

    if (survivorId === undefined) {
      return productId;
    }

    await this.products.mergeInto(productId, survivorId);

    for (const twinId of rest) {
      await this.products.mergeInto(twinId, survivorId);
    }

    return survivorId;
  }

  /**
   * Works out which bottling a relink moves the offer to: the one named by
   * id, else the one the attributes match by identity, else a new one.
   *
   * @param input - The relink request.
   * @returns The target's id and name, and whether it was created.
   * @throws {NotFoundError} When `productId` names no bottling.
   * @throws {BadRequestError} When neither a product id nor a name is given,
   * or a country code, type name or flavor name is unknown.
   */
  private async resolveRelinkTarget(
    input: ProductRelinkInput,
  ): Promise<{ id: ID; name: string | null; created: boolean }> {
    if (input.productId) {
      const product = await this.products.findById(input.productId);

      if (!product) {
        throw new NotFoundError('Product not found', {
          productId: input.productId,
        });
      }

      return { id: product.id, name: product.name ?? null, created: false };
    }

    const trimmed = input.name?.trim() ?? '';
    const name = trimmed.length ? trimmed : null;

    if (name === null) {
      throw new BadRequestError(
        'A relink needs a product id or a product name',
        { id: input.id },
      );
    }

    const volumeMl = input.volumeMl ?? null;
    const age = input.age ?? null;

    const [twinId] = await this.products.findIdentityTwins(
      name,
      volumeMl,
      age,
    );

    if (twinId !== undefined) {
      const twin = await this.products.findByIdOrThrow(twinId);

      return { id: twin.id, name: twin.name ?? null, created: false };
    }

    const id = await this.createManual(input, name, volumeMl, age);

    return { id, name, created: true };
  }

  /**
   * Creates the bottling a relink described, every fact stamped `manual` and
   * no match key — a later listing reaches it by identity, not by key.
   *
   * @param input - The relink request carrying the attributes.
   * @param name - The trimmed display name.
   * @param volumeMl - The volume, or null.
   * @param age - The age statement, or null.
   * @returns The new bottling's id.
   * @throws {BadRequestError} When a country code, type name or flavor name
   * is unknown.
   */
  private async createManual(
    input: ProductRelinkInput,
    name: string,
    volumeMl: number | null,
    age: number | null,
  ): Promise<ID> {
    const countryId = await this.resolveCountryId(input.countryCode ?? null);
    const typeId = await this.resolveTypeId(input.typeName ?? null);

    const canonical: ProductCanonicalInput = {
      matchKey: null,
      name,
      brandOrig: null,
      typeId,
      countryId,
      age,
      abv: input.abv ?? null,
      volumeMl,
      factSources: {
        [ProductFactField.NAME]: FactSource.MANUAL,
        [ProductFactField.TYPE]: FactSource.MANUAL,
        [ProductFactField.COUNTRY]: FactSource.MANUAL,
        [ProductFactField.AGE]: FactSource.MANUAL,
        [ProductFactField.ABV]: FactSource.MANUAL,
        [ProductFactField.VOLUME]: FactSource.MANUAL,
      },
    };

    const id = await this.products.createUnmatched(canonical);

    if (input.flavors !== undefined) {
      await this.setFlavors(id, input.flavors);
    }

    return id;
  }

  /**
   * Writes one edited field into the patch together with its provenance.
   *
   * The provenance half is not bookkeeping — it is what makes the edit
   * durable. Every automatic pass is now gated on `<field>Source <> 'manual'`,
   * so without the stamp the knowledge-base pass or the very next sync would
   * quietly overwrite a correction somebody had just made by hand.
   *
   * A cleared field is stamped `manual` too. Clearing is a decision — usually
   * "what was here was wrong" — and leaving it unstamped would let the next
   * scrape put the same wrong value straight back.
   *
   * @param patch - The patch being built (mutated in place).
   * @param column - The entity column to write.
   * @param field - The fact field, which names the provenance column.
   * @param value - The new value, or null to clear it.
   * @returns Nothing.
   */
  private stamp(
    patch: ProductManualPatch,
    column: string,
    field: ProductFactField,
    value: string | number | null,
  ): void {
    patch[column] = value;
    patch[`${field}Source`] = FactSource.MANUAL;
  }

  /**
   * Resolves a country code to its FK id.
   *
   * @param code - ISO country code, or `null` to clear the country.
   * @returns The country id, or `null` when `code` is null/empty.
   * @throws {BadRequestError} When the code matches no country.
   */
  private async resolveCountryId(code: string | null): Promise<ID | null> {
    if (!code) {
      return null;
    }

    const country = await this.countries.findOne({ code });

    if (!country) {
      throw new BadRequestError('Unknown country code', { code });
    }

    return country.id;
  }

  /**
   * Resolves a whisky type name to its FK id.
   *
   * @param name - Type name, or `null` to clear the type.
   * @returns The type id, or `null` when `name` is null/empty.
   * @throws {BadRequestError} When the name matches no type.
   */
  private async resolveTypeId(name: string | null): Promise<ID | null> {
    if (!name) {
      return null;
    }

    const type = await this.types.findOne({ name });

    if (!type) {
      throw new BadRequestError('Unknown whisky type', { name });
    }

    return type.id;
  }

  /**
   * Replaces a bottling's flavor set with the named tags, marking it curated.
   *
   * Names are resolved, never created: a tag the client offers comes from the
   * `/meta` list, so anything else is a bad request rather than a new flavor to
   * add to the reference table every other product's filter reads from.
   *
   * @param productId - Canonical product id.
   * @param names - Flavor names to keep; an empty list clears the tags.
   * @returns Resolves once the set is stored and the bottling is marked.
   * @throws {BadRequestError} When a name matches no known flavor.
   */
  private async setFlavors(productId: ID, names: string[]): Promise<void> {
    const resolved = await this.flavors.findIdsByName(names);

    const unknown = names.filter((name) => !resolved.has(name.trim()));

    if (unknown.length) {
      throw new BadRequestError('Unknown flavor', { flavors: unknown });
    }

    await this.products.setManualFlavors(productId, [...resolved.values()]);
  }
}
