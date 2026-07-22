import { IsNotEmpty, IsString } from 'class-validator';

import { GuidV7 } from '~decorators/fields';
import type { ID, SessionParams } from '~types';

export class SessionParamsDto implements SessionParams {
  @GuidV7()
  public userId!: ID;

  @IsString()
  @IsNotEmpty()
  public sid!: string;
}
