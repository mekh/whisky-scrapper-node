import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import { Permission } from '~decorators/auth';
import { Plain } from '~decorators/types';
import { Action, Resource } from '~enums';
import type {
  ID,
  KbReconcileSummary,
  ProducerDetail,
  ProducerPatchResult,
  ProducerProductRow,
} from '~types';

import { ProducerPatchDto, ProducerRuleCreateDto } from './dto';
import { ProductReviewService } from './product-review.service';
import {
  KbReconcileSummaryType,
  ProducerDetailType,
  ProducerPatchResultType,
  ProducerProductType,
} from './types';

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

  @Get(':id/products')
  @Plain([ProducerProductType], [Resource.PRODUCER, Action.READ])
  public products(@Param('id') id: string): Promise<ProducerProductRow[]> {
    return this.reviewService.producerProducts(id as ID);
  }

  @Post(':id/rule')
  @HttpCode(HttpStatus.OK)
  @Plain(KbReconcileSummaryType, [Resource.PRODUCER, Action.UPDATE])
  public createRule(
    @Param('id') id: string,
    @Body() body: ProducerRuleCreateDto,
  ): Promise<KbReconcileSummary> {
    return this.reviewService.createProducerRule(id as ID, body);
  }

  @Delete(':id/rule/:ruleId')
  @Plain(KbReconcileSummaryType, [Resource.PRODUCER, Action.UPDATE])
  public deleteRule(
    @Param('id') id: string,
    @Param('ruleId') ruleId: string,
  ): Promise<KbReconcileSummary> {
    return this.reviewService.deleteProducerRule(id as ID, ruleId as ID);
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
