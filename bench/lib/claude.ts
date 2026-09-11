import { execFileSync, spawn } from 'child_process';
import * as path from 'path';

/** Tools benchmark sessions may use without prompting; file edits are auto-accepted. */
const ALLOWED_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'Edit',
  'Write',
  'Bash(npx vitest:*)',
  'Bash(npx tsc:*)',
  'Bash(npm test:*)',
  'Bash(npm run:*)',
  'Bash(ls:*)',
];

export interface TurnOptions {
  binary: string;
  cwd: string;
  model: string;
  prompt: string;
  sessionId: string;
  /** False for the first turn of a session (creates it with `--session-id`). */
  resume: boolean;
  timeoutMs: number;
  maxBudgetUsd: number;
}

export interface TurnResult {
  sessionId: string;
  text: string;
  isError: boolean;
  subtype: string;
  /** Claude Code's client-side estimate at list prices. */
  costUsd: number;
  durationMs: number;
  /** API round trips Claude Code made for this prompt. */
  apiTurns: number;
  models: string[];
}

/** Runs one prompt in a headless Claude Code session. The prompt goes on stdin. */
export function runTurn(options: TurnOptions): Promise<TurnResult> {
  const args = [
    '-p',
    '--model',
    options.model,
    '--output-format',
    'json',
    '--permission-mode',
    'acceptEdits',
    // Keep the user's MCP servers out of the experiment (and out of reach of the sessions).
    '--strict-mcp-config',
    '--max-budget-usd',
    String(options.maxBudgetUsd),
    options.resume ? '--resume' : '--session-id',
    options.sessionId,
    // Variadic, so it goes last.
    '--allowedTools',
    ...ALLOWED_TOOLS,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(options.binary, args, {
      cwd: options.cwd,
      env: { ...process.env, PATH: [path.dirname(options.binary), process.env.PATH ?? ''].join(path.delimiter) },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`turn timed out after ${Math.round(options.timeoutMs / 1000)}s`));
    }, options.timeoutMs);

    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        resolve(parseTurnResult(stdout));
      } catch {
        reject(new Error(`claude exited with code ${code}: ${(stderr || stdout).slice(-800)}`));
      }
    });
    child.stdin.end(options.prompt);
  });
}

export function claudeVersion(binary: string): string {
  try {
    return execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function parseTurnResult(stdout: string): TurnResult {
  const result = JSON.parse(stdout.trim()) as Record<string, unknown>;
  const modelUsage = result.modelUsage;
  return {
    sessionId: typeof result.session_id === 'string' ? result.session_id : '',
    text: typeof result.result === 'string' ? result.result : '',
    isError: result.is_error === true,
    subtype: typeof result.subtype === 'string' ? result.subtype : '',
    costUsd: numberOrZero(result.total_cost_usd),
    durationMs: numberOrZero(result.duration_ms),
    apiTurns: numberOrZero(result.num_turns),
    models: typeof modelUsage === 'object' && modelUsage !== null ? Object.keys(modelUsage) : [],
  };
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
