import type { SessionRecord } from '../sessions/types';
import type { TokenUsage } from '../transcript/types';
import { truncateText } from './format';
import { assessContext, type Thresholds, type UsageLevel } from './levels';
import { describeModel, resolveContextWindow } from './models';

export const MAX_CHART_POINTS = 120;
const TITLE_FROM_PROMPT_LENGTH = 60;

/** Everything the UI needs to render one session; plain data so it can be posted to a webview. */
export interface SessionView {
  id: string;
  title: string;
  modelId?: string;
  modelLabel: string;
  contextTokens: number;
  contextWindow: number;
  percent: number;
  level: UsageLevel;
  reason?: string;
  peakContextTokens: number;
  lastUsage: TokenUsage;
  totals: TokenUsage;
  subagentTotals: TokenUsage;
  userTurns: number;
  assistantMessages: number;
  lastActivity: number;
  cwd?: string;
  gitBranch?: string;
  filePath: string;
  /** Context tokens per response, downsampled for charting. */
  series: number[];
  /** Indices into `series` where the conversation was compacted. */
  compactions: number[];
}

export interface ViewOptions {
  thresholds: Thresholds;
  contextWindowOverride: number;
  maxPoints?: number;
}

export function toSessionView(record: SessionRecord, options: ViewOptions): SessionView {
  const contextWindow = resolveContextWindow(record.model, record.peakContextTokens, options.contextWindowOverride);
  const assessment = assessContext(record.contextTokens, contextWindow, options.thresholds);
  const chart = downsample(
    record.series.map((point) => point.tokens),
    record.compactions,
    options.maxPoints ?? MAX_CHART_POINTS,
  );

  return {
    id: record.id,
    title: sessionTitle(record),
    modelId: record.model,
    modelLabel: describeModel(record.model).label,
    contextTokens: record.contextTokens,
    contextWindow,
    percent: assessment.percent,
    level: assessment.level,
    reason: assessment.reason,
    peakContextTokens: record.peakContextTokens,
    lastUsage: record.lastUsage,
    totals: record.totals,
    subagentTotals: record.subagentTotals,
    userTurns: record.userTurns,
    assistantMessages: record.assistantMessages,
    lastActivity: record.lastActivity ?? record.mtime,
    cwd: record.cwd,
    gitBranch: record.gitBranch,
    filePath: record.filePath,
    series: chart.points,
    compactions: chart.compactions,
  };
}

export function sessionTitle(record: Pick<SessionRecord, 'id' | 'title' | 'firstPrompt'>): string {
  if (record.title) return record.title;
  if (record.firstPrompt) return truncateText(record.firstPrompt, TITLE_FROM_PROMPT_LENGTH);
  return `Session ${record.id.slice(0, 8)}`;
}

/**
 * Reduces a series to at most `maxPoints` buckets, keeping each bucket's peak (so pre-compaction highs
 * stay visible) and the exact latest value (so the chart ends at the current context size).
 */
export function downsample(
  values: readonly number[],
  markers: readonly number[],
  maxPoints: number,
): { points: number[]; compactions: number[] } {
  if (values.length <= maxPoints) return { points: [...values], compactions: [...markers] };

  const bucketSize = Math.ceil(values.length / maxPoints);
  const points: number[] = [];
  for (let start = 0; start < values.length; start += bucketSize) {
    points.push(Math.max(...values.slice(start, start + bucketSize)));
  }
  points[points.length - 1] = values[values.length - 1];
  const compactions = [...new Set(markers.map((index) => Math.floor(index / bucketSize)))];
  return { points, compactions };
}
