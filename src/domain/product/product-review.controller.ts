import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';

import { Permission } from '~decorators/auth';
import { Paginated, Plain } from '~decorators/types';
import { Action, Resource } from '~enums';
import type {
  KbReconcileSummary,
  ProducerReviewRow,
  ProductFactReviewRow,
  ProductReviewQueueRow,
  ProductReviewStatusResult,
  ProductReviewSummary,
  ReviewConflictRow,
  TypePaginated,
} from '~types';

import {
  ConflictResolveDto,
  ProductReviewStatusDto,
  ReviewQueryDto,
} from './dto';
import { ProductReviewService } from './product-review.service';
import {
  KbReconcileSummaryType,
  ProducerReviewType,
  ProductFactReviewType,
  ProductReviewQueueType,
  ProductReviewStatusResultType,
  ProductReviewSummaryType,
  ReviewConflictType,
} from './types';

@Controller('product/review')
export class ProductReviewController {
  public constructor(private readonly reviewService: ProductReviewService) {}

  @Get('summary')
  @Plain(ProductReviewSummaryType, [Resource.PRODUCT, Action.REVIEW])
  public summary(): Promise<ProductReviewSummary> {
    return this.reviewService.summary();
  }

  @Get('producers')
  @Paginated(ProducerReviewType, [Resource.PRODUCER, Action.READ])
  public producers(
    @Query() query: ReviewQueryDto,
  ): Promise<TypePaginated<ProducerReviewRow>> {
    return this.reviewService.producersPage(query);
  }

  @Get('facts')
  @Paginated(ProductFactReviewType, [Resource.PRODUCT, Action.REVIEW])
  public facts(
    @Query() query: ReviewQueryDto,
  ): Promise<TypePaginated<ProductFactReviewRow>> {
    return this.reviewService.factsPage(query);
  }

  /**
   * One bucket of the new-product queue — what the last syncs created and
   * nobody has checked yet.
   *
   * @param query - Bucket (`pending` by default), search, shop and paging.
   * @returns A page of the queue, newest first.
   */
  @Get('queue')
  @Paginated(ProductReviewQueueType, [Resource.PRODUCT, Action.REVIEW])
  public queue(
    @Query() query: ReviewQueryDto,
  ): Promise<TypePaginated<ProductReviewQueueRow>> {
    return this.reviewService.queuePage(query);
  }

  @Get('conflicts')
  @Paginated(ReviewConflictType, [Resource.PRODUCT, Action.REVIEW])
  public conflicts(
    @Query() query: ReviewQueryDto,
  ): Promise<TypePaginated<ReviewConflictRow>> {
    return this.reviewService.conflictsPage(query);
  }

  @Post('apply')
  @HttpCode(HttpStatus.OK)
  @Plain(KbReconcileSummaryType, [Resource.PRODUCT, Action.REVIEW])
  public apply(): Promise<KbReconcileSummary> {
    return this.reviewService.applyKnowledgeBase();
  }

  /**
   * Records a verdict on a batch of bottlings: verified, not whisky, or back
   * into the queue.
   *
   * One route for all three, since they differ only in the value written and
   * un-rejecting is the same operation as verifying. `POST` rather than
   * `PATCH`, as every other review mutation here is.
   *
   * @param body - The bottlings and the verdict.
   * @returns How many rows were written, and the fresh queue counters.
   */
  @Post('status')
  @HttpCode(HttpStatus.OK)
  @Plain(ProductReviewStatusResultType, [Resource.PRODUCT, Action.REVIEW])
  public setStatus(
    @Body() body: ProductReviewStatusDto,
  ): Promise<ProductReviewStatusResult> {
    return this.reviewService.setStatus(body);
  }

  @Post('conflicts/resolve')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permission([Resource.PRODUCT, Action.REVIEW])
  public resolve(@Body() body: ConflictResolveDto): Promise<void> {
    return this.reviewService.resolveConflict(
      body.productId,
      body.storeId,
      body.attribute,
    );
  }
}
