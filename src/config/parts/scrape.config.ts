import { Injectable } from '@nestjs/common';
import { IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';

import { BaseConfig } from '../base.config';

@Injectable()
export class ScrapeConfig extends BaseConfig {
  @IsNumber()
  @IsPositive()
  public readonly delayMultiplier = this.asNumber('SCRAPE_DELAY_MULTIPLIER')
    ?? 1;

  @IsString()
  @IsOptional()
  public readonly anthropicApiKey = this.asString('ANTHROPIC_API_KEY');
}
