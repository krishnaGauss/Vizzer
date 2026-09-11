import {
  addUsage,
  contextTokensOf,
  emptyUsage,
  type AssistantEvent,
  type EntryContext,
  type TitleSource,
  type TokenUsage,
  type TranscriptEvent,
  type UserPromptEvent,
} from './types';

/** A drop to below this fraction of the previous context size is treated as a compaction. */
const COMPACTION_DROP_RATIO = 0.5;
/** Drops from contexts smaller than this are ignored; small sessions fluctuate for unrelated reasons. */
const COMPACTION_MIN_TOKENS = 20_000;
const TITLE_PRIORITY: readonly TitleSource[] = ['custom', 'ai', 'summary'];

export interface ContextPoint {
  timestamp?: number;
  tokens: number;
}

export interface SessionStats {
  title?: string;
  firstPrompt?: string;
  model?: string;
  cwd?: string;
  gitBranch?: string;
  /** Tokens in the context window as of the latest main-conversation request. */
  contextTokens: number;
  peakContextTokens: number;
  /** Usage of the latest main-conversation request. */
  lastUsage: TokenUsage;
  /** Cumulative usage of the main conversation, counted once per API message. */
  totals: TokenUsage;
  /** Cumulative usage of subagents (sidechains). */
  subagentTotals: TokenUsage;
  assistantMessages: number;
  userTurns: number;
  lastActivity?: number;
  /** Context size after each main-conversation request, oldest first. */
  series: ContextPoint[];
  /** Indices into `series` at which the conversation was compacted. */
  compactions: number[];
}

interface MessageRecord {
  usage: TokenUsage;
  isSidechain: boolean;
}

/**
 * Folds transcript events into running session statistics. Events must be applied in file order.
 *
 * Claude Code writes one transcript entry per streamed content block, each repeating the message's
 * usage, so usage is tracked per API message id and later entries replace earlier ones.
 */
export class SessionAccumulator {
  private readonly messages = new Map<string, MessageRecord>();
  private readonly titles = new Map<TitleSource, string>();
  private readonly series: ContextPoint[] = [];
  private readonly compactions: number[] = [];
  private readonly totals = emptyUsage();
  private readonly subagentTotals = emptyUsage();
  private lastUsage = emptyUsage();
  private lastMainMessageId: string | undefined;
  private pendingCompaction = false;
  private peakContextTokens = 0;
  private mainMessages = 0;
  private userTurns = 0;
  private firstPrompt: string | undefined;
  private model: string | undefined;
  private cwd: string | undefined;
  private gitBranch: string | undefined;
  private lastActivity: number | undefined;

  apply(event: TranscriptEvent): void {
    switch (event.kind) {
      case 'assistant':
        this.applyAssistant(event);
        break;
      case 'userPrompt':
        this.applyUserPrompt(event);
        break;
      case 'toolResult':
        this.touch(event.timestamp);
        break;
      case 'title':
        this.titles.set(event.source, event.title);
        break;
      case 'compactBoundary':
        this.pendingCompaction = true;
        this.touch(event.timestamp);
        break;
    }
  }

  snapshot(): SessionStats {
    return {
      title: TITLE_PRIORITY.map((source) => this.titles.get(source)).find((title) => title !== undefined),
      firstPrompt: this.firstPrompt,
      model: this.model,
      cwd: this.cwd,
      gitBranch: this.gitBranch,
      contextTokens: contextTokensOf(this.lastUsage),
      peakContextTokens: this.peakContextTokens,
      lastUsage: { ...this.lastUsage },
      totals: { ...this.totals },
      subagentTotals: { ...this.subagentTotals },
      assistantMessages: this.mainMessages,
      userTurns: this.userTurns,
      lastActivity: this.lastActivity,
      series: this.series.map((point) => ({ ...point })),
      compactions: [...this.compactions],
    };
  }

  private applyAssistant(event: AssistantEvent): void {
    this.touch(event.timestamp);

    const previous = this.messages.get(event.messageId);
    if (previous) {
      addUsage(previous.isSidechain ? this.subagentTotals : this.totals, previous.usage, -1);
    } else if (!event.isSidechain) {
      this.mainMessages += 1;
    }
    this.messages.set(event.messageId, { usage: event.usage, isSidechain: event.isSidechain });
    addUsage(event.isSidechain ? this.subagentTotals : this.totals, event.usage);

    if (event.isSidechain) return;

    if (event.model) this.model = event.model;
    this.updateLocation(event);
    const tokens = contextTokensOf(event.usage);

    if (previous) {
      // A repeated entry for the latest message refines its usage; older repeats change nothing visible.
      if (event.messageId === this.lastMainMessageId) {
        this.series[this.series.length - 1].tokens = tokens;
        this.recordLatest(event.usage, tokens);
      }
      return;
    }

    const last = this.series[this.series.length - 1];
    const droppedSharply =
      last !== undefined && last.tokens >= COMPACTION_MIN_TOKENS && tokens < last.tokens * COMPACTION_DROP_RATIO;
    if (this.series.length > 0 && (this.pendingCompaction || droppedSharply)) {
      this.compactions.push(this.series.length);
    }
    this.pendingCompaction = false;
    this.series.push({ timestamp: event.timestamp, tokens });
    this.lastMainMessageId = event.messageId;
    this.recordLatest(event.usage, tokens);
  }

  private applyUserPrompt(event: UserPromptEvent): void {
    this.touch(event.timestamp);
    if (event.isSidechain) return;
    this.updateLocation(event);
    if (event.isCompactSummary) {
      this.pendingCompaction = true;
      return;
    }
    this.userTurns += 1;
    this.firstPrompt ??= event.text;
  }

  private recordLatest(usage: TokenUsage, tokens: number): void {
    this.lastUsage = usage;
    this.peakContextTokens = Math.max(this.peakContextTokens, tokens);
  }

  private updateLocation(context: EntryContext): void {
    if (context.cwd) this.cwd = context.cwd;
    if (context.gitBranch) this.gitBranch = context.gitBranch;
  }

  private touch(timestamp: number | undefined): void {
    if (timestamp !== undefined && (this.lastActivity === undefined || timestamp > this.lastActivity)) {
      this.lastActivity = timestamp;
    }
  }
}
