import { describe, expect, it } from 'vitest';
import { accumulate, aiTitle, assistant, compactBoundary, customTitle, userPrompt } from './helpers/transcript';

describe('SessionAccumulator', () => {
  it('uses the latest main-conversation request as the context size', () => {
    const stats = accumulate([
      userPrompt('start'),
      assistant({ input: 10, cacheWrite: 1_000, output: 50 }),
      assistant({ input: 5, cacheWrite: 200, cacheRead: 1_000, output: 80 }),
    ]);

    expect(stats.contextTokens).toBe(1_205);
    expect(stats.series.map((point) => point.tokens)).toEqual([1_010, 1_205]);
    expect(stats.peakContextTokens).toBe(1_205);
    expect(stats.assistantMessages).toBe(2);
    expect(stats.userTurns).toBe(1);
    expect(stats.totals).toEqual({ input: 15, cacheWrite: 1_200, cacheRead: 1_000, output: 130 });
  });

  it('counts streamed entries of one message once', () => {
    const stats = accumulate([
      assistant({ id: 'msg_a', input: 2, cacheRead: 5_000, output: 1 }),
      assistant({ id: 'msg_a', input: 2, cacheRead: 5_000, output: 10 }),
      assistant({ id: 'msg_a', input: 2, cacheRead: 5_000, output: 30 }),
    ]);

    expect(stats.totals).toEqual({ input: 2, cacheWrite: 0, cacheRead: 5_000, output: 30 });
    expect(stats.assistantMessages).toBe(1);
    expect(stats.series).toHaveLength(1);
    expect(stats.lastUsage.output).toBe(30);
  });

  it('keeps subagent traffic out of the context window', () => {
    const stats = accumulate([
      assistant({ input: 1_000 }),
      assistant({ input: 50_000, sidechain: true }),
    ]);

    expect(stats.contextTokens).toBe(1_000);
    expect(stats.totals.input).toBe(1_000);
    expect(stats.subagentTotals.input).toBe(50_000);
    expect(stats.series).toHaveLength(1);
    expect(stats.assistantMessages).toBe(1);
  });

  it('marks compactions from boundary entries and from sharp drops', () => {
    expect(
      accumulate([assistant({ cacheRead: 100_000 }), compactBoundary(), assistant({ input: 90_000 })]).compactions,
    ).toEqual([1]);
    expect(accumulate([assistant({ cacheRead: 100_000 }), assistant({ input: 30_000 })]).compactions).toEqual([1]);
    expect(accumulate([assistant({ input: 10_000 }), assistant({ input: 3_000 })]).compactions).toEqual([]);
  });

  it('treats the compaction summary as a boundary, not a user turn', () => {
    const stats = accumulate([
      userPrompt('first'),
      assistant({ cacheRead: 150_000 }),
      userPrompt('Summary of the conversation so far', { isCompactSummary: true }),
      assistant({ input: 120_000 }),
    ]);
    expect(stats.userTurns).toBe(1);
    expect(stats.compactions).toEqual([1]);
  });

  it('prefers custom titles, then AI titles, and keeps the first prompt', () => {
    const stats = accumulate([userPrompt('Refactor the parser please'), aiTitle('Parser refactor'), customTitle('My title')]);
    expect(stats.title).toBe('My title');
    expect(stats.firstPrompt).toBe('Refactor the parser please');

    expect(accumulate([aiTitle('Parser refactor')]).title).toBe('Parser refactor');
    expect(accumulate([userPrompt('hello')]).title).toBeUndefined();
  });

  it('tracks the current model and the latest activity', () => {
    const stats = accumulate([
      assistant({ model: 'claude-opus-5', timestamp: '2026-09-01T10:00:00.000Z' }),
      assistant({ model: 'claude-sonnet-5', timestamp: '2026-09-01T11:30:00.000Z' }),
    ]);
    expect(stats.model).toBe('claude-sonnet-5');
    expect(stats.lastActivity).toBe(Date.parse('2026-09-01T11:30:00.000Z'));
    expect(stats.cwd).toBe('/work/project');
    expect(stats.gitBranch).toBe('main');
  });
});
