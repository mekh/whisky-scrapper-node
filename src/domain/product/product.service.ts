import { Injectable } from '@nestjs/common';

import { CoreCountryService } from '~core/country';
import { CoreProductService } from '~core/product';
import { CoreStoreProductService } from '~core/store-product';
import { CoreTypeService } from '~core/type';
import { BadRequestError, NotFoundError } from '~errors';
import { ID, ProductUpdateInput, TypeProduct } from '~types';

@Injectable()
export class ProductService {
  public constructor(
    private readonly products: CoreProductService,
    private readonly offers: CoreStoreProductService,
    private readonly countries: CoreCountryService,
    private readonly types: CoreTypeService,
  ) {}

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
   * Editing `age` or `volumeMl` does **not** re-derive the bottling's match
   * key. The key is frozen when the row is created (see `EntityProduct`), so a
   * correction here changes what is displayed and filtered without detaching
   * the offers already linked; re-matching is a manual operation.
   *
   * @param input - The product or offer id plus the fields to update.
   * @returns The requested id with the updated name and a raw fallback.
   * @throws {NotFoundError} When the id matches neither an offer nor a
   * product.
   * @throws {BadRequestError} When a country code or type name is unknown.
   */
  public async update(input: ProductUpdateInput): Promise<TypeProduct> {
    const ref = await this.offers.findOfferRefById(input.id);

    if (!ref) {
      throw new NotFoundError('Product not found', { id: input.id });
    }

    const patch: Record<string, string | number | null> = {};

    if (input.name !== undefined) {
      patch.name = input.name;
    }

    if (input.age !== undefined) {
      patch.age = input.age;
    }

    if (input.abv !== undefined) {
      patch.abv = input.abv;
    }

    if (input.volumeMl !== undefined) {
      patch.volumeMl = input.volumeMl;
    }

    if (input.countryCode !== undefined) {
      patch.countryId = await this.resolveCountryId(input.countryCode);
    }

    if (input.typeName !== undefined) {
      patch.typeId = await this.resolveTypeId(input.typeName);
    }

    const updated = await this.products.updateByIdOrThrow(
      ref.productId,
      patch as never,
    );

    /**
     * The caller's own id is echoed back rather than the canonical one, so the
     * response still names the thing the client asked about. `nameOrig` has to
     * come from the resolved offer — the bottling carries no raw name.
     */
    return {
      id: input.id,
      name: updated.name ?? null,
      nameOrig: ref.nameOrig,
    };
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
}
