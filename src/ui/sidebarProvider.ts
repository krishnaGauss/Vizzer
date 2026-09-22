import * as vscode from 'vscode';
import type { VizzerConfig } from '../config';
import { COMMANDS, EXTENSION_ID, SESSIONS_VIEW_ID } from '../constants';
import type { SessionController } from '../controller';
import { renderWebviewHtml } from './webviewHtml';
import type { HostToWebviewMessage } from './webviewProtocol';

/** Coalesces bursts of transcript writes (streaming responses) into one webview update. */
const POST_THROTTLE_MS = 250;

/** Sidebar webview listing the workspace's sessions with a detailed card for the focused one. */
export class SessionsViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = SESSIONS_VIEW_ID;

  private view: vscode.WebviewView | undefined;
  private postTimer: NodeJS.Timeout | undefined;
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: SessionController,
    private readonly getConfig: () => VizzerConfig,
  ) {
    this.subscription = controller.onDidChange(() => this.schedulePost());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media'), vscode.Uri.joinPath(this.extensionUri, 'dist')],
    };
    view.webview.html = renderWebviewHtml(view.webview, this.extensionUri);
    view.webview.onDidReceiveMessage((message: unknown) => this.handleMessage(message));
    view.onDidChangeVisibility(() => {
      if (view.visible) this.post();
    });
    view.onDidDispose(() => {
      this.view = undefined;
    });
  }

  dispose(): void {
    if (this.postTimer) clearTimeout(this.postTimer);
    this.subscription.dispose();
  }

  private handleMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null) return;
    const { type, id } = message as { type?: unknown; id?: unknown };
    const sessionId = typeof id === 'string' ? id : undefined;

    switch (type) {
      case 'ready':
        this.post();
        break;
      case 'select':
        if (sessionId) this.controller.pin(sessionId);
        break;
      case 'follow':
        this.controller.followLatest();
        break;
      case 'handoff':
        void vscode.commands.executeCommand(COMMANDS.createHandoff, sessionId);
        break;
      case 'openTranscript':
        void vscode.commands.executeCommand(COMMANDS.openTranscript, sessionId);
        break;
      case 'selectHandoffModel':
        void vscode.commands.executeCommand(COMMANDS.selectHandoffModel);
        break;
      case 'openSettings':
        void vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${EXTENSION_ID}`);
        break;
    }
  }

  private schedulePost(): void {
    if (this.postTimer) return;
    this.postTimer = setTimeout(() => {
      this.postTimer = undefined;
      this.post();
    }, POST_THROTTLE_MS);
  }

  private post(): void {
    if (!this.view?.visible) return;
    const message: HostToWebviewMessage = {
      type: 'state',
      state: {
        sessions: [...this.controller.getViews()],
        activeId: this.controller.getActiveView()?.id,
        following: this.controller.isFollowingLatest,
        thresholds: this.getConfig().thresholds,
        handoffModel: this.getConfig().handoff.model,
      },
    };
    void this.view.webview.postMessage(message);
  }
}
