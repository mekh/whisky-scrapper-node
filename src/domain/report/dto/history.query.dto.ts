import { IsNotEmpty, IsString } from 'class-validator';

import { HistoryQuery } from '~types';

export class HistoryQueryDto implements HistoryQuery {
  @IsString()
  @IsNotEmpty()
  public term!: string;
}
