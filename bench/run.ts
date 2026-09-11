/**
 * Token benchmark: the same 14-turn coding task, run once as a single long session ("baseline") and
 * once with a Vizzer handoff into a fresh session partway through ("vizzer"). Both arms run in
 * parallel in isolated copies of this repository. Results go to bench/results/.
 *
 *   npm run bench:run [-- --work-dir <dir>]
 *
 * This runs real Claude Code sessions and consumes usage on your plan.
 */
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveClaudeBinary, runClaudePrint } from '../src/handoff/claudeCli';
import { buildDigest } from '../src/handoff/digest';
import { writeHandoffFile } from '../src/handoff/handoffFile';
import {
  CHARS_PER_TOKEN,
  HANDOFF_SYSTEM_PROMPT,
  buildContinuationPrompt,
  buildHandoffRequest,
} from '../src/handoff/prompt';
import { describeModel } from '../src/core/models';
import { resolveClaudeConfigDir } from '../src/sessions/claudePaths';
import { emptyUsage, type TokenUsage } from '../src/transcript/types';
import { claudeVersion, runTurn } from './lib/claude';
import { measureSession, tokensProcessed, usageDelta } from './lib/measure';
import type { ArmResult, BenchmarkResults } from './lib/results';
import { createWorkspace, runCheck } from './lib/workspace';
import { HANDOFF_AFTER_TURN, RECALL_KEYWORDS, TASKS } from './tasks';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RESULTS_DIR = path.join(REPO_ROOT, 'bench', 'results');
const MODEL = process.env.VIZZER_BENCH_MODEL ?? 'claude-sonnet-5';
const HANDOFF_MODEL = 'haiku';
const TURN_TIMEOUT_MS = 15 * 60_000;
const HANDOFF_TIMEOUT_MS = 3 * 60_000;
const MAX_BUDGET_PER_TURN_USD = 5;
/** Same budget the extension uses by default (`vizzer.handoff.maxDigestTokens`). */
const DIGEST_MAX_CHARS = 60_000 * CHARS_PER_TOKEN;

interface RunContext {
  binary: string;
  configDir: string;
  results: BenchmarkResults;
  save: () => Promise<void>;
}

/** Drives the turns of one arm and records per-turn metrics from the session transcript. */
class ArmRunner {
  sessionId = randomUUID();
  private started = false;
  private segment = 1;
  private previousUsage: TokenUsage = emptyUsage();
  private previousRequests = 0;

  constructor(
    private readonly name: 'baseline' | 'vizzer',
    readonly workspace: string,
    private readonly ctx: RunContext,
  ) {}

  get arm(): ArmResult {
    return this.ctx.results.arms[this.name];
  }

  async turn(turn: number, prompt: string): Promise<string> {
    const result = await runTurn({
      binary: this.ctx.binary,
      cwd: this.workspace,
      model: MODEL,
      prompt,
      sessionId: this.sessionId,
      resume: this.started,
      timeoutMs: TURN_TIMEOUT_MS,
      maxBudgetUsd: MAX_BUDGET_PER_TURN_USD,
    });
    this.started = true;

    const measured = await measureSession(this.ctx.configDir, this.workspace, this.sessionId);
    const newRequests = measured.stats.series.slice(this.previousRequests);
    const delta = usageDelta(measured.allUsage, this.previousUsage);
    this.previousUsage = measured.allUsage;
    this.previousRequests = measured.stats.series.length;

    this.arm.requests.push(...newRequests.map((point) => ({ turn, tokens: point.tokens })));
    this.arm.turns.push({
      turn,
      segment: this.segment,
      sessionId: this.sessionId,
      contextEnd: measured.stats.contextTokens,
      requests: newRequests.length,
      ...delta,
      tokensProcessed: tokensProcessed(delta),
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      isError: result.isError,
      compactionsSoFar: measured.stats.compactions.length,
      models: result.models,
    });
    await this.ctx.save();
    log(
      this.name,
      `turn ${turn}/${TASKS.length}: context ${kilo(measured.stats.contextTokens)}, ` +
        `+${kilo(tokensProcessed(delta))} processed, $${result.costUsd.toFixed(3)}, ${Math.round(result.durationMs / 1000)}s` +
        (result.isError ? ` [error: ${result.subtype}]` : ''),
    );
    return result.text;
  }

