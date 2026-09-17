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

import { PRODUCER_OPTION_LIMIT } from '~constants';
import { Permission } from '~decorators/auth';
import { Paginated, Plain } from '~decorators/types';
import { Action, Resource } from '~enums';
import type {
  ID,
  KbReconcileSummary,
  ProducerDetail,
  ProducerOptionRow,
  ProducerOwnerRow,
  ProducerPatchResult,
  ProducerProductRow,
  ProducerReviewRow,
  TypePaginated,
} from '~types';

import {
  ProducerAliasDto,
  ProducerCreateDto,
  ProducerListQueryDto,
  ProducerPatchDto,
  ProducerRuleCreateDto,
} from './dto';
import { ProducerService } from './producer.service';
import { ProductReviewService } from './product-review.service';
import {
  KbReconcileSummaryType,
  ProducerDetailType,
  ProducerOptionType,
  ProducerOwnerType,
  ProducerPatchResultType,
  ProducerProductType,
  ProducerReviewType,
} from './types';

@Controller('producer')
export class ProducerController {
  public constructor(
    private readonly reviewService: ProductReviewService,
    private readonly producerService: ProducerService,
  ) {}

  @Get()
  @Paginated(ProducerReviewType, [Resource.PRODUCER, Action.READ])
  public list(
    @Query() query: ProducerListQueryDto,
  ): Promise<TypePaginated<ProducerReviewRow>> {
    return this.producerService.list(query);
  }

  @Get('search')
  @Plain([ProducerOptionType], [Resource.PRODUCER, Action.READ])
  public search(
    @Query('q') term?: string,
    @Query('kind') kind?: string,
    @Query('limit') limit?: string,
  ): Promise<ProducerOptionRow[]> {
    return this.producerService.search(
      term,
      kind,
      Math.min(Number(limit) || PRODUCER_OPTION_LIMIT, PRODUCER_OPTION_LIMIT),
    );
  }

  @Get('owner')
  @Plain([ProducerOwnerType], [Resource.PRODUCER, Action.READ])
  public owners(
    @Query('q') term?: string,
    @Query('limit') limit?: string,
  ): Promise<ProducerOwnerRow[]> {
    return this.producerService.owners(
      term,
      Math.min(Number(limit) || PRODUCER_OPTION_LIMIT, PRODUCER_OPTION_LIMIT),
    );
  }

  @Get('unresolved')
  @Permission([Resource.PRODUCER, Action.READ])
  public unresolved(
    @Query('limit') limit?: string,
  ): Promise<{ brand: string; productCount: number }[]> {
    return this.reviewService.unresolvedBrands(
      limit ? Number(limit) : undefined,
    );
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @Plain(ProducerPatchResultType, [Resource.PRODUCER, Action.CREATE])
  public create(
    @Body() body: ProducerCreateDto,
  ): Promise<ProducerPatchResult> {
    return this.producerService.create(body);
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

  @Post(':id/alias')
  @HttpCode(HttpStatus.OK)
  @Plain(KbReconcileSummaryType, [Resource.PRODUCER, Action.UPDATE])
  public linkAlias(
    @Param('id') id: string,
    @Body() body: ProducerAliasDto,
  ): Promise<KbReconcileSummary> {
    return this.producerService.linkAlias(id as ID, body);
  }

  @Delete(':id/alias/:aliasId')
  @Plain(KbReconcileSummaryType, [Resource.PRODUCER, Action.UPDATE])
  public unlinkAlias(
    @Param('id') id: string,
    @Param('aliasId') aliasId: string,
  ): Promise<KbReconcileSummary> {
    return this.producerService.unlinkAlias(id as ID, aliasId as ID);
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
