import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';

import { READ_CACHE_MAX_AGE_SECONDS } from '~constants';
import { CacheControl } from '~decorators/http';
import { Plain } from '~decorators/types';
import { Action, Resource } from '~enums';
import type { ProductSearchItem, TypeProduct } from '~types';

import { ProductSearchQueryDto, ProductUpdateDto } from './dto';
import { ProductService } from './product.service';
import { ProductSearchItemType, ProductType } from './types';

@Controller('product')
export class ProductController {
  public constructor(private readonly productService: ProductService) {}

  @Get('search')
  @CacheControl(READ_CACHE_MAX_AGE_SECONDS)
  @Plain([ProductSearchItemType], Resource.AUTHENTICATED)
  public search(
    @Query() query: ProductSearchQueryDto,
  ): Promise<ProductSearchItem[]> {
    return this.productService.search(query);
  }

  @Post('update')
  @HttpCode(HttpStatus.OK)
  @Plain(ProductType, [Resource.PRODUCT, Action.EDIT])
  public update(@Body() body: ProductUpdateDto): Promise<TypeProduct> {
    return this.productService.update(body);
  }
}