  startNewSession(): void {
    this.sessionId = randomUUID();
    this.started = false;
    this.segment += 1;
    this.previousUsage = emptyUsage();
    this.previousRequests = 0;
  }
}

async function main(): Promise<void> {
  const workRoot = argValue('--work-dir') ?? path.join(os.tmpdir(), `vizzer-bench-${Date.now()}`);
  const binary = await resolveClaudeBinary();
  const configDir = resolveClaudeConfigDir();
  await fs.mkdir(RESULTS_DIR, { recursive: true });

  const results: BenchmarkResults = {
    version: 1,
    startedAt: new Date().toISOString(),
    environment: {
      claudeVersion: claudeVersion(binary),
      model: MODEL,
      handoffModel: HANDOFF_MODEL,
      node: process.version,
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    },
    tasks: TASKS,
    handoffAfterTurn: HANDOFF_AFTER_TURN,
    arms: {
      baseline: emptyArm('Without Vizzer (one long session)'),
      vizzer: emptyArm(`With Vizzer (handoff after turn ${HANDOFF_AFTER_TURN})`),
    },
  };
  const runFile = path.join(RESULTS_DIR, `run-${results.startedAt.replace(/[:.]/g, '-')}.json`);
  let pendingSave = Promise.resolve();
  const save = (): Promise<void> => {
    const snapshot = `${JSON.stringify(results, null, 2)}\n`;
    pendingSave = pendingSave.then(async () => {
      await fs.writeFile(runFile, snapshot);
      await fs.writeFile(path.join(RESULTS_DIR, 'latest.json'), snapshot);
    });
    return pendingSave;
  };

  log('setup', `claude ${results.environment.claudeVersion}, model ${MODEL}, work dir ${workRoot}`);
  const ctx: RunContext = { binary, configDir, results, save };
  const baseline = new ArmRunner('baseline', await createWorkspace(REPO_ROOT, path.join(workRoot, 'baseline')), ctx);
  const vizzer = new ArmRunner('vizzer', await createWorkspace(REPO_ROOT, path.join(workRoot, 'vizzer')), ctx);

  await Promise.all([runArm(baseline, runBaseline), runArm(vizzer, (runner) => runWithVizzer(runner, ctx, workRoot))]);

  results.finishedAt = new Date().toISOString();
  await save();
  log('done', `results written to ${path.relative(REPO_ROOT, runFile)} and bench/results/latest.json`);
}

async function runArm(runner: ArmRunner, body: (runner: ArmRunner) => Promise<string>): Promise<void> {
  const started = Date.now();
  runner.arm.status = 'running';
  try {
    const finalAnswer = await body(runner);
    runner.arm.finalAnswer = finalAnswer;
    runner.arm.recall = {
      found: RECALL_KEYWORDS.filter((keyword) => finalAnswer.includes(keyword)),
      missing: RECALL_KEYWORDS.filter((keyword) => !finalAnswer.includes(keyword)),
    };
    runner.arm.verification = {
      tests: await runCheck(runner.workspace, 'npx', ['vitest', 'run']),
      typecheck: await runCheck(runner.workspace, 'npx', ['tsc', '--noEmit', '-p', '.']),
    };
    runner.arm.status = 'done';
  } catch (error) {
    runner.arm.status = 'failed';
    runner.arm.error = error instanceof Error ? error.message : String(error);
    log(runner.arm.label, `FAILED: ${runner.arm.error}`);
  }
  runner.arm.wallMs = Date.now() - started;
}

