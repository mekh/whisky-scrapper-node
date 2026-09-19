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
  ProducerQueueRow,
  ProducerReviewRow,
  ReviewPreview,
  TypePaginated,
} from '~types';

import {
  ProducerAliasDto,
  ProducerAliasPreviewQueryDto,
  ProducerAliasScopeDto,
  ProducerCreateDto,
  ProducerListQueryDto,
  ProducerPatchDto,
  ProducerQueueQueryDto,
  ProducerRuleCreateDto,
} from './dto';
import { ProducerReviewService } from './producer-review.service';
import { ProducerService } from './producer.service';
import { ReviewPreviewService } from './review-preview.service';
import {
  KbReconcileSummaryType,
  ProducerDetailType,
  ProducerOptionType,
  ProducerOwnerType,
  ProducerPatchResultType,
  ProducerProductType,
  ProducerQueueRowType,
  ProducerReviewType,
  ReviewPreviewType,
} from './types';

@Controller('producer')
export class ProducerController {
  public constructor(
    private readonly reviewService: ProducerReviewService,
    private readonly producerService: ProducerService,
    private readonly previewService: ReviewPreviewService,
  ) {}

  @Get()
  @Paginated(ProducerReviewType, [Resource.PRODUCER, Action.READ])
  public list(
    @Query() query: ProducerListQueryDto,
  ): Promise<TypePaginated<ProducerReviewRow>> {
    return this.producerService.list(query);
  }

  @Get('review')
  @Paginated(ProducerQueueRowType, [Resource.PRODUCER, Action.READ])
  public review(
    @Query() query: ProducerQueueQueryDto,
  ): Promise<TypePaginated<ProducerQueueRow>> {
    return this.reviewService.queue(query);
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

  @Patch(':id/alias/:aliasId')
  @Plain(KbReconcileSummaryType, [Resource.PRODUCER, Action.UPDATE])
  public rescopeAlias(
    @Param('id') id: string,
    @Param('aliasId') aliasId: string,
    @Body() body: ProducerAliasScopeDto,
  ): Promise<KbReconcileSummary> {
    return this.producerService.setAliasScope(
      id as ID,
      aliasId as ID,
      body.scope,
    );
  }

  /**
   * What one spelling would do before it is touched: removed when the query
   * names no scope, rescoped to that scope when it does. One route, since
   * both are the same question — what changes in the catalogue — about the
   * same row, and the card asks both for every spelling it shows.
   */
  @Get(':id/alias/:aliasId/preview')
  @Plain(ReviewPreviewType, [Resource.PRODUCER, Action.READ])
  public previewAlias(
    @Param('id') id: string,
    @Param('aliasId') aliasId: string,
    @Query() query: ProducerAliasPreviewQueryDto,
  ): Promise<ReviewPreview> {
    if (query.scope) {
      return this.previewService.previewAliasRescope(
        id as ID,
        aliasId as ID,
        query.scope,
      );
    }

    return this.previewService.previewAliasRemoval(id as ID, aliasId as ID);
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
