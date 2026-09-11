/**
 * Turns bench/results/*.json into charts (docs/benchmarks/*.svg and *.png) and rewrites the
 * benchmark section of README.md between its marker comments.
 *
 *   npm run bench:report
 */
import { Resvg } from '@resvg/resvg-js';
import { promises as fs } from 'fs';
import * as path from 'path';
import { formatCount, formatTokens } from '../src/core/format';
import { describeModel } from '../src/core/models';
import type { ArmResult, BenchmarkResults, OverheadResults, TurnMetrics } from './lib/results';
import { THEME, barChart, lineChart } from './lib/svg';
import { stripAnsi } from './lib/workspace';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RESULTS_DIR = path.join(REPO_ROOT, 'bench', 'results');
const CHART_DIR = path.join(REPO_ROOT, 'docs', 'benchmarks');
const README = path.join(REPO_ROOT, 'README.md');
const START_MARKER = '<!-- benchmark:start -->';
const END_MARKER = '<!-- benchmark:end -->';
const PNG_SCALE = 2;
const MINUS = '−';

const [WITH_COLOR, WITHOUT_COLOR] = THEME.series;

interface ArmSummary {
  peakContext: number;
  avgContextAfterHandoff: number;
  finalContext: number;
  tokensProcessed: number;
  costUsd: number;
  durationMs: number;
  requests: number;
  compactions: number;
  /** Turns before the handoff point; identical conditions in both arms. */
  beforeTokens: number;
  beforeCostUsd: number;
  /** Turns after the handoff point; the Vizzer arm includes the handoff call itself. */
  afterTokens: number;
  afterCostUsd: number;
}

async function main(): Promise<void> {
  const results = await readJson<BenchmarkResults>(path.join(RESULTS_DIR, 'latest.json'));
  const overhead = await readJson<OverheadResults>(path.join(RESULTS_DIR, 'overhead.json')).catch(() => undefined);
  const { baseline, vizzer } = results.arms;
  const turns = results.tasks.length;
  const handoffAfter = results.handoffAfterTurn;
  const xLabels = Array.from({ length: turns }, (_, index) => String(index + 1));
  const markers = [{ at: handoffAfter - 0.5, label: 'Vizzer handoff' }];
  const handoffExtra = vizzer.handoff ? { turn: handoffAfter + 1, tokens: vizzer.handoff.tokensProcessed } : undefined;
  await fs.mkdir(CHART_DIR, { recursive: true });

  await writeChart(
    'context-per-turn',
    lineChart({
      title: 'Context carried at the end of each turn',
      subtitle: `Tokens re-sent with every request · ${describeModel(results.environment.model).label} · same 14-turn task`,
      description: 'Line chart of context tokens per turn for the run without Vizzer and the run with a Vizzer handoff.',
      xLabels,
      xTitle: 'Turn',
      formatY: formatTokens,
      series: [
        { name: 'With Vizzer', color: WITH_COLOR, values: contextByTurn(vizzer, turns) },
        { name: 'Without Vizzer', color: WITHOUT_COLOR, values: contextByTurn(baseline, turns) },
      ],
      markers,
    }),
  );

  await writeChart(
    'cumulative-tokens',
    lineChart({
      title: 'Total tokens processed',
      subtitle: 'Cumulative input, cache and output tokens incl. subagents · Vizzer run includes the Haiku handoff',
      description: 'Line chart of cumulative tokens processed per turn for both runs.',
      xLabels,
      xTitle: 'Turn',
      formatY: formatTokens,
      series: [
        { name: 'With Vizzer', color: WITH_COLOR, values: cumulativeTokens(vizzer, turns, handoffExtra) },
        { name: 'Without Vizzer', color: WITHOUT_COLOR, values: cumulativeTokens(baseline, turns) },
      ],
      markers,
    }),
  );

  if (overhead) {
    await writeChart(
      'vizzer-memory',
      barChart({
        title: 'Vizzer memory by transcript size',
        subtitle: 'Extra heap to load and track one session, measured in a fresh Node process',
        description: 'Column chart of the heap Vizzer uses for transcripts of different sizes.',
        categories: overhead.samples.map((sample) => `${sample.sizeMb} MB`),
        values: overhead.samples.map((sample) => sample.heapMb),
        color: THEME.series[0],
        xTitle: 'Transcript size on disk',
        formatY: (value) => `${value} MB`,
        formatValue: (value) => `${value.toFixed(1)} MB`,
      }),
    );
  }

  const section = renderSection(results, overhead);
  const readme = await fs.readFile(README, 'utf8');
  const start = readme.indexOf(START_MARKER);
  const end = readme.indexOf(END_MARKER);
  if (start < 0 || end < start) throw new Error(`README.md needs ${START_MARKER} and ${END_MARKER} markers.`);
  await fs.writeFile(README, `${readme.slice(0, start + START_MARKER.length)}\n${section}\n${readme.slice(end)}`);
  console.log('Charts written to docs/benchmarks/, README.md benchmark section updated.');
}

