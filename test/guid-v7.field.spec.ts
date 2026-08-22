import 'reflect-metadata';

import { validate } from 'class-validator';

import { GuidV7 } from '~decorators/fields';
import type { ID } from '~types';

const VALID = '019ff1bf-5e59-7d17-b699-b4ea1c8183ab' as ID;

class OneId {
  @GuidV7()
  public id!: ID;
}

class ManyIds {
  @GuidV7({ each: true })
  public ids!: ID[];
}

/**
 * Builds an instance without going through a constructor, the way the
 * `ValidationPipe` hands class-transformer output to the validator.
 *
 * @param type - The class to instantiate.
 * @param values - Field values to assign.
 * @returns The populated instance.
 */
function make<T extends object>(
  type: new() => T,
  values: Partial<T>,
): T {
  return Object.assign(new type(), values);
}

describe('GuidV7 — single value', () => {
  it('accepts a uuid v7', async () => {
    const errors = await validate(make(OneId, { id: VALID }));

    expect(errors).toHaveLength(0);
  });

  it('rejects a non-uuid', async () => {
    const errors = await validate(make(OneId, { id: 'nope' as ID }));

    expect(errors).toHaveLength(1);
  });
});

describe('GuidV7 — { each: true }', () => {
  it('accepts an array of uuids', async () => {
    /**
     * The regression this pins: the decorator used to drop `validationOptions`
     * on the floor, so `IsUUID` validated the array itself and every
     * list-valued field answered "must be a UUID" whatever it held.
     */
    const errors = await validate(make(ManyIds, { ids: [VALID, VALID] }));

    expect(errors).toHaveLength(0);
  });

  it('accepts an empty array', async () => {
    const errors = await validate(make(ManyIds, { ids: [] }));

    expect(errors).toHaveLength(0);
  });

  it('rejects an array holding a non-uuid', async () => {
    const errors = await validate(
      make(ManyIds, { ids: [VALID, 'nope' as ID] }),
    );

    expect(errors).toHaveLength(1);
    expect(Object.values(errors[0].constraints ?? {}).join()).toContain('each');
  });

  it('rejects a bare value where a list is expected', async () => {
    const errors = await validate(make(ManyIds, { ids: VALID as never }));

    expect(errors).toHaveLength(1);
  });
});
