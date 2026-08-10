import 'reflect-metadata';

import { DurationUtils, ErrorUtils } from '~utils';

describe('DurationUtils.format', () => {
  it('renders under a minute as seconds', () => {
    expect(DurationUtils.format(0)).toBe('0s');
    expect(DurationUtils.format(1499)).toBe('1s');
    expect(DurationUtils.format(30_000)).toBe('30s');
  });

  it('renders a minute and above with zero-padded seconds', () => {
    expect(DurationUtils.format(60_000)).toBe('1m 00s');
    expect(DurationUtils.format(90_000)).toBe('1m 30s');
    expect(DurationUtils.format(65_000)).toBe('1m 05s');
    expect(DurationUtils.format(1_120_000)).toBe('18m 40s');
  });
});

describe('ErrorUtils', () => {
  it('takes the message of an Error', () => {
    expect(ErrorUtils.text(new Error('boom'))).toBe('boom');
  });

  it('stringifies anything else that was thrown', () => {
    expect(ErrorUtils.text('plain string')).toBe('plain string');
    expect(ErrorUtils.text(42)).toBe('42');
    expect(ErrorUtils.text(null)).toBe('null');
  });

  it('returns the stack of an Error and null for the rest', () => {
    const stack = ErrorUtils.stack(new Error('boom'));

    expect(stack).toContain('Error: boom');
    expect(ErrorUtils.stack('no stack here')).toBeNull();
  });
});
