import * as vscode from 'vscode';
import { DEFAULT_THRESHOLDS, type Thresholds } from './core/levels';

export const CONFIG_SECTION = 'vizzer';

export type LaunchTarget = 'claudeExtension' | 'terminal';

export interface VizzerConfig {
  thresholds: Thresholds;
  notificationsEnabled: boolean;
  /** 0 means "detect from the model". */
  contextWindowOverride: number;
  claudeConfigDir: string;
  claudePath: string;
  handoff: {
    model: string;
    maxDigestTokens: number;
    openIn: LaunchTarget;
  };
  sessions: {
    historyDays: number;
    maxSessions: number;
  };
}

const DEFAULT_HANDOFF_MODEL = 'haiku';
const DEFAULT_DIGEST_TOKENS = 60_000;
const DEFAULT_HISTORY_DAYS = 7;
const DEFAULT_MAX_SESSIONS = 25;

/** Reads and sanitizes the `vizzer.*` settings. Critical thresholds never sit below warning thresholds. */
export function readConfig(): VizzerConfig {
  const settings = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const warnTokens = positive(settings.get('thresholds.warnTokens'), DEFAULT_THRESHOLDS.warnTokens);
  const warnPercent = percent(settings.get('thresholds.warnPercent'), DEFAULT_THRESHOLDS.warnPercent);

  return {
    thresholds: {
      warnTokens,
      criticalTokens: Math.max(warnTokens, positive(settings.get('thresholds.criticalTokens'), DEFAULT_THRESHOLDS.criticalTokens)),
      warnPercent,
      criticalPercent: Math.max(warnPercent, percent(settings.get('thresholds.criticalPercent'), DEFAULT_THRESHOLDS.criticalPercent)),
    },
    notificationsEnabled: settings.get<boolean>('notifications.enabled', true),
    contextWindowOverride: Math.max(0, finite(settings.get('contextWindowOverride'), 0)),
    claudeConfigDir: settings.get<string>('claudeConfigDir', ''),
    claudePath: settings.get<string>('claudePath', ''),
    handoff: {
      model: settings.get<string>('handoff.model', DEFAULT_HANDOFF_MODEL).trim() || DEFAULT_HANDOFF_MODEL,
      maxDigestTokens: positive(settings.get('handoff.maxDigestTokens'), DEFAULT_DIGEST_TOKENS),
      openIn: settings.get('handoff.openIn') === 'terminal' ? 'terminal' : 'claudeExtension',
    },
    sessions: {
      historyDays: positive(settings.get('sessions.historyDays'), DEFAULT_HISTORY_DAYS),
      maxSessions: Math.round(positive(settings.get('sessions.maxSessions'), DEFAULT_MAX_SESSIONS)),
    },
  };
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function positive(value: unknown, fallback: number): number {
  const number = finite(value, fallback);
  return number > 0 ? number : fallback;
}

function percent(value: unknown, fallback: number): number {
  return Math.min(100, positive(value, fallback));
}
