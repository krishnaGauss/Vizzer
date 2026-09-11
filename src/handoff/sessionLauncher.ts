import * as vscode from 'vscode';
import type { LaunchTarget } from '../config';

export const CLAUDE_CODE_EXTENSION_ID = 'anthropic.claude-code';
const TERMINAL_NAME = 'Claude (Vizzer handoff)';

export interface LaunchOptions {
  prompt: string;
  cwd?: string;
  preferred: LaunchTarget;
  /** Only called when falling back to a terminal. */
  resolveBinary: () => Promise<string | undefined>;
}

/**
 * Starts a new Claude Code session seeded with `prompt` and returns where it opened. The prompt is
 * also copied to the clipboard as a fallback.
 */
export async function launchClaudeSession(options: LaunchOptions): Promise<LaunchTarget> {
  await vscode.env.clipboard.writeText(options.prompt);

  if (options.preferred === 'claudeExtension' && vscode.extensions.getExtension(CLAUDE_CODE_EXTENSION_ID)) {
    // Claude Code's documented URI handler opens a new tab with the prompt pre-filled but not sent.
    // `uriScheme` keeps this working in VS Code forks (cursor://, windsurf://, …).
    const uri = vscode.Uri.parse(
      `${vscode.env.uriScheme}://${CLAUDE_CODE_EXTENSION_ID}/open?prompt=${encodeURIComponent(options.prompt)}`,
    );
    if (await vscode.env.openExternal(uri)) return 'claudeExtension';
  }

  const binary = (await options.resolveBinary()) ?? 'claude';
  const terminal = vscode.window.createTerminal({ name: TERMINAL_NAME, cwd: options.cwd });
  terminal.show();
  terminal.sendText(`${commandFor(binary)} ${quoteArgument(options.prompt)}`);
  return 'terminal';
}

function commandFor(binary: string): string {
  // Windows shells disagree on how to invoke a quoted path, so fall back to PATH lookup there.
  if (process.platform === 'win32') return /\s/.test(binary) ? 'claude' : binary;
  return quoteArgument(binary);
}

function quoteArgument(value: string): string {
  if (process.platform === 'win32') return `"${value.replace(/"/g, '""')}"`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
