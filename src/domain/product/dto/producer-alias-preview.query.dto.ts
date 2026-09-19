import { IsEnum, IsOptional } from 'class-validator';

import { ProducerAliasScope } from '~enums';

/**
 * What to ask about one spelling before touching it.
 *
 * With no `scope` the question is the removal — what stops resolving when
 * the spelling goes. With one it is the rescope — what the spelling would
 * reach once it may be matched there, which is the number «→ на початку
 * назви» states on the producer card before it is pressed.
 */
export class ProducerAliasPreviewQueryDto {
  @IsOptional()
  @IsEnum(ProducerAliasScope)
  public scope?: ProducerAliasScope;
}
