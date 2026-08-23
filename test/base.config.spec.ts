import 'reflect-metadata';

import { IsNumber, IsOptional } from 'class-validator';

import { BaseConfig } from '../src/config/base.config';

const VAR = 'TEST_NUMBER_VAR';

const STRING_VAR = 'TEST_STRING_VAR';

/**
 * A minimal concrete config. `BaseConfig` self-validates on construction and
 * class-validator rejects an object carrying no validation metadata at all
 * (`unknownValue`), so the probe needs one decorated property to be
 * instantiable — `asNumber` itself reads the environment per call, which is
 * what the cases below exercise.
 */
class NumberProbe extends BaseConfig {
  @IsNumber()
  @IsOptional()
  public readonly probe = this.asNumber(VAR);
}

let config: NumberProbe;

beforeEach(() => {
  delete process.env[VAR];
  delete process.env[STRING_VAR];
  config = new NumberProbe();
});

afterEach(() => {
  delete process.env[VAR];
  delete process.env[STRING_VAR];
});

describe('BaseConfig.asNumber', () => {
  it('reads a configured number', () => {
    process.env[VAR] = '2500';

    expect(config.asNumber(VAR, 100)).toBe(2500);
  });

  it('keeps a configured zero instead of treating it as unset', () => {
    /**
     * The regression this pins down: `0` is a value for several variables
     * (`SYNC_LOG_RETENTION_DAYS=0` means "keep every log file forever"), and
     * swapping it for the default silently did the opposite of what was asked.
     * A zero that is nonsense for its field is rejected by that field's own
     * validator, not here.
     */
    process.env[VAR] = '0';

    expect(config.asNumber(VAR, 30)).toBe(0);
  });

  it('reads negative and fractional values', () => {
    process.env[VAR] = '-5';

    expect(config.asNumber(VAR, 1)).toBe(-5);

    process.env[VAR] = '1.5';

    expect(config.asNumber(VAR, 1)).toBe(1.5);
  });

  it('falls back when the variable is unset', () => {
    expect(config.asNumber(VAR, 100)).toBe(100);
    expect(config.asNumber(VAR)).toBeUndefined();
  });

  it('falls back on an empty or blank value', () => {
    /**
     * Compose forwards a variable the host `.env` omits as an empty string, so
     * empty has to keep meaning "unset" — this is the case a bare
     * `Number(value)` would read as 0.
     */
    process.env[VAR] = '';

    expect(config.asNumber(VAR, 100)).toBe(100);

    process.env[VAR] = '   ';

    expect(config.asNumber(VAR, 100)).toBe(100);
  });

  it('falls back on a value that is not a finite number', () => {
    process.env[VAR] = 'abc';

    expect(config.asNumber(VAR, 100)).toBe(100);

    process.env[VAR] = 'Infinity';

    expect(config.asNumber(VAR, 100)).toBe(100);

    process.env[VAR] = '12abc';

    expect(config.asNumber(VAR, 100)).toBe(100);
  });
});

describe('BaseConfig.nonEmpty', () => {
  it('reads a configured value, trimmed', () => {
    process.env[STRING_VAR] = '  mailto:ops@example.com  ';

    expect(config.nonEmpty(STRING_VAR)).toBe('mailto:ops@example.com');
  });

  it('is undefined when the variable is unset', () => {
    expect(config.nonEmpty(STRING_VAR)).toBeUndefined();
  });

  it('is undefined on an empty or blank value', () => {
    /**
     * The regression this pins down: compose declares every forwarded
     * variable as `${NAME:-}`, so in a container the name is always defined
     * and holds an empty string when the host `.env` omits it. A plain
     * `asString(...) ?? default` therefore hands that empty string on and the
     * documented default becomes unreachable — which is how an empty
     * `PUSH_VAPID_SUBJECT` silently disabled web push in production.
     */
    process.env[STRING_VAR] = '';

    expect(config.nonEmpty(STRING_VAR)).toBeUndefined();

    process.env[STRING_VAR] = '   ';

    expect(config.nonEmpty(STRING_VAR)).toBeUndefined();
  });
});
