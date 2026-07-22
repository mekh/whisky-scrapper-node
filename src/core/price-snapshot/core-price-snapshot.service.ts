import { Injectable } from '@nestjs/common';

import { CoreBaseService } from '~core/_common';

import { PriceSnapshotEntity } from './price-snapshot.entity';
import { PriceSnapshotRepository } from './price-snapshot.repository';

/**
 * Persistence-layer public API for the `price_snapshot` entity.
 */
@Injectable()
export class CorePriceSnapshotService
  extends CoreBaseService<PriceSnapshotEntity> {
  public constructor(protected readonly repo: PriceSnapshotRepository) {
    super(repo);
  }
}
