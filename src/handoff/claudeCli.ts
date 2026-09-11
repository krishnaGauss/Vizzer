import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { constants as fsConstants, promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { expandHome } from '../sessions/claudePaths';
import type { TokenUsage } from '../transcript/types';

export type ClaudeCliErrorCode = 'not-found' | 'failed' | 'timeout' | 'cancelled' | 'invalid-output';

export class ClaudeCliError extends Error {
  constructor(
    readonly code: ClaudeCliErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ClaudeCliError';
  }
}

export interface ResolveBinaryOptions {
  configuredPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  /** Ask the user's login shell as a last resort (GUI-launched editors often miss shell PATH entries). */
  useLoginShell?: boolean;
}

const LOGIN_SHELL_TIMEOUT_MS = 4_000;
const ERROR_DETAIL_CHARS = 600;

/** Locates the `claude` CLI: explicit setting, then PATH, then common install locations, then the login shell. */
export async function resolveClaudeBinary(options: ResolveBinaryOptions = {}): Promise<string> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();

  const configured = options.configuredPath?.trim();
  if (configured) {
    const candidate = expandHome(configured, home);
    if (await isExecutableFile(candidate, platform)) return candidate;
    throw new ClaudeCliError('not-found', `"vizzer.claudePath" is set to "${configured}", which is not an executable file.`);
  }

  const names = platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude'];
  const pathDirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of [...pathDirs, ...commonInstallDirs(home, platform, env)]) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (await isExecutableFile(candidate, platform)) return candidate;
    }
  }

  if (platform !== 'win32' && options.useLoginShell !== false) {
    const fromShell = await lookupViaLoginShell(env);
    if (fromShell) return fromShell;
  }

  throw new ClaudeCliError(
    'not-found',
    'Could not find the `claude` CLI. Install Claude Code (https://code.claude.com/docs/en/setup) or set "vizzer.claudePath".',
  );
}

export interface ClaudePrintOptions {
  binary: string;
  model: string;
  /** Sent on stdin. */
  prompt: string;
  systemPrompt: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export interface ClaudePrintResult {
  text: string;
  costUsd?: number;
  durationMs?: number;
  usage?: TokenUsage;
}

/**
 * Arguments for a one-shot, tool-less, non-persisted `claude -p` run. The run authenticates with the
 * user's existing Claude Code login and doesn't create a session transcript.
 */
export function buildPrintArgs(model: string, systemPrompt: string): string[] {
  return [
    '-p',
    '--model',
    model,
    '--output-format',
    'json',
    '--no-session-persistence',
    '--tools',
    '',
    '--strict-mcp-config',
    '--system-prompt',
    systemPrompt,
  ];
}

export function runClaudePrint(options: ClaudePrintOptions): Promise<ClaudePrintResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new ClaudeCliError('cancelled', 'Cancelled.'));
      return;
    }

    const child = spawnClaude(options.binary, buildPrintArgs(options.model, options.systemPrompt), {
      cwd: options.cwd,
      env: withBinaryOnPath(options.env ?? process.env, options.binary),
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const settle = (error: Error | undefined, result?: ClaudePrintResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(result as ClaudePrintResult);
    };
    const onAbort = (): void => {
      child.kill();
      settle(new ClaudeCliError('cancelled', 'Cancelled.'));
    };
    const timer = setTimeout(() => {
      child.kill();
      settle(new ClaudeCliError('timeout', `claude did not respond within ${Math.round(options.timeoutMs / 1000)}s.`));
    }, options.timeoutMs);

    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (error) => settle(new ClaudeCliError('failed', `Could not start claude: ${error.message}`)));
    child.on('close', (code) => {
      try {
        settle(undefined, parsePrintOutput(stdout, code, stderr));
      } catch (error) {
        settle(error as Error);
      }
    });
    // An early exit closes stdin; the failure is reported through 'close' instead.
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.prompt);
  });
}

/** Interprets the JSON printed by `claude -p --output-format json`. */
export function parsePrintOutput(stdout: string, exitCode: number | null, stderr = ''): ClaudePrintResult {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout.trim());
  } catch {
    const detail = tail(stderr.trim() || stdout.trim());
    throw new ClaudeCliError('failed', `claude exited with code ${exitCode ?? 'unknown'}${detail ? `: ${detail}` : ''}`);
  }

  const result = Array.isArray(payload)
    ? [...payload].reverse().find((entry) => isRecord(entry) && entry.type === 'result')
    : payload;
  if (!isRecord(result)) throw new ClaudeCliError('invalid-output', 'claude returned output Vizzer could not read.');

  const text = typeof result.result === 'string' ? result.result.trim() : '';
  if (result.is_error === true || exitCode !== 0) {
    throw new ClaudeCliError('failed', text || tail(stderr.trim()) || `claude exited with code ${exitCode ?? 'unknown'}.`);
  }
  if (!text) throw new ClaudeCliError('invalid-output', 'claude returned an empty response.');

  return {
    text,
    costUsd: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : undefined,
    durationMs: typeof result.duration_ms === 'number' ? result.duration_ms : undefined,
    usage: parseUsage(result.usage),
  };
}

function parseUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  const count = (field: unknown): number => (typeof field === 'number' && Number.isFinite(field) ? field : 0);
  return {
    input: count(value.input_tokens),
    cacheWrite: count(value.cache_creation_input_tokens),
    cacheRead: count(value.cache_read_input_tokens),
    output: count(value.output_tokens),
  };
}

function spawnClaude(
  binary: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): ChildProcessWithoutNullStreams {
  // Windows npm shims (.cmd) can only be launched through a shell, which needs explicit quoting.
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary)) {
    return spawn(quoteForCmd(binary), args.map(quoteForCmd), { ...options, shell: true, windowsHide: true });
  }
  return spawn(binary, args, { ...options, windowsHide: true });
}

function quoteForCmd(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** npm-installed CLIs run via `#!/usr/bin/env node`; make sure the sibling `node` is reachable. */
function withBinaryOnPath(env: NodeJS.ProcessEnv, binary: string): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  const current = env[key] ?? '';
  return { ...env, [key]: [path.dirname(binary), current].filter(Boolean).join(path.delimiter) };
}

function commonInstallDirs(home: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const dirs = [
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'local'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
  ];
  if (platform === 'darwin') dirs.push('/opt/homebrew/bin', '/usr/local/bin');
  if (platform === 'linux') dirs.push('/usr/local/bin', '/usr/bin');
  if (platform === 'win32' && env.APPDATA) dirs.push(path.join(env.APPDATA, 'npm'));
  return dirs;
}

async function isExecutableFile(candidate: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const stat = await fs.stat(candidate);
    if (!stat.isFile()) return false;
    if (platform !== 'win32') await fs.access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function lookupViaLoginShell(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const shell = env.SHELL || '/bin/sh';
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(shell, ['-lc', 'command -v claude'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => {
      child.kill();
      resolve(undefined);
    }, LOGIN_SHELL_TIMEOUT_MS);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const found = output.trim().split('\n').pop()?.trim();
      resolve(found && path.isAbsolute(found) ? found : undefined);
    });
  });
}

function tail(text: string): string {
  return text.length > ERROR_DETAIL_CHARS ? `…${text.slice(-ERROR_DETAIL_CHARS)}` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
