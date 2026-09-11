// Builders for synthetic Claude Code transcript lines. Tests never read real session files.
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseLine } from '../../src/transcript/parser';
import { SessionAccumulator, type SessionStats } from '../../src/transcript/sessionAccumulator';

const BASE_TIME = Date.parse('2026-09-01T10:00:00.000Z');
const DEFAULT_CWD = '/work/project';
let sequence = 0;

function next(): number {
  sequence += 1;
  return sequence;
}

function timestamp(n: number): string {
  return new Date(BASE_TIME + n * 1000).toISOString();
}

export interface AssistantOptions {
  id?: string;
  model?: string;
  input?: number;
  cacheWrite?: number;
  cacheRead?: number;
  output?: number;
  sidechain?: boolean;
  content?: unknown[];
  cwd?: string;
  timestamp?: string;
}

export function assistant(options: AssistantOptions = {}): string {
  const n = next();
  return JSON.stringify({
    type: 'assistant',
    uuid: `uuid-${n}`,
    sessionId: 'test-session',
    isSidechain: options.sidechain ?? false,
    cwd: options.cwd ?? DEFAULT_CWD,
    gitBranch: 'main',
    timestamp: options.timestamp ?? timestamp(n),
    message: {
      id: options.id ?? `msg_${n}`,
      type: 'message',
      role: 'assistant',
      model: options.model ?? 'claude-opus-5',
      content: options.content ?? [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: options.input ?? 10,
        cache_creation_input_tokens: options.cacheWrite ?? 0,
        cache_read_input_tokens: options.cacheRead ?? 0,
        output_tokens: options.output ?? 5,
      },
    },
  });
}

export interface UserOptions {
  sidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  cwd?: string;
}

export function userPrompt(text: string, options: UserOptions = {}): string {
  const n = next();
  return JSON.stringify({
    type: 'user',
    uuid: `uuid-${n}`,
    isSidechain: options.sidechain ?? false,
    isMeta: options.isMeta,
    isCompactSummary: options.isCompactSummary,
    cwd: options.cwd ?? DEFAULT_CWD,
    gitBranch: 'main',
    timestamp: timestamp(n),
    message: { role: 'user', content: text },
  });
}

export function toolResult(): string {
  const n = next();
  return JSON.stringify({
    type: 'user',
    uuid: `uuid-${n}`,
    isSidechain: false,
    timestamp: timestamp(n),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }] },
  });
}

export function aiTitle(title: string): string {
  return JSON.stringify({ type: 'ai-title', aiTitle: title, sessionId: 'test-session' });
}

export function customTitle(title: string): string {
  return JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: 'test-session' });
}

export function compactBoundary(): string {
  const n = next();
  return JSON.stringify({
    type: 'system',
    subtype: 'compact_boundary',
    timestamp: timestamp(n),
    compactMetadata: { trigger: 'auto', preTokens: 180_000 },
  });
}

export function accumulate(lines: readonly string[]): SessionStats {
  const accumulator = new SessionAccumulator();
  for (const line of lines) {
    const event = parseLine(line);
    if (event) accumulator.apply(event);
  }
  return accumulator.snapshot();
}

export function makeTempDir(prefix = 'vizzer-test-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function writeLines(file: string, lines: readonly string[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, lines.map((line) => `${line}\n`).join(''), 'utf8');
}

export async function appendLines(file: string, lines: readonly string[]): Promise<void> {
  await fs.appendFile(file, lines.map((line) => `${line}\n`).join(''), 'utf8');
}
