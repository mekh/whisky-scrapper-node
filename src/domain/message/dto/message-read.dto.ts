import { IsBoolean } from 'class-validator';

import type { MessageReadInput } from '~types';

export class MessageReadDto implements MessageReadInput {
  @IsBoolean()
  public read!: boolean;
}
