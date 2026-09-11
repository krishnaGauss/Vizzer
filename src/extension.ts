import * as vscode from 'vscode';
import { ContextAdvisor } from './advisor';
import { registerCommands } from './commands';
import { CONFIG_SECTION, readConfig, type VizzerConfig } from './config';
import { SessionController } from './controller';
import { HandoffService } from './handoff/handoffService';
import { resolveClaudeConfigDir } from './sessions/claudePaths';
import { SessionStore, type SessionStoreOptions } from './sessions/sessionStore';
import { SessionsViewProvider } from './ui/sidebarProvider';
import { TokenStatusBar } from './ui/statusBar';

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Vizzer', { log: true });
  let config = readConfig();
  const getConfig = (): VizzerConfig => config;

  const store = new SessionStore({
    ...storeOptions(config),
    onError: (error) => log.warn(`Session scan failed: ${describeError(error)}`),
  });
  const controller = new SessionController(store, getConfig);
  const handoff = new HandoffService({ controller, storageUri: context.globalStorageUri, getConfig, log });
  const sidebar = new SessionsViewProvider(context.extensionUri, controller, getConfig);

  context.subscriptions.push(
    log,
    store,
    controller,
    sidebar,
    new TokenStatusBar(controller),
    new ContextAdvisor(controller, getConfig, context.workspaceState, (sessionId) => handoff.createHandoff(sessionId)),
    vscode.window.registerWebviewViewProvider(SessionsViewProvider.viewId, sidebar),
    ...registerCommands({ controller, handoff, store }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(CONFIG_SECTION)) return;
      config = readConfig();
      controller.rebuild();
      void store.updateOptions(storeOptions(config));
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void store.updateOptions(storeOptions(config))),
  );

  store.start().then(
    () => log.info(`Watching ${store.getProjectDirs().length} Claude Code project folder(s) for this workspace.`),
    (error: unknown) => log.error(`Vizzer failed to start: ${describeError(error)}`),
  );
}

function storeOptions(config: VizzerConfig): Omit<SessionStoreOptions, 'onError'> {
  return {
    claudeConfigDir: resolveClaudeConfigDir(config.claudeConfigDir),
    workspacePaths: (vscode.workspace.workspaceFolders ?? [])
      .filter((folder) => folder.uri.scheme === 'file')
      .map((folder) => folder.uri.fsPath),
    historyDays: config.sessions.historyDays,
    maxSessions: config.sessions.maxSessions,
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
