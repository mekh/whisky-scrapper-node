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
  ProductReviewSummary,
  ReviewConflictRow,
  TypePaginated,
} from '~types';

import { ConflictResolveDto, ReviewQueryDto } from './dto';
import { ProductReviewService } from './product-review.service';
import {
  KbReconcileSummaryType,
  ProducerReviewType,
  ProductFactReviewType,
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
