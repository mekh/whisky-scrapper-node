import { TypeormRepository } from '@toxicoder/nestjs-typeorm-repository';

import { BaseRepository } from '~core/_common';

import { FlavorEntity } from './flavor.entity';

@TypeormRepository(FlavorEntity)
export class FlavorRepository extends BaseRepository<FlavorEntity> {}
