import { IsEnum } from 'class-validator';

import { ProducerAliasScope } from '~enums';

/**
 * Where one spelling may be matched.
 *
 * Its own DTO rather than a reuse of `ProducerAliasDto`: that one creates a
 * spelling and needs the word, this one rescopes a row that already holds it.
 */
export class ProducerAliasScopeDto {
  @IsEnum(ProducerAliasScope)
  public scope!: ProducerAliasScope;
}
