import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsNumber,
  IsOptional,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import {
  COLLECTION_BARCODE_PATTERN,
  COLLECTION_NOTE_MAX_LENGTH,
  COLLECTION_RATING_MAX,
  COLLECTION_RATING_MIN,
  COLLECTION_RATING_SCALE,
} from '~constants';
import { SafeText } from '~decorators/fields';
import type { CollectionUpdateInput } from '~types';

import { CollectionPurchasesPatchDto } from './collection-purchases-patch.dto';

/**
 * Every text field — including `barcode` — allows the empty string: sending
 * `""` is how a client clears a note or a barcode, so none of them carry
 * `@IsNotEmpty()`. `barcode` additionally needs `@ValidateIf` rather than a
 * bare `@Matches`, because {@link COLLECTION_BARCODE_PATTERN} requires 8-14
 * digits and would otherwise reject the clearing case outright; `rating` has
 * no such spelling (a number field has no empty string), so it clears
 * through the explicit {@link clearRating} flag instead.
 *
 * The four prose fields go through `SafeText`, which adds the one check
 * `@IsString()` + `@MaxLength()` miss: a control character — `U+0000` above
 * all — that validates here and then fails in Postgres as a `500`.
 *
 * `purchases` rides in the same body so that the edit screen's one «save»
 * is one request — the row's fields and every purchase change commit or
 * fail together.
 */
export class CollectionUpdateDto implements CollectionUpdateInput {
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: COLLECTION_RATING_SCALE })
  @Min(COLLECTION_RATING_MIN)
  @Max(COLLECTION_RATING_MAX)
  public rating?: number;

  @IsOptional()
  @IsBoolean()
  public clearRating?: boolean;

  @IsOptional()
  @ValidateIf((dto: CollectionUpdateDto) => dto.barcode !== '')
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
  @Type(() => CollectionPurchasesPatchDto)
  public purchases?: CollectionPurchasesPatchDto;
}
