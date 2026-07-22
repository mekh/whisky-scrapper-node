import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';

import { Plain } from '~decorators/types';
import { Action, Resource } from '~enums';
import type { TypeProduct } from '~types';

import { ProductUpdateDto } from './dto';
import { ProductService } from './product.service';
import { ProductType } from './types';

@Controller('product')
export class ProductController {
  public constructor(private readonly productService: ProductService) {}

  @Post('update')
  @HttpCode(HttpStatus.OK)
  @Plain(ProductType, [Resource.PRODUCT, Action.EDIT])
  public update(@Body() body: ProductUpdateDto): Promise<TypeProduct> {
    return this.productService.update(body);
  }
}
