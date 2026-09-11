/** Shape of `bench/results/*.json`, shared by the runner and the chart generator. */

export interface TurnMetrics {
  turn: number;
  /** 1 for the original session, 2 for the session started after the handoff. */
  segment: number;
  sessionId: string;
  /** Context tokens of the last API request in the turn. */
  contextEnd: number;
  /** API requests made during the turn (main conversation). */
  requests: number;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  /** input + cacheWrite + cacheRead + output for the turn, subagents included. */
  tokensProcessed: number;
  costUsd: number;
  durationMs: number;
  isError: boolean;
  compactionsSoFar: number;
  models: string[];
}

export interface HandoffMetrics {
  afterTurn: number;
  sourceSessionId: string;
  newSessionId: string;
  contextBefore: number;
  digestChars: number;
  digestCondensed: boolean;
  handoffChars: number;
  /** Tokens the handoff model processed (input + cache + output). */
  tokensProcessed: number;
  costUsd: number;
  durationMs: number;
  file: string;
  /** Context of the first request in the new session. */
  contextAfter?: number;
}

export interface Verification {
  tests: { ok: boolean; summary: string };
  typecheck: { ok: boolean; summary: string };
}

export interface ArmResult {
  label: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  error?: string;
  turns: TurnMetrics[];
  /** Context tokens of every main-conversation API request, in order. */
  requests: Array<{ turn: number; tokens: number }>;
  handoff?: HandoffMetrics;
  verification?: Verification;
  recall?: { found: string[]; missing: string[] };
  finalAnswer?: string;
  wallMs?: number;
}

export interface BenchmarkResults {
  version: 1;
  startedAt: string;
  finishedAt?: string;
  environment: {
    claudeVersion: string;
    model: string;
    handoffModel: string;
    node: string;
    platform: string;
  };
  tasks: readonly string[];
  handoffAfterTurn: number;
  arms: {
    baseline: ArmResult;
    vizzer: ArmResult;
  };
}

export interface OverheadSample {
  sizeMb: number;
  fileBytes: number;
  loadMs: number;
  cpuMs: number;
  heapMb: number;
  rssMb: number;
  idleScanMs: number;
  updateLatencyMedianMs: number;
  updateLatencyP95Ms: number;
}

export interface OverheadResults {
  generatedAt: string;
  node: string;
  platform: string;
  samples: OverheadSample[];
}
