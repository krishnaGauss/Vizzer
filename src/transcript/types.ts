/** Token counts the Anthropic API reports for a single assistant message. */
export interface TokenUsage {
  /** Uncached input tokens. */
  input: number;
  /** Input tokens written to the prompt cache. */
  cacheWrite: number;
  /** Input tokens served from the prompt cache. */
  cacheRead: number;
  /** Generated output tokens. */
  output: number;
}

export function emptyUsage(): TokenUsage {
  return { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
}

/** Tokens occupying the context window for a request: every input category, excluding output. */
export function contextTokensOf(usage: TokenUsage): number {
  return usage.input + usage.cacheWrite + usage.cacheRead;
}

export function totalTokensOf(usage: TokenUsage): number {
  return contextTokensOf(usage) + usage.output;
}

/** Adds (or with `sign = -1`, subtracts) `delta` into `target` in place. */
export function addUsage(target: TokenUsage, delta: TokenUsage, sign: 1 | -1 = 1): void {
  target.input += sign * delta.input;
  target.cacheWrite += sign * delta.cacheWrite;
  target.cacheRead += sign * delta.cacheRead;
  target.output += sign * delta.output;
}

export function sumUsage(items: readonly TokenUsage[]): TokenUsage {
  const total = emptyUsage();
  for (const item of items) addUsage(total, item);
  return total;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: Record<string, unknown> };

/** Fields shared by conversation entries. */
export interface EntryContext {
  timestamp?: number;
  /** True for subagent (sidechain) traffic, which doesn't occupy the main context window. */
  isSidechain: boolean;
  cwd?: string;
  gitBranch?: string;
}

export interface AssistantEvent extends EntryContext {
  kind: 'assistant';
  messageId: string;
  model: string;
  usage: TokenUsage;
  blocks: ContentBlock[];
}

export interface UserPromptEvent extends EntryContext {
  kind: 'userPrompt';
  text: string;
  /** The synthetic user message Claude Code inserts after compacting a conversation. */
  isCompactSummary: boolean;
}

export interface ToolResultEvent extends EntryContext {
  kind: 'toolResult';
}

export type TitleSource = 'custom' | 'ai' | 'summary';

export interface TitleEvent {
  kind: 'title';
  title: string;
  source: TitleSource;
}

export interface CompactBoundaryEvent {
  kind: 'compactBoundary';
  timestamp?: number;
  preTokens?: number;
}

export type TranscriptEvent =
  | AssistantEvent
  | UserPromptEvent
  | ToolResultEvent
  | TitleEvent
  | CompactBoundaryEvent;
