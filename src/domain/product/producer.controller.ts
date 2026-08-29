import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';

import { Permission } from '~decorators/auth';
import { Plain } from '~decorators/types';
import { Action, Resource } from '~enums';
import type { ID, ProducerDetail, ProducerPatchResult } from '~types';

import { ProducerPatchDto } from './dto';
import { ProductReviewService } from './product-review.service';
import { ProducerDetailType, ProducerPatchResultType } from './types';

@Controller('producer')
export class ProducerController {
  public constructor(private readonly reviewService: ProductReviewService) {}

  @Get('unresolved')
  @Permission([Resource.PRODUCER, Action.READ])
  public unresolved(
    @Query('limit') limit?: string,
  ): Promise<{ brand: string; productCount: number }[]> {
    return this.reviewService.unresolvedBrands(
      limit ? Number(limit) : undefined,
    );
  }

  @Get(':id')
  @Plain(ProducerDetailType, [Resource.PRODUCER, Action.READ])
  public detail(@Param('id') id: string): Promise<ProducerDetail> {
    return this.reviewService.producerDetail(id as ID);
  }

  @Patch(':id')
  @Plain(ProducerPatchResultType, [Resource.PRODUCER, Action.UPDATE])
  public patch(
    @Param('id') id: string,
    @Body() body: ProducerPatchDto,
  ): Promise<ProducerPatchResult> {
    return this.reviewService.patchProducer(id as ID, body);
  }
}