async function runBaseline(runner: ArmRunner): Promise<string> {
  let answer = '';
  for (let index = 0; index < TASKS.length; index += 1) answer = await runner.turn(index + 1, TASKS[index]);
  return answer;
}

async function runWithVizzer(runner: ArmRunner, ctx: RunContext, workRoot: string): Promise<string> {
  for (let index = 0; index < HANDOFF_AFTER_TURN; index += 1) await runner.turn(index + 1, TASKS[index]);

  // The same pipeline as the extension's "Create handoff" command.
  const before = await measureSession(ctx.configDir, runner.workspace, runner.sessionId);
  const digest = await buildDigest(before.transcriptPath, DIGEST_MAX_CHARS);
  const scratch = path.join(workRoot, 'handoff-scratch');
  await fs.mkdir(scratch, { recursive: true });
  const startedAt = Date.now();
  const written = await runClaudePrint({
    binary: ctx.binary,
    model: HANDOFF_MODEL,
    prompt: buildHandoffRequest(
      {
        sessionId: runner.sessionId,
        title: before.stats.title ?? 'Benchmark session',
        modelLabel: describeModel(before.stats.model).label,
        contextTokens: before.stats.contextTokens,
        cwd: runner.workspace,
        gitBranch: before.stats.gitBranch,
      },
      digest,
    ),
    systemPrompt: HANDOFF_SYSTEM_PROMPT,
    cwd: scratch,
    timeoutMs: HANDOFF_TIMEOUT_MS,
  });
  const handoffFile = await writeHandoffFile(runner.workspace, written.text, {
    sessionId: runner.sessionId,
    title: before.stats.title ?? 'Benchmark session',
    model: before.stats.model ?? MODEL,
    contextTokens: before.stats.contextTokens,
    generatedBy: `Vizzer benchmark (claude -p --model ${HANDOFF_MODEL})`,
    createdAt: new Date(),
  });

  const sourceSessionId = runner.sessionId;
  runner.startNewSession();
  runner.arm.handoff = {
    afterTurn: HANDOFF_AFTER_TURN,
    sourceSessionId,
    newSessionId: runner.sessionId,
    contextBefore: before.stats.contextTokens,
    digestChars: digest.conversation.length,
    digestCondensed: digest.condensed,
    handoffChars: written.text.length,
    tokensProcessed: written.usage ? tokensProcessed(written.usage) : 0,
    costUsd: written.costUsd ?? 0,
    durationMs: Date.now() - startedAt,
    file: path.relative(runner.workspace, handoffFile),
  };
  await ctx.save();
  log(
    'vizzer',
    `handoff: ${kilo(before.stats.contextTokens)} context -> ${written.text.length} chars in ` +
      `${Math.round((Date.now() - startedAt) / 1000)}s ($${(written.costUsd ?? 0).toFixed(3)})`,
  );

  let answer = '';
  for (let index = HANDOFF_AFTER_TURN; index < TASKS.length; index += 1) {
    const prompt =
      index === HANDOFF_AFTER_TURN
        ? `${buildContinuationPrompt(path.relative(runner.workspace, handoffFile))}\n\nThen: ${TASKS[index]}`
        : TASKS[index];
    answer = await runner.turn(index + 1, prompt);
    if (index === HANDOFF_AFTER_TURN && runner.arm.handoff) {
      runner.arm.handoff.contextAfter = runner.arm.requests.find((request) => request.turn === index + 1)?.tokens;
    }
  }
  return answer;
}

function emptyArm(label: string): ArmResult {
  return { label, status: 'pending', turns: [], requests: [] };
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function kilo(tokens: number): string {
  return `${(tokens / 1000).toFixed(1)}k`;
}

function log(scope: string, message: string): void {
  console.log(`${new Date().toISOString().slice(11, 19)} [${scope}] ${message}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
