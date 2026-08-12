import { PickType } from '@nestjs/swagger';

import type { ReportOffer } from '~types';

import { ReportRowType } from './report-row.type.dto';

export class ReportOfferType extends PickType(
  ReportRowType,
  [
    'id',
    'sku',
    'url',
    'nameOrig',
    'storeSlug',
    'storeName',
    'price',
    'oldPrice',
    'currency',
    'promo',
    'inStock',
    'previousPrice',
    'referencePrice',
    'discountPct',
    'isNew',
    'daysNew',
    'daysDiscount',
    'firstSeen',
    'capturedDate',
  ],
) implements ReportOffer {}
