import { IsEnum, IsOptional } from 'class-validator';

import { PRODUCER_ALIAS_MAX_LENGTH } from '~constants';
import { SafeText } from '~decorators/fields';
import { ProducerAliasScope } from '~enums';
import type { ProducerAliasInput } from '../product-review.interfaces';

/**
 * Upper bound on the note, matching `ProducerPatchDto`'s free-text fields.
 */
const TEXT_MAX = 512;

export class ProducerAliasDto implements ProducerAliasInput {
  @SafeText({ max: PRODUCER_ALIAS_MAX_LENGTH, notEmpty: true })
  public brand!: string;

  @IsOptional()
  @IsEnum(ProducerAliasScope)
  public scope?: ProducerAliasScope;

  @SafeText({ max: TEXT_MAX, multiline: true, optional: true })
  public note?: string;
}