function renderSection(results: BenchmarkResults, overhead: OverheadResults | undefined): string {
  const { baseline, vizzer } = results.arms;
  const handoffAfter = results.handoffAfterTurn;
  const without = summarize(baseline, handoffAfter);
  const withV = summarize(vizzer, handoffAfter);
  const handoff = vizzer.handoff;
  const env = results.environment;
  const date = (results.finishedAt ?? results.startedAt).slice(0, 10);
  const lines: string[] = [];

  lines.push(
    `Measured ${date} with Claude Code ${env.claudeVersion.replace(/\s*\(Claude Code\)/, '')} on ${platformLabel(env.platform)}. ` +
      `Both runs used ${describeModel(env.model).label} to perform the same ${results.tasks.length}-turn coding task ` +
      `([bench/tasks.ts](bench/tasks.ts)) on separate copies of this repository: one kept a single session, ` +
      `the other used Vizzer's handoff (written by ${modelName(env.handoffModel)}) after turn ${handoffAfter} and continued in a fresh session.`,
    '',
  );
  for (const arm of [baseline, vizzer]) {
    if (arm.status !== 'done') lines.push(`> ⚠️ ${arm.label}: run ${arm.status}${arm.error ? ` (${arm.error})` : ''}.`, '');
  }

  if (handoff?.contextAfter !== undefined) {
    lines.push(
      `**The handoff cut the context from ${formatTokens(handoff.contextBefore)} to ${formatTokens(handoff.contextAfter)} tokens ` +
        `(${percentChange(handoff.contextBefore, handoff.contextAfter)}). After it (turns ${handoffAfter + 1}–${results.tasks.length}), ` +
        `the Vizzer run processed ${describeDelta(without.afterTokens, withV.afterTokens, formatTokens, 'tokens', 'fewer')} ` +
        `and cost ${describeDelta(without.afterCostUsd, withV.afterCostUsd, usd, '', 'less')} than the single long session.**`,
      '',
      `Turns 1–${handoffAfter} ran under identical conditions in both runs and still differed by ` +
        `${percentChange(without.beforeTokens, withV.beforeTokens)} in tokens processed. That is ordinary run-to-run ` +
        'variation, so the after-handoff rows are the fairer comparison.',
      '',
    );
  }

  lines.push(
    '![Context carried at the end of each turn, with and without Vizzer](docs/benchmarks/context-per-turn.png)',
    '',
    '![Total tokens processed over the task, with and without Vizzer](docs/benchmarks/cumulative-tokens.png)',
    '',
    '| Metric | Without Vizzer | With Vizzer | Change |',
    '| --- | ---: | ---: | ---: |',
    row('Peak context', without.peakContext, withV.peakContext, formatTokens),
    row(`Avg. context per request, turns ${handoffAfter + 1}–${results.tasks.length}`, without.avgContextAfterHandoff, withV.avgContextAfterHandoff, formatTokens),
    row('Context at the last turn', without.finalContext, withV.finalContext, formatTokens),
    row(`Tokens processed, turns 1–${handoffAfter} (before handoff)`, without.beforeTokens, withV.beforeTokens, formatTokens),
    row(`Tokens processed, turns ${handoffAfter + 1}–${results.tasks.length}¹`, without.afterTokens, withV.afterTokens, formatTokens),
    row('Tokens processed, whole task¹', without.tokensProcessed, withV.tokensProcessed, formatTokens),
    row(`Estimated cost, turns ${handoffAfter + 1}–${results.tasks.length}²`, without.afterCostUsd, withV.afterCostUsd, usd),
    row('Estimated cost, whole task²', without.costUsd, withV.costUsd, usd),
    row('Model time', without.durationMs, withV.durationMs, minutes),
    row('API requests', without.requests, withV.requests, formatCount),
    `| Auto-compactions | ${without.compactions} | ${withV.compactions} | |`,
    `| Tests at the end | ${check(baseline.verification?.tests)} | ${check(vizzer.verification?.tests)} | |`,
    `| Typecheck at the end | ${check(baseline.verification?.typecheck)} | ${check(vizzer.verification?.typecheck)} | |`,
    `| Final-summary recall³ | ${recall(baseline)} | ${recall(vizzer)} | |`,
    '',
  );

  const missed = [baseline, vizzer]
    .filter((arm) => arm.recall && arm.recall.missing.length > 0)
    .map((arm) => `${arm.label}: ${arm.recall?.missing.map((keyword) => `\`${keyword}\``).join(', ')}`);
  if (missed.length > 0) {
    lines.push(
      `**Not mentioned in the final summary** (the code itself is covered by the test and typecheck rows): ${missed.join('; ')}.`,
      '',
    );
  }

  if (handoff) {
    lines.push(
      `**Handoff:** Vizzer condensed the ${formatTokens(handoff.contextBefore)}-token session into a ${formatCount(handoff.digestChars)}-character digest` +
        `${handoff.digestCondensed ? ' (older middle turns abbreviated)' : ''}; ${modelName(env.handoffModel)} turned it into a ` +
        `${formatCount(handoff.handoffChars)}-character handoff file in ${(handoff.durationMs / 1000).toFixed(0)} s ` +
        `(${formatTokens(handoff.tokensProcessed)} tokens, ${usd(handoff.costUsd)}).`,
      '',
    );
  }

  lines.push(
    '<details>',
    '<summary>Per-turn data</summary>',
    '',
    '| Turn | Context without | Context with | Tokens without | Tokens with |',
    '| ---: | ---: | ---: | ---: | ---: |',
    ...Array.from({ length: results.tasks.length }, (_, index) => {
      const a = baseline.turns.find((turn) => turn.turn === index + 1);
      const b = vizzer.turns.find((turn) => turn.turn === index + 1);
      const cell = (turn: TurnMetrics | undefined, pick: (turn: TurnMetrics) => number): string =>
        turn ? formatTokens(pick(turn)) : '—';
      return `| ${index + 1} | ${cell(a, (t) => t.contextEnd)} | ${cell(b, (t) => t.contextEnd)} | ${cell(a, (t) => t.tokensProcessed)} | ${cell(b, (t) => t.tokensProcessed)} |`;
    }),
    '',
    '</details>',
    '',
  );

  if (overhead) {
    lines.push(
      '### Vizzer’s own overhead',
      '',
      'Without Vizzer nothing extra runs. With it, the extension tails transcripts incrementally; this is what it costs, measured on synthetic transcripts in a fresh Node process (`npm run bench:overhead`). ' +
        'Heap is what Vizzer keeps while tracking a session. RSS growth is mostly the transient buffer from reading the whole file at start-up, which the process doesn’t hand back to the OS right away.',
      '',
      '![Vizzer memory by transcript size](docs/benchmarks/vizzer-memory.png)',
      '',
      '| Transcript | Initial load | CPU | Heap | RSS | Idle rescan | Update latency (median / p95) |',
      '| ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
      ...overhead.samples.map(
        (sample) =>
          `| ${sample.sizeMb} MB | ${sample.loadMs.toFixed(0)} ms | ${sample.cpuMs.toFixed(0)} ms | ${sample.heapMb.toFixed(1)} MB | ` +
          `${sample.rssMb.toFixed(1)} MB | ${sample.idleScanMs.toFixed(1)} ms | ${sample.updateLatencyMedianMs.toFixed(0)} / ${sample.updateLatencyP95Ms.toFixed(0)} ms |`,
      ),
      '',
    );
  }

  lines.push(
    '¹ Input + cache write + cache read + output tokens, subagents included; the Vizzer column includes the handoff call.  ',
    '² Claude Code’s client-side estimate at API list prices. Subscription plans meter usage differently.  ',
    `³ How many of ${recallTotal(vizzer, baseline)} identifiers created during the task (e.g. \`formatDuration\`, \`cacheHitRate\`) the final turn’s summary mentions.`,
    '',
    'One run per arm, so expect some variation between runs; turns 1–' +
      `${handoffAfter} were also run independently in each arm. Reproduce with \`npm run bench:run\` (uses your Claude plan), ` +
      '`npm run bench:overhead`, then `npm run bench:report`. Raw data: [bench/results/](bench/results/).',
  );
  return lines.join('\n');
}

