import { IsInt } from 'class-validator';

import type { KbReconcileSummary } from '~types';

export class KbReconcileSummaryType implements KbReconcileSummary {
  @IsInt()
  public groups!: number;

  @IsInt()
  public resolved!: number;

  @IsInt()
  public producerWrites!: number;

  @IsInt()
  public factWrites!: number;

  @IsInt()
  public flavorWrites!: number;
}
