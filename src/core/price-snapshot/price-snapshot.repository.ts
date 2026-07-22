import { TypeormRepository } from '@toxicoder/nestjs-typeorm-repository';

import { BaseRepository } from '~core/_common';

import { PriceSnapshotEntity } from './price-snapshot.entity';

@TypeormRepository(PriceSnapshotEntity)
export class PriceSnapshotRepository
  extends BaseRepository<PriceSnapshotEntity> {}
