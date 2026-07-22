import { validateSync } from 'class-validator';

import { ConfigurationError } from '~/errors';

type Enum =
  | Record<string, string>
  | Record<string, number>
  | string[]
  | number[];

type EnumValue<T extends Enum> = T extends Record<string, infer V> ? V
  : T extends (infer V)[] ? V
  : never;

export class BaseConfig {
  public constructor() {
    setImmediate(() => {
      this.validate();
    });
  }

  public get env(): Record<string, string | undefined> {
    return process.env;
  }

  public asNumber(envName: string, defaultValue?: number): number | undefined {
    const env = this.env[envName];

    return env && Number(env) ? Number(env) : defaultValue;
  }

  public asString(envName: string, defaultValue?: string): string | undefined {
    return this.env[envName] ?? defaultValue;
  }

  public asEnum<T extends Enum>(
    envName: string,
    enumType: T,
  ): EnumValue<T> | undefined {
    const env = this.asString(envName);
    if (!env) {
      return undefined;
    }

    const values: string[] | number[] = Array.isArray(enumType)
      ? enumType
      : Object.values(enumType);

    if (values.length === 0) {
      throw new ConfigurationError(`Invalid enum: ${envName}`);
    }

    for (const value of values) {
      if (typeof value === 'string' && value === env) {
        return env as EnumValue<T>;
      }

      if (typeof value === 'number' && value === Number(env)) {
        return Number(env) as EnumValue<T>;
      }
    }
  }

  public asBoolean(envName: string): boolean | undefined {
    const value = this.asString(envName);

    return value && ['true', 'false'].includes(value)
      ? value === 'true'
      : undefined;
  }

  public asArray(envName: string): string[] | undefined {
    return this.env[envName]
      ? this.env[envName].split(',')
      : undefined;
  }

  protected validate(): void {
    const errors = validateSync(this);
    if (!errors.length) {
      return;
    }

    throw new ConfigurationError(`Invalid configuration: ${errors.join('\n')}`);
  }
}
