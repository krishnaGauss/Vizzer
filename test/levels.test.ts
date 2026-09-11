import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS, assessContext, compareLevels } from '../src/core/levels';

describe('assessContext', () => {
  const thresholds = DEFAULT_THRESHOLDS;

  it('is ok below every threshold', () => {
    expect(assessContext(50_000, 1_000_000, thresholds)).toEqual({ level: 'ok', percent: 5 });
  });

  it('warns on absolute tokens even when a large window is mostly empty', () => {
    const result = assessContext(160_000, 1_000_000, thresholds);
    expect(result.level).toBe('warn');
    expect(result.reason).toBe('re-sending 160k tokens with every message');
  });

  it('escalates by window share for small windows', () => {
    expect(assessContext(130_000, 200_000, thresholds)).toMatchObject({
      level: 'warn',
      reason: 'using 65% of its 200k context window',
    });
    expect(assessContext(170_000, 200_000, thresholds)).toMatchObject({
      level: 'critical',
      reason: 'using 85% of its 200k context window',
    });
  });

  it('turns critical at the critical token threshold', () => {
    expect(assessContext(320_000, 1_000_000, thresholds)).toMatchObject({
      level: 'critical',
      reason: 're-sending 320k tokens with every message',
    });
  });
});

describe('compareLevels', () => {
  it('orders levels by severity', () => {
    expect(compareLevels('critical', 'warn')).toBeGreaterThan(0);
    expect(compareLevels('ok', 'warn')).toBeLessThan(0);
    expect(compareLevels('warn', 'warn')).toBe(0);
  });
});
