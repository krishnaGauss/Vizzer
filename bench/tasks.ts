/**
 * The scripted coding task both benchmark arms perform on a copy of the Vizzer codebase. Later prompts
 * refer back to earlier work ("the helper we added"), so they only succeed if that context survives —
 * in the Vizzer arm it has to survive the handoff.
 */
export const TASKS: readonly string[] = [
  // 1
  'Read through the source in src/ (all layers) and give me a concise overview of the architecture: the layers, the key modules, and how data flows from a transcript file to the status bar.',
  // 2
  'In src/core/format.ts add a `formatDuration(ms: number): string` helper (examples: 950 -> "950ms", 12000 -> "12s", 185000 -> "3m 05s", 3720000 -> "1h 02m"). Add unit tests to test/format.test.ts and run them with `npx vitest run test/format.test.ts`.',
  // 3
  'Track when a session started: add a `firstActivity` timestamp to SessionStats in src/transcript/sessionAccumulator.ts (the earliest timestamp seen), with tests in test/sessionAccumulator.test.ts. Run those tests.',
  // 4
  'Expose the session length in SessionView (src/core/sessionView.ts) as `durationMs` (lastActivity minus firstActivity, 0 when unknown) and cover it in test/sessionView.test.ts.',
  // 5
  'Show the session length in the status bar tooltip (src/ui/statusBar.ts) using the formatDuration helper we just added, next to the prompt count.',
  // 6
  'Run the whole test suite (`npx vitest run`) and the typecheck (`npx tsc --noEmit -p .`), and fix anything that fails.',
  // 7
  'Before we move on, summarize what we have changed so far and what could come next.',
  // 8
  'Now show the session length in the sidebar card too: add it to the meta line in src/webview/main.ts, reusing the same helper as the status bar.',
  // 9
  'Add a `cacheHitRate` field to SessionView: cacheRead divided by all input tokens (input + cacheWrite + cacheRead) of the session totals, 0 when there are none. Add tests.',
  // 10
  'Show the cache hit rate as a percentage in the status bar tooltip, on the same line as the session length we added earlier.',
  // 11
  'Review every change we made in this session for edge cases (zero or missing timestamps, sessions with no tokens) and add any missing tests.',
  // 12
  'Run the full test suite and the typecheck again and fix any failures.',
  // 13
  'Update the Features section of README.md to mention the session length and cache hit rate.',
  // 14
  'Final check: list every function, field and file we added or changed in this session, with one line on why for each.',
];

/** The Vizzer arm hands off after this many turns. */
export const HANDOFF_AFTER_TURN = 7;

/** Identifiers the final summary (turn 14) should mention if the session remembers all of its work. */
export const RECALL_KEYWORDS: readonly string[] = [
  'formatDuration',
  'firstActivity',
  'durationMs',
  'cacheHitRate',
  'format.ts',
  'sessionAccumulator.ts',
  'sessionView.ts',
  'statusBar.ts',
  'main.ts',
  'README.md',
];
