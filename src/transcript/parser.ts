import type {
  AssistantEvent,
  ContentBlock,
  EntryContext,
  TitleEvent,
  TitleSource,
  TokenUsage,
  ToolResultEvent,
  TranscriptEvent,
  UserPromptEvent,
} from './types';

type JsonRecord = Record<string, unknown>;

/** Model name Claude Code uses for locally generated messages (API errors, interruptions). */
const SYNTHETIC_MODEL = '<synthetic>';

/** Wrapper tags Claude Code injects into user messages that are not part of what the user typed. */
const INJECTED_TAGS = [
  'system-reminder',
  'local-command-stdout',
  'local-command-stderr',
  'local-command-caveat',
  'command-message',
  'ide_opened_file',
  'ide_selection',
  'ide_diagnostics',
];
const INJECTED_TAG_PATTERN = new RegExp(`<(${INJECTED_TAGS.join('|')})>[\\s\\S]*?</\\1>`, 'g');

/**
 * Parses one line of a Claude Code transcript (JSONL).
 *
 * Returns `null` for blank or malformed lines and for entry types Vizzer doesn't use. The transcript
 * format is not a public contract, so every field is treated as optional.
 */
export function parseLine(line: string): TranscriptEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    return parseEntry(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

export function parseEntry(raw: unknown): TranscriptEvent | null {
  if (!isRecord(raw)) return null;
  switch (raw.type) {
    case 'assistant':
      return parseAssistant(raw);
    case 'user':
      return parseUser(raw);
    case 'ai-title':
      return titleEvent(raw.aiTitle, 'ai');
    case 'custom-title':
      return titleEvent(raw.customTitle, 'custom');
    case 'summary':
      return titleEvent(raw.summary, 'summary');
    case 'system':
      return raw.subtype === 'compact_boundary'
        ? {
            kind: 'compactBoundary',
            timestamp: parseTimestamp(raw.timestamp),
            preTokens: isRecord(raw.compactMetadata) ? optionalCount(raw.compactMetadata.preTokens) : undefined,
          }
        : null;
    default:
      return null;
  }
}

/** Removes injected wrapper tags and rewrites slash-command markup into the command the user typed. */
export function cleanPromptText(text: string): string {
  const commandName = matchTag(text, 'command-name');
  if (commandName) {
    const args = matchTag(text, 'command-args');
    return args ? `${commandName} ${args}` : commandName;
  }
  return text.replace(INJECTED_TAG_PATTERN, '').trim();
}

function parseAssistant(raw: JsonRecord): AssistantEvent | null {
  const message = raw.message;
  if (!isRecord(message)) return null;

  const model = typeof message.model === 'string' ? message.model : '';
  if (model === SYNTHETIC_MODEL || raw.isApiErrorMessage === true) return null;

  const usage = parseUsage(message.usage);
  const messageId = firstString(message.id, raw.requestId, raw.uuid);
  if (!usage || !messageId) return null;

  return {
    kind: 'assistant',
    messageId,
    model,
    usage,
    blocks: parseBlocks(message.content),
    ...entryContext(raw),
  };
}

function parseUser(raw: JsonRecord): UserPromptEvent | ToolResultEvent | null {
  const message = raw.message;
  if (!isRecord(message)) return null;

  const context = entryContext(raw);
  const { content } = message;
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    if (content.some((block) => isRecord(block) && block.type === 'tool_result')) {
      return { kind: 'toolResult', ...context };
    }
    text = content
      .filter(isRecord)
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('\n');
  }

  // Meta entries are context Claude Code injects on the user's behalf (caveats, reminders).
  if (raw.isMeta === true) return null;

  const isCompactSummary = raw.isCompactSummary === true;
  const cleaned = isCompactSummary ? text.trim() : cleanPromptText(text);
  if (!cleaned) return null;

  return { kind: 'userPrompt', text: cleaned, isCompactSummary, ...context };
}

function parseBlocks(content: unknown): ContentBlock[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];

  const blocks: ContentBlock[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      blocks.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      blocks.push({ type: 'tool_use', name: block.name, input: isRecord(block.input) ? block.input : {} });
    }
  }
  return blocks;
}

function parseUsage(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null;
  return {
    input: count(value.input_tokens),
    cacheWrite: count(value.cache_creation_input_tokens),
    cacheRead: count(value.cache_read_input_tokens),
    output: count(value.output_tokens),
  };
}

function entryContext(raw: JsonRecord): EntryContext {
  return {
    timestamp: parseTimestamp(raw.timestamp),
    isSidechain: raw.isSidechain === true,
    cwd: optionalString(raw.cwd),
    gitBranch: optionalString(raw.gitBranch),
  };
}

function titleEvent(value: unknown, source: TitleSource): TitleEvent | null {
  const title = optionalString(value)?.trim();
  return title ? { kind: 'title', title, source } : null;
}

function matchTag(text: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  const value = match?.[1]?.trim();
  return value || undefined;
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function optionalCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
