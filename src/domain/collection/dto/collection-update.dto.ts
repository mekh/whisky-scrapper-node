import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

import {
  COLLECTION_BARCODE_PATTERN,
  COLLECTION_NOTE_MAX_LENGTH,
  COLLECTION_RATING_MAX,
  COLLECTION_RATING_MIN,
  COLLECTION_RATING_SCALE,
} from '~constants';
import type { CollectionUpdateInput } from '~types';

/**
 * Every text field — including `barcode` — allows the empty string: sending
 * `""` is how a client clears a note or a barcode, so none of them carry
 * `@IsNotEmpty()`. `barcode` additionally needs `@ValidateIf` rather than a
 * bare `@Matches`, because {@link COLLECTION_BARCODE_PATTERN} requires 8-14
 * digits and would otherwise reject the clearing case outright; `rating` has
 * no such spelling (a number field has no empty string), so it clears
 * through the explicit {@link clearRating} flag instead.
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

  @IsOptional()
  @IsString()
  @MaxLength(COLLECTION_NOTE_MAX_LENGTH)
  public notes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(COLLECTION_NOTE_MAX_LENGTH)
  public nose?: string;

  @IsOptional()
  @IsString()
  @MaxLength(COLLECTION_NOTE_MAX_LENGTH)
  public palate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(COLLECTION_NOTE_MAX_LENGTH)
  public finish?: string;
}
