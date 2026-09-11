import * as path from 'path';
import { isSameOrInside } from '../sessions/claudePaths';
import { parseLine } from '../transcript/parser';
import { JsonlTailReader } from '../transcript/tailReader';
import type { AssistantEvent, TranscriptEvent, UserPromptEvent } from '../transcript/types';

export interface TodoItem {
  content: string;
  status: string;
}

/** A condensed, model-friendly rendering of a session transcript. */
export interface TranscriptDigest {
  /** Chronological conversation text. */
  conversation: string;
  filesTouched: string[];
  todos: TodoItem[];
  userTurns: number;
  /** True when the middle of the conversation was condensed to fit the budget. */
  condensed: boolean;
}

export type DigestItemKind = 'user' | 'assistant' | 'tool' | 'summary';

export interface DigestItem {
  kind: DigestItemKind;
  text: string;
}

const ITEM_LIMITS: Record<DigestItemKind, number> = { user: 2_500, summary: 8_000, assistant: 1_500, tool: 200 };
const CONDENSED_USER_LIMIT = 300;
/** Budget shares: the start of the session (goal), condensed middle, and the rest for recent activity. */
const HEAD_SHARE = 0.15;
const MIDDLE_SHARE = 0.15;
const MAX_FILES_LISTED = 60;
const FILE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const TOOL_SUMMARY_KEYS = [
  'file_path',
  'notebook_path',
  'path',
  'command',
  'pattern',
  'url',
  'query',
  'description',
  'prompt',
  'skill',
];

/** Reads a transcript and condenses it to roughly `maxChars` characters. */
export async function buildDigest(filePath: string, maxChars: number): Promise<TranscriptDigest> {
  const { lines } = await new JsonlTailReader(filePath).readNew();
  const collector = new DigestCollector();
  for (const line of lines) {
    const event = parseLine(line);
    if (event) collector.add(event);
  }
  return collector.finish(maxChars);
}

/** Collects the parts of a main conversation that matter for a handoff. Subagent traffic is skipped. */
export class DigestCollector {
  private readonly items: DigestItem[] = [];
  private readonly files = new Set<string>();
  private readonly seenBlocks = new Set<string>();
  private todos: TodoItem[] = [];
  private cwd: string | undefined;
  private userTurns = 0;

  add(event: TranscriptEvent): void {
    if (event.kind === 'userPrompt') this.addUserPrompt(event);
    else if (event.kind === 'assistant') this.addAssistant(event);
  }

  finish(maxChars: number): TranscriptDigest {
    const { text, condensed } = fitToBudget(this.items, maxChars);
    const files = [...this.files].map((file) => this.relative(file));
    return {
      conversation: text,
      filesTouched: files.slice(-MAX_FILES_LISTED),
      todos: this.todos,
      userTurns: this.userTurns,
      condensed,
    };
  }

  private addUserPrompt(event: UserPromptEvent): void {
    if (event.isSidechain) return;
    this.cwd = event.cwd ?? this.cwd;
    if (event.isCompactSummary) {
      this.items.push({ kind: 'summary', text: event.text });
      return;
    }
    this.userTurns += 1;
    this.items.push({ kind: 'user', text: event.text });
  }

  private addAssistant(event: AssistantEvent): void {
    if (event.isSidechain) return;
    this.cwd = event.cwd ?? this.cwd;

    for (const block of event.blocks) {
      // Guard against transcripts that repeat a message's full content on every streamed entry.
      const signature =
        block.type === 'text' ? block.text.slice(0, 160) : `${block.name}${JSON.stringify(block.input).slice(0, 160)}`;
      const key = `${event.messageId}:${block.type}:${signature}`;
      if (this.seenBlocks.has(key)) continue;
      this.seenBlocks.add(key);

      if (block.type === 'text') {
        const text = block.text.trim();
        if (text) this.items.push({ kind: 'assistant', text });
        continue;
      }
      this.recordToolSideEffects(block.name, block.input);
      this.items.push({ kind: 'tool', text: this.summarizeTool(block.name, block.input) });
    }
  }

