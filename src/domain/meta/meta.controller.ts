import { Controller, Get } from '@nestjs/common';

import { Plain } from '~decorators/types';
import { Resource } from '~enums';
import type { Meta } from '~types';

import { MetaService } from './meta.service';
import { MetaType } from './types';

@Controller('meta')
export class MetaController {
  public constructor(private readonly metaService: MetaService) {}

  @Get()
  @Plain(MetaType, Resource.AUTHENTICATED)
  public meta(): Promise<Meta> {
    return this.metaService.build();
  }
}
