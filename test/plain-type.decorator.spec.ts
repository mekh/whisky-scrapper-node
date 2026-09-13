import 'reflect-metadata';

import { IsString } from 'class-validator';

import { ValidateResponse } from '~decorators/http';
import { Plain } from '~decorators/types';
import { Resource } from '~enums';

/**
 * Metadata key `@nestjs/swagger` writes the documented responses onto.
 */
const API_RESPONSE_METADATA = 'swagger/apiResponse';

/**
 * The response type a converted handler must come back as an instance of.
 */
class Row {
  @IsString()
  public name!: string;
}

/**
 * What every handler below returns: a plain object, never an instance.
 */
const PAYLOAD = { name: 'ok', secret: 'leaked' };

/**
 * A controller stating nothing, which must keep converting.
 */
class SilentRoutes {
  /**
   * A handler carrying no flag of its own.
   *
   * @returns The raw payload, for the decorator to convert.
   */
  @Plain(Row, Resource.AUTHENTICATED)
  public handler(): Promise<object> {
    return Promise.resolve(PAYLOAD);
  }

  /**
   * A handler with nothing to convert.
   *
   * @returns Undefined.
   */
  @Plain(Row, Resource.AUTHENTICATED)
  public empty(): Promise<object | undefined> {
    return Promise.resolve(undefined);
  }
}

/**
 * A controller opting out wholesale, with one handler opting back in.
 */
@ValidateResponse(false)
class OptedOutRoutes {
  /**
   * A handler inheriting the controller's opt-out.
   *
   * @returns The raw payload, which must reach the caller unconverted.
   */
  @Plain(Row, Resource.AUTHENTICATED)
  public handler(): Promise<object> {
    return Promise.resolve(PAYLOAD);
  }

  /**
   * A handler overriding it, written above `@Plain` so the flag lands on the
   * wrapper rather than on the handler `@Plain` wrapped.
   *
   * @returns The raw payload, which must be converted.
   */
  @ValidateResponse()
  @Plain(Row, Resource.AUTHENTICATED)
  public above(): Promise<object> {
    return Promise.resolve(PAYLOAD);
  }

  /**
   * The same override written below `@Plain`, so the flag lands on the
   * original handler and reaches the wrapper through `copyMeta`.
   *
   * @returns The raw payload, which must be converted.
   */
  @Plain(Row, Resource.AUTHENTICATED)
  @ValidateResponse()
  public below(): Promise<object> {
    return Promise.resolve(PAYLOAD);
  }
}

/**
 * A controller converting explicitly, with one handler opting out.
 */
@ValidateResponse()
class ConvertingRoutes {
  /**
   * A handler overriding its controller the other way round.
   *
   * @returns The raw payload, which must reach the caller unconverted.
   */
  @ValidateResponse(false)
  @Plain(Row, Resource.AUTHENTICATED)
  public lax(): Promise<object> {
    return Promise.resolve(PAYLOAD);
  }
}

describe('Plain — a route stating nothing', () => {
  it('converts the handler result into a DTO instance', async () => {
    const result = await new SilentRoutes().handler();

    expect(result).toBeInstanceOf(Row);
    expect(result).toMatchObject({ name: 'ok' });
  });

  it('passes an empty result straight through', async () => {
    const result = await new SilentRoutes().empty();

    expect(result).toBeUndefined();
  });
});

describe('Plain — a route opting out', () => {
  it('returns the handler result untouched', async () => {
    const result = await new OptedOutRoutes().handler();

    expect(result).not.toBeInstanceOf(Row);
    expect(result).toEqual(PAYLOAD);
  });

  it('still documents the response for the OpenAPI schema', () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      OptedOutRoutes.prototype,
      'handler',
    );

    const responses = Reflect.getMetadata(
      API_RESPONSE_METADATA,
      descriptor?.value as object,
    ) as Record<string, unknown>;

    expect(responses).toHaveProperty('200');
  });
});

describe('Plain — the handler outranks its controller', () => {
  it('converts a handler that opts back in above the decorator', async () => {
    const result = await new OptedOutRoutes().above();

    expect(result).toBeInstanceOf(Row);
  });

  it('converts a handler that opts back in below the decorator', async () => {
    const result = await new OptedOutRoutes().below();

    expect(result).toBeInstanceOf(Row);
  });

  it('skips a handler opting out inside a converting class', async () => {
    const result = await new ConvertingRoutes().lax();

    expect(result).not.toBeInstanceOf(Row);
    expect(result).toEqual(PAYLOAD);
  });
});