function summarize(arm: ArmResult, handoffAfter: number): ArmSummary {
  const total = (pick: (turn: TurnMetrics) => number): number => arm.turns.reduce((sum, turn) => sum + pick(turn), 0);
  const totalWhere = (keep: (turn: TurnMetrics) => boolean, pick: (turn: TurnMetrics) => number): number =>
    arm.turns.filter(keep).reduce((sum, turn) => sum + pick(turn), 0);
  const before = (turn: TurnMetrics): boolean => turn.turn <= handoffAfter;
  const after = (turn: TurnMetrics): boolean => turn.turn > handoffAfter;
  const later = arm.requests.filter((request) => request.turn > handoffAfter).map((request) => request.tokens);
  return {
    peakContext: Math.max(0, ...arm.requests.map((request) => request.tokens)),
    avgContextAfterHandoff: later.length > 0 ? later.reduce((sum, value) => sum + value, 0) / later.length : 0,
    finalContext: arm.turns.at(-1)?.contextEnd ?? 0,
    tokensProcessed: total((turn) => turn.tokensProcessed) + (arm.handoff?.tokensProcessed ?? 0),
    costUsd: total((turn) => turn.costUsd) + (arm.handoff?.costUsd ?? 0),
    durationMs: total((turn) => turn.durationMs) + (arm.handoff?.durationMs ?? 0),
    requests: total((turn) => turn.requests),
    beforeTokens: totalWhere(before, (turn) => turn.tokensProcessed),
    beforeCostUsd: totalWhere(before, (turn) => turn.costUsd),
    afterTokens: totalWhere(after, (turn) => turn.tokensProcessed) + (arm.handoff?.tokensProcessed ?? 0),
    afterCostUsd: totalWhere(after, (turn) => turn.costUsd) + (arm.handoff?.costUsd ?? 0),
    compactions: arm.turns.reduce((sum, turn, index, all) => {
      const previous = index > 0 && all[index - 1].segment === turn.segment ? all[index - 1].compactionsSoFar : 0;
      return sum + Math.max(0, turn.compactionsSoFar - previous);
    }, 0),
  };
}

