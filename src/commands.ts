import * as vscode from 'vscode';
import { CONFIG_SECTION } from './config';
import { COMMANDS, SESSIONS_VIEW_ID } from './constants';
import type { SessionController } from './controller';
import { formatPercent, formatRelativeTime, formatTokens } from './core/format';
import {
  DEFAULT_HANDOFF_MODEL,
  HANDOFF_MODEL_CHOICES,
  findHandoffModelChoice,
  handoffModelLabel,
} from './handoff/handoffModels';
import type { HandoffService } from './handoff/handoffService';
import type { SessionStore } from './sessions/sessionStore';

const HANDOFF_MODEL_SETTING = 'handoff.model';

export interface CommandDeps {
  controller: SessionController;
  handoff: HandoffService;
  store: SessionStore;
}

interface SessionPickItem extends vscode.QuickPickItem {
  sessionId?: string;
}

interface ModelPickItem extends vscode.QuickPickItem {
  /** The value to store; absent on the separator and on the "other model" entry. */
  alias?: string;
  custom?: boolean;
}

export function registerCommands({ controller, handoff, store }: CommandDeps): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(COMMANDS.showPanel, () =>
      vscode.commands.executeCommand(`${SESSIONS_VIEW_ID}.focus`),
    ),
    vscode.commands.registerCommand(COMMANDS.createHandoff, (sessionId?: unknown) =>
      handoff.createHandoff(typeof sessionId === 'string' ? sessionId : undefined),
    ),
    vscode.commands.registerCommand(COMMANDS.startSessionFromHandoff, (uri?: unknown) =>
      handoff.startSessionFromHandoff(uri instanceof vscode.Uri ? uri : undefined),
    ),
    vscode.commands.registerCommand(COMMANDS.selectHandoffModel, () => pickHandoffModel()),
    vscode.commands.registerCommand(COMMANDS.selectSession, () => pickSession(controller)),
    vscode.commands.registerCommand(COMMANDS.followLatest, () => controller.followLatest()),
    vscode.commands.registerCommand(COMMANDS.openTranscript, async (sessionId?: unknown) => {
      const view = typeof sessionId === 'string' ? controller.getView(sessionId) : controller.getActiveView();
      if (view) await vscode.window.showTextDocument(vscode.Uri.file(view.filePath), { preview: true });
    }),
    vscode.commands.registerCommand(COMMANDS.refresh, () => store.refresh()),
  ];
}

async function pickSession(controller: SessionController): Promise<void> {
  const views = controller.getViews();
  if (views.length === 0) {
    void vscode.window.showInformationMessage('Vizzer: no Claude Code sessions found for this workspace yet.');
    return;
  }

  const pinnedId = controller.isFollowingLatest ? undefined : controller.getActiveView()?.id;
  const items: SessionPickItem[] = [
    {
      label: '$(sync) Follow the most recent session',
      description: controller.isFollowingLatest ? 'current' : undefined,
    },
    { label: 'Sessions', kind: vscode.QuickPickItemKind.Separator },
    ...views.map(
      (view): SessionPickItem => ({
        label: `${view.id === pinnedId ? '$(pinned) ' : ''}${view.title}`,
        description: `${view.modelLabel} · ${formatTokens(view.contextTokens)} (${formatPercent(view.percent)})`,
        detail: `Active ${formatRelativeTime(view.lastActivity)} · ${view.userTurns} prompts`,
        sessionId: view.id,
      }),
    ),
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Vizzer: choose the session to display',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;
  if (picked.sessionId) controller.pin(picked.sessionId);
  else controller.followLatest();
}

/** Lets the user choose which model writes handoffs: Opus by default, or Sonnet, Haiku or a specific model ID. */
async function pickHandoffModel(): Promise<void> {
  const current = readHandoffModel();
  const currentChoice = findHandoffModelChoice(current);
  const items: ModelPickItem[] = [
    ...HANDOFF_MODEL_CHOICES.map(
      (choice): ModelPickItem => ({
        label: `${choice.alias === currentChoice?.alias ? '$(check) ' : ''}${choice.label}`,
        description: choice.alias === DEFAULT_HANDOFF_MODEL ? `${choice.description} · default` : choice.description,
        detail: choice.detail,
        alias: choice.alias,
      }),
    ),
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    {
      label: `${currentChoice ? '' : '$(check) '}$(edit) Other model…`,
      description: currentChoice ? undefined : current,
      detail: 'Use a specific model ID, e.g. claude-sonnet-5 or claude-haiku-4-5-20251001.',
      custom: true,
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Vizzer: model that writes handoffs',
    placeHolder: `Currently ${handoffModelLabel(current)}`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;

  const model = picked.custom ? await promptForModelId(current) : picked.alias;
  if (!model || model === current) return;

  await writeHandoffModel(model);
  void vscode.window.showInformationMessage(`Vizzer: handoffs will be written by ${handoffModelLabel(model)}.`);
}

function promptForModelId(current: string): Thenable<string | undefined> {
  return vscode.window.showInputBox({
    title: 'Vizzer: model that writes handoffs',
    prompt: 'Model alias (opus, sonnet, haiku) or a full model ID',
    value: current,
    validateInput: (value) => (value.trim() ? undefined : 'Enter a model alias or model ID.'),
  }).then((value) => value?.trim() || undefined);
}

function readHandoffModel(): string {
  const settings = vscode.workspace.getConfiguration(CONFIG_SECTION, vscode.workspace.workspaceFolders?.[0]?.uri);
  return settings.get<string>(HANDOFF_MODEL_SETTING, DEFAULT_HANDOFF_MODEL).trim() || DEFAULT_HANDOFF_MODEL;
}

/** Writes to the narrowest scope that already sets the model, so an existing workspace choice isn't shadowed. */
async function writeHandoffModel(model: string): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const settings = vscode.workspace.getConfiguration(CONFIG_SECTION, folder?.uri);
  const inspected = settings.inspect<string>(HANDOFF_MODEL_SETTING);

  const target =
    folder && inspected?.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : folder && inspected?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
  await settings.update(HANDOFF_MODEL_SETTING, model, target);
}