  private recordToolSideEffects(name: string, input: Record<string, unknown>): void {
    if (FILE_EDIT_TOOLS.has(name)) {
      const file = input.file_path ?? input.notebook_path;
      if (typeof file === 'string' && file) this.files.add(file);
    }
    if (name === 'TodoWrite') {
      const todos = parseTodos(input.todos);
      if (todos) this.todos = todos;
    }
  }

  private summarizeTool(name: string, input: Record<string, unknown>): string {
    for (const key of TOOL_SUMMARY_KEYS) {
      const value = input[key];
      if (typeof value !== 'string' || !value.trim()) continue;
      const argument = key.endsWith('path') ? this.relative(value) : value;
      return `→ ${name}: ${argument.replace(/\s+/g, ' ').trim()}`;
    }
    return `→ ${name}`;
  }

  private relative(filePath: string): string {
    if (!this.cwd || !path.isAbsolute(filePath) || !isSameOrInside(filePath, this.cwd)) return filePath;
    return path.relative(this.cwd, filePath) || filePath;
  }
}

export function renderItem(item: DigestItem, limit = ITEM_LIMITS[item.kind]): string {
  const body = clip(item.text, limit);
  switch (item.kind) {
    case 'user':
      return `[USER] ${body}`;
    case 'assistant':
      return `[CLAUDE] ${body}`;
    case 'summary':
      return `[SUMMARY OF EARLIER CONVERSATION]\n${body}`;
    case 'tool':
      return `  ${body}`;
  }
}

/**
 * Keeps the opening of the session (the goal) and as much recent activity as fits; the middle keeps
 * only abbreviated user requests. Returns the items unchanged when they already fit.
 */
export function fitToBudget(items: readonly DigestItem[], maxChars: number): { text: string; condensed: boolean } {
  const rendered = items.map((item) => renderItem(item));
  const total = rendered.reduce((sum, line) => sum + line.length + 1, 0);
  if (total <= maxChars) return { text: rendered.join('\n'), condensed: false };

  const headBudget = maxChars * HEAD_SHARE;
  const middleBudget = maxChars * MIDDLE_SHARE;
  const tailBudget = maxChars - headBudget - middleBudget;

  let headEnd = 0;
  let used = 0;
  while (headEnd < rendered.length && used + rendered[headEnd].length + 1 <= headBudget) {
    used += rendered[headEnd].length + 1;
    headEnd += 1;
  }

  let tailStart = rendered.length;
  used = 0;
  while (tailStart > headEnd && used + rendered[tailStart - 1].length + 1 <= tailBudget) {
    tailStart -= 1;
    used += rendered[tailStart].length + 1;
  }

  const middle: string[] = [];
  let omitted = 0;
  used = 0;
  for (let index = headEnd; index < tailStart; index += 1) {
    const item = items[index];
    if (item.kind === 'user' || item.kind === 'summary') {
      const line = renderItem(item, CONDENSED_USER_LIMIT);
      if (used + line.length + 1 <= middleBudget) {
        middle.push(line);
        used += line.length + 1;
        continue;
      }
    }
    omitted += 1;
  }

  const marker = `[… ${omitted} older item(s) omitted to fit the budget; user requests from this span are abbreviated …]`;
  return {
    text: [...rendered.slice(0, headEnd), marker, ...middle, ...rendered.slice(tailStart)].join('\n'),
    condensed: true,
  };
}

function parseTodos(value: unknown): TodoItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item): TodoItem[] => {
    if (typeof item !== 'object' || item === null) return [];
    const { content, status } = item as { content?: unknown; status?: unknown };
    return typeof content === 'string' && content
      ? [{ content, status: typeof status === 'string' ? status : 'pending' }]
      : [];
  });
}

function clip(text: string, limit: number): string {
  const normalized = text.replace(/\n{3,}/g, '\n\n').trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit).trimEnd()} … [${normalized.length - limit} more chars]`;
}
