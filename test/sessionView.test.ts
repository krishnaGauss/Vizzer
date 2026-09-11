import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS } from '../src/core/levels';
import { downsample, sessionTitle, toSessionView } from '../src/core/sessionView';
import type { SessionRecord } from '../src/sessions/types';
import { emptyUsage } from '../src/transcript/types';

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'abcdef123456',
    filePath: '/claude/projects/p/abcdef123456.jsonl',
    projectDir: '/claude/projects/p',
    mtime: 1_000,
    contextTokens: 0,
    peakContextTokens: 0,
    lastUsage: emptyUsage(),
    totals: emptyUsage(),
    subagentTotals: emptyUsage(),
    assistantMessages: 0,
    userTurns: 0,
    series: [],
    compactions: [],
    ...overrides,
  };
}

describe('toSessionView', () => {
  it('derives title, model label, window and level', () => {
    const view = toSessionView(
      record({
        model: 'claude-opus-5',
        firstPrompt: 'Build   the\nthing',
        contextTokens: 320_000,
        peakContextTokens: 320_000,
        series: [{ tokens: 1_000 }, { tokens: 320_000 }],
      }),
      { thresholds: DEFAULT_THRESHOLDS, contextWindowOverride: 0 },
    );

    expect(view).toMatchObject({
      title: 'Build the thing',
      modelLabel: 'Opus 5',
      contextWindow: 1_000_000,
      percent: 32,
      level: 'critical',
      lastActivity: 1_000,
      series: [1_000, 320_000],
    });
  });

  it('falls back to a short id when there is no title or prompt', () => {
    expect(sessionTitle({ id: 'abcdef123456' })).toBe('Session abcdef12');
  });
});

describe('downsample', () => {
  it('keeps short series unchanged', () => {
    expect(downsample([1, 2, 3], [1], 10)).toEqual({ points: [1, 2, 3], compactions: [1] });
  });

  it('keeps bucket peaks, the exact latest value and maps compaction markers', () => {
    const values = Array.from({ length: 1_000 }, (_, index) => index);
    values[999] = 5;
    const { points, compactions } = downsample(values, [500], 100);

    expect(points).toHaveLength(100);
    expect(points[0]).toBe(9);
    expect(points[98]).toBe(989);
    expect(points[99]).toBe(5);
    expect(compactions).toEqual([50]);
  });
});
