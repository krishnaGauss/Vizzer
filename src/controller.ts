import * as vscode from 'vscode';
import type { VizzerConfig } from './config';
import { toSessionView, type SessionView } from './core/sessionView';
import type { SessionStore } from './sessions/sessionStore';

/**
 * Turns store records into UI-ready views and tracks which session the UI focuses on: the pinned
 * session if the user picked one, otherwise the most recently active session.
 */
export class SessionController implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  private readonly storeSubscription: { dispose(): void };
  private views: SessionView[] = [];
  private pinnedId: string | undefined;

  constructor(
    private readonly store: SessionStore,
    private readonly getConfig: () => VizzerConfig,
  ) {
    this.storeSubscription = store.onDidChange(() => this.rebuild());
  }

  /** Recomputes views, e.g. after a store change or a settings change. */
  rebuild(): void {
    const config = this.getConfig();
    const options = { thresholds: config.thresholds, contextWindowOverride: config.contextWindowOverride };
    this.views = this.store.getSessions().map((record) => toSessionView(record, options));
    if (this.pinnedId !== undefined && !this.getView(this.pinnedId)) this.pinnedId = undefined;
    this.changeEmitter.fire();
  }

  getViews(): readonly SessionView[] {
    return this.views;
  }

  getView(id: string): SessionView | undefined {
    return this.views.find((view) => view.id === id);
  }

  getActiveView(): SessionView | undefined {
    return (this.pinnedId !== undefined ? this.getView(this.pinnedId) : undefined) ?? this.views[0];
  }

  get isFollowingLatest(): boolean {
    return this.pinnedId === undefined;
  }

  pin(id: string): void {
    if (!this.getView(id) || this.pinnedId === id) return;
    this.pinnedId = id;
    this.changeEmitter.fire();
  }

  followLatest(): void {
    if (this.pinnedId === undefined) return;
    this.pinnedId = undefined;
    this.changeEmitter.fire();
  }

  dispose(): void {
    this.storeSubscription.dispose();
    this.changeEmitter.dispose();
  }
}
