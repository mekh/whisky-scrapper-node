import { TypeormRepository } from '@toxicoder/nestjs-typeorm-repository';

import { BaseRepository } from '~core/_common';

import { CountryEntity } from './country.entity';

@TypeormRepository(CountryEntity)
export class CountryRepository extends BaseRepository<CountryEntity> {}
