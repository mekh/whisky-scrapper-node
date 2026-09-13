import { IsIn } from 'class-validator';

import { HEALTH_OK } from '~constants';
import type { HealthStatus } from '~types';

export class Health implements HealthStatus {
  @IsIn([HEALTH_OK])
  public status!: string;
}
