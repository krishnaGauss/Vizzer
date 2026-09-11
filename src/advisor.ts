import * as vscode from 'vscode';
import type { VizzerConfig } from './config';
import type { SessionController } from './controller';
import { truncateText } from './core/format';
import { compareLevels, type UsageLevel } from './core/levels';
import type { SessionView } from './core/sessionView';

const MUTED_SESSIONS_KEY = 'vizzer.mutedSessions';
const MAX_MUTED_SESSIONS = 200;
const SNOOZE_MS = 60 * 60 * 1000;
/** Only sessions that changed recently are "live" enough to warrant an interruption. */
const LIVE_SESSION_MS = 15 * 60 * 1000;

const ACTION_HANDOFF = 'Create handoff';
const ACTION_SNOOZE = 'Snooze 1 hour';
const ACTION_MUTE = "Don't warn for this session";

/**
 * Suggests a handoff once each time a live session moves into a higher usage level. Levels present
 * when the extension starts form the baseline, so reopening VS Code doesn't replay old warnings.
 */
export class ContextAdvisor implements vscode.Disposable {
  private readonly lastLevels = new Map<string, UsageLevel>();
  private readonly subscription: vscode.Disposable;
  private baselineTaken = false;
  private snoozedUntil = 0;

  constructor(
    private readonly controller: SessionController,
    private readonly getConfig: () => VizzerConfig,
    private readonly state: vscode.Memento,
    private readonly createHandoff: (sessionId: string) => Promise<void>,
  ) {
    this.subscription = controller.onDidChange(() => this.evaluate());
  }

  dispose(): void {
    this.subscription.dispose();
  }

  private evaluate(): void {
    const escalated: SessionView[] = [];
    for (const view of this.controller.getViews()) {
      const previous = this.lastLevels.get(view.id) ?? 'ok';
      this.lastLevels.set(view.id, view.level);
      if (this.baselineTaken && compareLevels(view.level, previous) > 0) escalated.push(view);
    }
    this.baselineTaken = true;

    for (const view of escalated) {
      if (this.shouldNotify(view)) void this.notify(view);
    }
  }

  private shouldNotify(view: SessionView): boolean {
    const now = Date.now();
    return (
      this.getConfig().notificationsEnabled &&
      now >= this.snoozedUntil &&
      now - view.lastActivity <= LIVE_SESSION_MS &&
      !this.mutedSessions().includes(view.id)
    );
  }

  private async notify(view: SessionView): Promise<void> {
    const subject = `Vizzer: "${truncateText(view.title, 50)}" is ${view.reason ?? 'getting large'}.`;
    const choice =
      view.level === 'critical'
        ? await vscode.window.showWarningMessage(
            `${subject} A handoff to a fresh session cuts the cost of every message.`,
            ACTION_HANDOFF,
            ACTION_SNOOZE,
            ACTION_MUTE,
          )
        : await vscode.window.showInformationMessage(
            `${subject} Consider a handoff at the next natural stopping point.`,
            ACTION_HANDOFF,
            ACTION_SNOOZE,
            ACTION_MUTE,
          );

    switch (choice) {
      case ACTION_HANDOFF:
        await this.createHandoff(view.id);
        break;
      case ACTION_SNOOZE:
        this.snoozedUntil = Date.now() + SNOOZE_MS;
        break;
      case ACTION_MUTE:
        await this.state.update(MUTED_SESSIONS_KEY, [...this.mutedSessions(), view.id].slice(-MAX_MUTED_SESSIONS));
        break;
    }
  }

  private mutedSessions(): string[] {
    return this.state.get<string[]>(MUTED_SESSIONS_KEY, []);
  }
}
