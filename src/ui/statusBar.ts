import * as vscode from 'vscode';
import { COMMANDS } from '../constants';
import type { SessionController } from '../controller';
import { formatPercent, formatRelativeTime, formatTokens } from '../core/format';
import type { UsageLevel } from '../core/levels';
import type { SessionView } from '../core/sessionView';
import { totalTokensOf, type TokenUsage } from '../transcript/types';

/** Keeps the "active 3m ago" text in the tooltip current while nothing else changes. */
const REFRESH_MS = 30_000;

const LEVEL_ICON: Record<UsageLevel, string> = { ok: '$(pulse)', warn: '$(warning)', critical: '$(flame)' };
const LEVEL_BACKGROUND: Record<UsageLevel, string | undefined> = {
  ok: undefined,
  warn: 'statusBarItem.warningBackground',
  critical: 'statusBarItem.errorBackground',
};
const USAGE_ROWS: ReadonlyArray<[label: string, key: keyof TokenUsage]> = [
  ['Fresh input', 'input'],
  ['Cache write', 'cacheWrite'],
  ['Cache read', 'cacheRead'],
  ['Output', 'output'],
];

/** Status bar item showing the focused session's model, context size and window usage. */
export class TokenStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly subscription: vscode.Disposable;
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly controller: SessionController) {
    this.item = vscode.window.createStatusBarItem('vizzer.context', vscode.StatusBarAlignment.Right, 100);
    this.item.name = 'Vizzer: Claude context';
    this.item.command = COMMANDS.showPanel;
    this.subscription = controller.onDidChange(() => this.render());
    this.timer = setInterval(() => this.render(), REFRESH_MS);
    this.render();
    this.item.show();
  }

  dispose(): void {
    clearInterval(this.timer);
    this.subscription.dispose();
    this.item.dispose();
  }

  private render(): void {
    const view = this.controller.getActiveView();
    if (!view) {
      this.item.text = '$(pulse) Vizzer';
      this.item.tooltip = 'Vizzer: no Claude Code sessions in this workspace yet.';
      this.item.backgroundColor = undefined;
      return;
    }

    this.item.text =
      `${LEVEL_ICON[view.level]} ${view.modelLabel} · ` +
      `${formatTokens(view.contextTokens)}/${formatTokens(view.contextWindow)} · ${formatPercent(view.percent)}`;
    const background = LEVEL_BACKGROUND[view.level];
    this.item.backgroundColor = background ? new vscode.ThemeColor(background) : undefined;
    this.item.tooltip = buildTooltip(view, this.controller.isFollowingLatest);
  }
}

function buildTooltip(view: SessionView, following: boolean): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = { enabledCommands: [COMMANDS.showPanel, COMMANDS.createHandoff, COMMANDS.selectSession] };

  md.appendMarkdown(`**${escapeMarkdown(view.title)}**\n\n`);
  md.appendMarkdown(
    `${escapeMarkdown(view.modelLabel)} · **${formatTokens(view.contextTokens)}** of ` +
      `${formatTokens(view.contextWindow)} context (${formatPercent(view.percent)})\n\n`,
  );
  md.appendMarkdown(`Each new message re-sends about ${formatTokens(view.contextTokens)} tokens.\n\n`);
  if (view.level !== 'ok' && view.reason) {
    md.appendMarkdown(`$(warning) This session is ${escapeMarkdown(view.reason)}.\n\n`);
  }

  md.appendMarkdown('| Tokens | Last request | Session |\n|:--|--:|--:|\n');
  for (const [label, key] of USAGE_ROWS) {
    md.appendMarkdown(`| ${label} | ${formatTokens(view.lastUsage[key])} | ${formatTokens(view.totals[key])} |\n`);
  }
  const subagentTokens = totalTokensOf(view.subagentTotals);
  if (subagentTokens > 0) md.appendMarkdown(`| Subagents | | ${formatTokens(subagentTokens)} |\n`);

  md.appendMarkdown(
    `\n${view.userTurns} prompts · active ${formatRelativeTime(view.lastActivity)} · ` +
      `${following ? 'following latest session' : 'pinned'}\n\n`,
  );
  md.appendMarkdown(
    `[$(graph) Open panel](command:${COMMANDS.showPanel}) · ` +
      `[$(arrow-swap) Create handoff](command:${COMMANDS.createHandoff}) · ` +
      `[$(list-selection) Switch session](command:${COMMANDS.selectSession})`,
  );
  return md;
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