function contextByTurn(arm: ArmResult, turns: number): Array<number | null> {
  return Array.from({ length: turns }, (_, index) => arm.turns.find((turn) => turn.turn === index + 1)?.contextEnd ?? null);
}

function cumulativeTokens(arm: ArmResult, turns: number, extra?: { turn: number; tokens: number }): Array<number | null> {
  let total = 0;
  return Array.from({ length: turns }, (_, index) => {
    const turn = arm.turns.find((candidate) => candidate.turn === index + 1);
    if (!turn) return null;
    total += turn.tokensProcessed + (extra?.turn === turn.turn ? extra.tokens : 0);
    return total;
  });
}

async function writeChart(name: string, svg: string): Promise<void> {
  await fs.writeFile(path.join(CHART_DIR, `${name}.svg`), svg);
  const width = Number(/width="(\d+)"/.exec(svg)?.[1] ?? 800);
  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: width * PNG_SCALE },
    font: { loadSystemFonts: true, defaultFontFamily: 'Helvetica Neue', sansSerifFamily: 'Helvetica Neue' },
  }).render();
  await fs.writeFile(path.join(CHART_DIR, `${name}.png`), png.asPng());
}

function row(label: string, without: number, withV: number, format: (value: number) => string): string {
  return `| ${label} | ${format(without)} | ${format(withV)} | ${percentChange(without, withV)} |`;
}

function percentChange(from: number, to: number): string {
  if (from === 0) return '—';
  const change = ((to - from) / from) * 100;
  const rounded = Math.round(change);
  return rounded === 0 ? '0%' : `${rounded < 0 ? MINUS : '+'}${Math.abs(rounded)}%`;
}

function describeDelta(
  without: number,
  withV: number,
  format: (value: number) => string,
  unit: string,
  lessWord: 'less' | 'fewer',
): string {
  const difference = Math.abs(without - withV);
  const direction = withV <= without ? lessWord : 'more';
  const phrase = unit ? `${format(difference)} ${direction} ${unit}` : `${format(difference)} ${direction}`;
  return `${phrase} (${percentChange(without, withV)})`;
}

function platformLabel(platform: string): string {
  return platform.startsWith('darwin') ? `macOS (${platform.replace(/^darwin/, 'Darwin')})` : platform;
}

function modelName(idOrAlias: string): string {
  const info = describeModel(idOrAlias);
  return info.family === 'unknown' ? idOrAlias.charAt(0).toUpperCase() + idOrAlias.slice(1) : info.label;
}

function check(result: { ok: boolean; summary: string } | undefined): string {
  if (!result) return '—';
  return `${result.ok ? '✅' : '❌'} ${stripAnsi(result.summary).trim()}`;
}

function recall(arm: ArmResult): string {
  return arm.recall ? `${arm.recall.found.length}/${arm.recall.found.length + arm.recall.missing.length}` : '—';
}

function recallTotal(...arms: ArmResult[]): number {
  const withRecall = arms.find((arm) => arm.recall);
  return withRecall?.recall ? withRecall.recall.found.length + withRecall.recall.missing.length : 0;
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function minutes(ms: number): string {
  return `${(ms / 60_000).toFixed(1)} min`;
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
