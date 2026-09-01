import { IsString } from 'class-validator';

import type { TypeBrand } from '~types';

/**
 * One row of the brand autocomplete. Named `BrandType` for the `*Type` suffix
 * every response class carries, and `TypeBrand` is the `~types` interface it
 * implements.
 *
 * What it holds is a **producer** name — `/brand/search` reads the knowledge
 * base now — but the field and the route keep the word a shopper uses.
 */
export class BrandType implements TypeBrand {
  @IsString()
  public name!: string;
}
