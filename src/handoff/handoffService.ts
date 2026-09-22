import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { VizzerConfig } from '../config';
import type { SessionController } from '../controller';
import { truncateText } from '../core/format';
import type { SessionView } from '../core/sessionView';
import { ClaudeCliError, resolveClaudeBinary, runClaudePrint } from './claudeCli';
import { buildDigest } from './digest';
import { writeHandoffFile } from './handoffFile';
import { handoffModelLabel } from './handoffModels';
import { CHARS_PER_TOKEN, HANDOFF_SYSTEM_PROMPT, buildContinuationPrompt, buildHandoffRequest } from './prompt';
import { launchClaudeSession } from './sessionLauncher';

/** Generous enough for the largest digest on the slowest model; the progress notification stays cancellable. */
const HANDOFF_TIMEOUT_MS = 300_000;
const ACTION_START_SESSION = 'Start new session';

export interface HandoffServiceDeps {
  controller: SessionController;
  /** Scratch directory the handoff model runs in, so it doesn't load the project's CLAUDE.md. */
  storageUri: vscode.Uri;
  getConfig: () => VizzerConfig;
  log: vscode.LogOutputChannel;
}

type ProgressReporter = vscode.Progress<{ message?: string; increment?: number }>;

/** Condense transcript → ask the handoff model → save to `.vizzer/handoffs` → open a new session. */
export class HandoffService {
  private generating = false;

  constructor(private readonly deps: HandoffServiceDeps) {}

  async createHandoff(sessionId?: string): Promise<void> {
    if (this.generating) {
      void vscode.window.showInformationMessage('Vizzer: a handoff is already being generated.');
      return;
    }
    const { controller } = this.deps;
    const session = sessionId ? controller.getView(sessionId) : controller.getActiveView();
    if (!session) {
      void vscode.window.showWarningMessage('Vizzer: no Claude Code session found for this workspace yet.');
      return;
    }
    const folder = workspaceFolderFor(session.cwd);
    if (!folder) {
      void vscode.window.showWarningMessage('Vizzer: open a folder so the handoff file has somewhere to go.');
      return;
    }

    this.generating = true;
    try {
      const filePath = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Vizzer: handing off "${truncateText(session.title, 40)}"`,
          cancellable: true,
        },
        (progress, token) => this.generate(session, folder, progress, token),
      );
      await this.presentHandoff(vscode.Uri.file(filePath));
    } catch (error) {
      this.reportError(error);
    } finally {
      this.generating = false;
    }
  }

  async startSessionFromHandoff(handoffUri?: vscode.Uri): Promise<void> {
    const uri = handoffUri ?? vscode.window.activeTextEditor?.document.uri;
    if (!uri || uri.scheme !== 'file') {
      void vscode.window.showWarningMessage('Vizzer: open a handoff file first.');
      return;
    }

    // Save pending edits so the new session reads what the user sees.
    const document = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri.toString());
    if (document?.isDirty) await document.save();

    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const relativePath = folder ? path.relative(folder.uri.fsPath, uri.fsPath) : uri.fsPath;
    const config = this.deps.getConfig();
    const target = await launchClaudeSession({
      prompt: buildContinuationPrompt(relativePath),
      cwd: folder?.uri.fsPath,
      preferred: config.handoff.openIn,
      resolveBinary: () => resolveClaudeBinary({ configuredPath: config.claudePath }).catch(() => undefined),
    });

    void vscode.window.showInformationMessage(
      target === 'claudeExtension'
        ? 'Vizzer: a new Claude Code tab has the handoff prompt pre-filled. Press Enter to start. The prompt is also on your clipboard.'
        : 'Vizzer: started claude in a terminal with the handoff prompt.',
    );
  }

  private async generate(
    session: SessionView,
    folder: vscode.WorkspaceFolder,
    progress: ProgressReporter,
    token: vscode.CancellationToken,
  ): Promise<string> {
    const config = this.deps.getConfig();
    const abort = new AbortController();
    const cancellation = token.onCancellationRequested(() => abort.abort());
    const throwIfCancelled = (): void => {
      if (token.isCancellationRequested) throw new ClaudeCliError('cancelled', 'Cancelled.');
    };

    try {
      progress.report({ message: 'Condensing the transcript…' });
      const digest = await buildDigest(session.filePath, config.handoff.maxDigestTokens * CHARS_PER_TOKEN);
      throwIfCancelled();

      progress.report({ message: 'Locating the claude CLI…' });
      const binary = await resolveClaudeBinary({ configuredPath: config.claudePath });
      throwIfCancelled();

      progress.report({ message: `Asking ${handoffModelLabel(config.handoff.model)} to write the handoff…` });
      const workDir = this.deps.storageUri.fsPath;
      await fs.mkdir(workDir, { recursive: true });
      const startedAt = Date.now();
      const result = await runClaudePrint({
        binary,
        model: config.handoff.model,
        prompt: buildHandoffRequest(
          {
            sessionId: session.id,
            title: session.title,
            modelLabel: session.modelLabel,
            contextTokens: session.contextTokens,
            cwd: session.cwd,
            gitBranch: session.gitBranch,
          },
          digest,
        ),
        systemPrompt: HANDOFF_SYSTEM_PROMPT,
        cwd: workDir,
        timeoutMs: HANDOFF_TIMEOUT_MS,
        signal: abort.signal,
      });
      const cost = result.costUsd !== undefined ? `, est. $${result.costUsd.toFixed(4)}` : '';
      this.deps.log.info(
        `Handoff for ${session.id} written by ${config.handoff.model} in ${Date.now() - startedAt} ms ` +
          `(digest ${digest.conversation.length} chars${digest.condensed ? ', condensed' : ''}${cost}).`,
      );

      progress.report({ message: 'Saving…' });
      return await writeHandoffFile(folder.uri.fsPath, result.text, {
        sessionId: session.id,
        title: session.title,
        model: session.modelId ?? session.modelLabel,
        contextTokens: session.contextTokens,
        generatedBy: `Vizzer (claude -p --model ${config.handoff.model})`,
        createdAt: new Date(),
      });
    } finally {
      cancellation.dispose();
    }
  }

  private async presentHandoff(uri: vscode.Uri): Promise<void> {
    await vscode.window.showTextDocument(uri, { preview: false });
    const choice = await vscode.window.showInformationMessage(
      'Vizzer: handoff ready. Review or edit it, then start a fresh session from it.',
      ACTION_START_SESSION,
    );
    if (choice === ACTION_START_SESSION) await this.startSessionFromHandoff(uri);
  }

  private reportError(error: unknown): void {
    if (error instanceof ClaudeCliError && error.code === 'cancelled') return;
    const message = error instanceof Error ? error.message : String(error);
    this.deps.log.error(`Handoff failed: ${message}`);

    if (error instanceof ClaudeCliError && error.code === 'not-found') {
      void vscode.window.showErrorMessage(`Vizzer: ${message}`, 'Open settings').then((choice) => {
        if (choice) void vscode.commands.executeCommand('workbench.action.openSettings', 'vizzer.claudePath');
      });
      return;
    }
    void vscode.window.showErrorMessage(`Vizzer: handoff failed. ${message}`, 'Show log').then((choice) => {
      if (choice) this.deps.log.show();
    });
  }
}

function workspaceFolderFor(cwd: string | undefined): vscode.WorkspaceFolder | undefined {
  if (cwd) {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(cwd));
    if (folder) return folder;
  }
  return vscode.workspace.workspaceFolders?.[0];
}
