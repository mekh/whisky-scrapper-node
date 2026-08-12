import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, ValidateNested } from 'class-validator';

import type { ReportGroup } from '~types';

import { ReportOfferType } from './report-offer.type.dto';
import { ReportRowType } from './report-row.type.dto';

/**
 * One report item: a bottling plus the offers of it the report selected.
 *
 * It extends the offer row rather than replacing it, so every field the list
 * already had keeps its meaning — they are the cheapest offer's — and the
 * `offers` array is purely additive. That is also why `/report/history` keeps
 * returning a bare `ReportRowType`: a single offer's history has no group.
 */
export class ReportGroupType extends ReportRowType implements ReportGroup {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReportOfferType)
  public offers!: ReportOfferType[];
}
