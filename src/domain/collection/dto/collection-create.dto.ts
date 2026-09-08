import { Type } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import {
  COLLECTION_BARCODE_PATTERN,
  COLLECTION_NOTE_MAX_LENGTH,
  COLLECTION_RATING_MAX,
  COLLECTION_RATING_MIN,
  COLLECTION_RATING_SCALE,
} from '~constants';
import { GuidV7, SafeText } from '~decorators/fields';
import type { CollectionCreateInput, ID } from '~types';

import { CollectionPurchaseDto } from './collection-purchase.dto';

/**
 * The four free-text fields go through `SafeText` rather than a bare
 * `@IsString()` + `@MaxLength()` pair: a `U+0000` inside any of them is
 * accepted by both of those and then rejected by Postgres, which turns a
 * malformed body into a `500`.
 */
export class CollectionCreateDto implements CollectionCreateInput {
  @GuidV7()
  public productId!: ID;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: COLLECTION_RATING_SCALE })
  @Min(COLLECTION_RATING_MIN)
  @Max(COLLECTION_RATING_MAX)
  public rating?: number;

  @IsOptional()
  @Matches(COLLECTION_BARCODE_PATTERN)
  public barcode?: string;

  @SafeText({
    max: COLLECTION_NOTE_MAX_LENGTH,
    optional: true,
    multiline: true,
  })
  public notes?: string;

  @SafeText({
    max: COLLECTION_NOTE_MAX_LENGTH,
    optional: true,
    multiline: true,
  })
  public nose?: string;

  @SafeText({
    max: COLLECTION_NOTE_MAX_LENGTH,
    optional: true,
    multiline: true,
  })
  public palate?: string;

  @SafeText({
    max: COLLECTION_NOTE_MAX_LENGTH,
    optional: true,
    multiline: true,
  })
  public finish?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => CollectionPurchaseDto)
  public purchase?: CollectionPurchaseDto;
}
