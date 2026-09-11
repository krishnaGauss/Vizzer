import { formatTokens } from './format';

export type UsageLevel = 'ok' | 'warn' | 'critical';

export interface Thresholds {
  /** Tokens re-sent per message at which to warn. */
  warnTokens: number;
  criticalTokens: number;
  /** Percent of the context window at which to warn. */
  warnPercent: number;
  criticalPercent: number;
}

export interface LevelAssessment {
  level: UsageLevel;
  percent: number;
  /** Why the level isn't `ok`, phrased to follow "This session is …". */
  reason?: string;
}

export const DEFAULT_THRESHOLDS: Readonly<Thresholds> = Object.freeze({
  warnTokens: 150_000,
  criticalTokens: 300_000,
  warnPercent: 60,
  criticalPercent: 80,
});

const LEVEL_RANK: Record<UsageLevel, number> = { ok: 0, warn: 1, critical: 2 };

export function compareLevels(a: UsageLevel, b: UsageLevel): number {
  return LEVEL_RANK[a] - LEVEL_RANK[b];
}

/**
 * Rates a session by both the absolute tokens re-sent with every message (what drives cost) and the
 * share of the context window used (what drives compaction); whichever is worse wins.
 */
export function assessContext(contextTokens: number, contextWindow: number, thresholds: Thresholds): LevelAssessment {
  const percent = contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0;
  const level = levelFor(contextTokens, percent, thresholds);
  if (level === 'ok') return { level, percent };

  const tokenLimit = level === 'critical' ? thresholds.criticalTokens : thresholds.warnTokens;
  const reason =
    contextTokens >= tokenLimit
      ? `re-sending ${formatTokens(contextTokens)} tokens with every message`
      : `using ${Math.round(percent)}% of its ${formatTokens(contextWindow)} context window`;
  return { level, percent, reason };
}

function levelFor(tokens: number, percent: number, t: Thresholds): UsageLevel {
  if (tokens >= t.criticalTokens || percent >= t.criticalPercent) return 'critical';
  if (tokens >= t.warnTokens || percent >= t.warnPercent) return 'warn';
  return 'ok';
}
