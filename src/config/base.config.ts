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

  /**
   * Reads a numeric variable.
   *
   * An unset, empty or blank value falls back to the default — compose
   * forwards a variable the host `.env` omits as an empty string, so empty has
   * to mean "unset" — and so does a value that is not a finite number, leaving
   * a typo to surface as the default rather than as `NaN`.
   *
   * A configured **`0` is a value, not an absence**: it is returned as such, so
   * a variable whose zero means something ("keep every file forever", "do not
   * retry") is honored, and one whose zero is nonsense is rejected by that
   * field's own validator instead of being silently swapped for the default.
   *
   * @param envName - The variable to read.
   * @param defaultValue - Value to fall back to.
   * @returns The configured number, or the default.
   */
  public asNumber(envName: string, defaultValue?: number): number | undefined {
    const env = this.asString(envName)?.trim();

    if (!env) {
      return defaultValue;
    }

    const parsed = Number(env);

    return Number.isFinite(parsed) ? parsed : defaultValue;
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
