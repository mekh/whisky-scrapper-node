import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';

import { Paginated, Plain } from '~decorators/types';
import { Action, Resource } from '~enums';
import type {
  ID,
  KbReconcileSummary,
  ProductReviewStatusResult,
  ReviewBulkResult,
  ReviewCommitResult,
  ReviewPreview,
  ReviewQueueRow,
  ReviewSuggestions,
  ReviewSummary,
  TypePaginated,
} from '~types';

import {
  ProductReviewStatusDto,
  ReviewBulkDto,
  ReviewCommitDto,
  ReviewMergeDto,
  ReviewPreviewDto,
  ReviewQueueQueryDto,
} from './dto';
import { ProductReviewService } from './product-review.service';
import { ReviewCommitService } from './review-commit.service';
import { ReviewPreviewService } from './review-preview.service';
import {
  KbReconcileSummaryType,
  ProductReviewStatusResultType,
  ReviewBulkResultType,
  ReviewCommitResultType,
  ReviewPreviewType,
  ReviewQueueRowType,
  ReviewSuggestionsType,
  ReviewSummaryType,
} from './types';

@Controller('product/review')
export class ProductReviewController {
  public constructor(
    private readonly reviewService: ProductReviewService,
    private readonly commitService: ReviewCommitService,
    private readonly previewService: ReviewPreviewService,
  ) {}

  @Get('summary')
  @Plain(ReviewSummaryType, [Resource.PRODUCT, Action.REVIEW])
  public summary(
    @Query() query: ReviewQueueQueryDto,
  ): Promise<ReviewSummary> {
    return this.reviewService.summary(query.includeAcknowledged);
  }

  @Get('queue')
  @Paginated(ReviewQueueRowType, [Resource.PRODUCT, Action.REVIEW])
  public queue(
    @Query() query: ReviewQueueQueryDto,
  ): Promise<TypePaginated<ReviewQueueRow>> {
    return this.reviewService.queue(query);
  }

  @Get(':id/suggestions')
  @Plain(ReviewSuggestionsType, [Resource.PRODUCT, Action.REVIEW])
  public suggestions(@Param('id') id: string): Promise<ReviewSuggestions> {
    return this.reviewService.suggestions(id as ID);
  }

  @Post('apply')
  @HttpCode(HttpStatus.OK)
  @Plain(KbReconcileSummaryType, [Resource.PRODUCT, Action.REVIEW])
  public apply(): Promise<KbReconcileSummary> {
    return this.reviewService.applyKnowledgeBase();
  }

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @Plain(ReviewPreviewType, [Resource.PRODUCT, Action.REVIEW])
  public preview(@Body() body: ReviewPreviewDto): Promise<ReviewPreview> {
    return this.previewService.previewLink(body.productId, body.producer);
  }

  @Post('commit')
  @HttpCode(HttpStatus.OK)
  @Plain(ReviewCommitResultType, [Resource.PRODUCT, Action.REVIEW])
  public commit(@Body() body: ReviewCommitDto): Promise<ReviewCommitResult> {
    return this.commitService.commit(body);
  }

  @Post('merge')
  @HttpCode(HttpStatus.OK)
  @Plain(ReviewCommitResultType, [Resource.PRODUCT, Action.REVIEW])
  public merge(@Body() body: ReviewMergeDto): Promise<ReviewCommitResult> {
    return this.commitService.merge(body);
  }

  @Post('bulk')
  @HttpCode(HttpStatus.OK)
  @Plain(ReviewBulkResultType, [Resource.PRODUCT, Action.REVIEW])
  public bulk(@Body() body: ReviewBulkDto): Promise<ReviewBulkResult> {
    return this.commitService.bulk(body);
  }

  @Post('status')
  @HttpCode(HttpStatus.OK)
  @Plain(ProductReviewStatusResultType, [Resource.PRODUCT, Action.REVIEW])
  public setStatus(
    @Body() body: ProductReviewStatusDto,
  ): Promise<ProductReviewStatusResult> {
    return this.reviewService.setStatus(body);
  }
}
