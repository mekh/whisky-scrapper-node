import { Injectable } from '@nestjs/common';

import { CoreCountryService } from '~core/country';
import { CoreProductService } from '~core/product';
import { CoreTypeService } from '~core/type';
import { BadRequestError } from '~errors';
import { ID, ProductUpdateInput, TypeProduct } from '~types';

@Injectable()
export class ProductService {
  public constructor(
    private readonly products: CoreProductService,
    private readonly countries: CoreCountryService,
    private readonly types: CoreTypeService,
  ) {}

  /**
   * Applies a manual product edit: writes only the fields that were provided
   * (undefined fields are ignored), resolving the country code and type name
   * to their FK ids. A `null` value clears the field.
   *
   * @param input - The product id plus the fields to update.
   * @returns The product id with its updated name and raw fallback.
   * @throws {NotFoundError} When no product has the id.
   * @throws {BadRequestError} When a country code or type name is unknown.
   */
  public async update(input: ProductUpdateInput): Promise<TypeProduct> {
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
      input.id,
      patch as never,
    );

    return {
      id: updated.id,
      name: updated.name ?? null,
      nameOrig: updated.nameOrig,
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
