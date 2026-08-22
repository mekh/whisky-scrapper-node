import { Controller, Get, Query } from '@nestjs/common';

import { READ_CACHE_MAX_AGE_SECONDS } from '~constants';
import { CacheControl } from '~decorators/http';
import { Plain } from '~decorators/types';
import { Resource } from '~enums';
import type { TypeBrand } from '~types';

import { BrandService } from './brand.service';
import { BrandType } from './brand.type.dto';
import { BrandSearchQueryDto } from './dto';

@Controller('brand')
export class BrandController {
  public constructor(private readonly brandService: BrandService) {}

  @Get('search')
  @CacheControl(READ_CACHE_MAX_AGE_SECONDS)
  @Plain([BrandType], Resource.AUTHENTICATED)
  public search(@Query() query: BrandSearchQueryDto): Promise<TypeBrand[]> {
    return this.brandService.search(query);
  }
}
