import { describe, expect, it } from 'vitest';
import { formatPercent, formatRelativeTime, formatTokens, truncateText } from '../src/core/format';

describe('formatTokens', () => {
  it.each([
    [0, '0'],
    [950, '950'],
    [1_000, '1k'],
    [9_500, '9.5k'],
    [9_960, '10k'],
    [182_340, '182k'],
    [999_600, '1M'],
    [1_000_000, '1M'],
    [1_234_567, '1.23M'],
    [12_500_000, '12.5M'],
  ])('%d → %s', (value, expected) => {
    expect(formatTokens(value)).toBe(expected);
  });
});

describe('formatPercent', () => {
  it('rounds and flags tiny non-zero values', () => {
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(0.4)).toBe('<1%');
    expect(formatPercent(55.6)).toBe('56%');
  });
});

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-09-11T12:00:00.000Z');

  it('describes elapsed time compactly', () => {
    expect(formatRelativeTime(now - 10_000, now)).toBe('just now');
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m ago');
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe('2d ago');
    expect(formatRelativeTime(undefined, now)).toBe('unknown');
  });
});

describe('truncateText', () => {
  it('collapses whitespace and adds an ellipsis when cut', () => {
    expect(truncateText('hello   world\n', 20)).toBe('hello world');
    expect(truncateText('abcdefghij', 5)).toBe('abcd…');
  });
});
