/**
 * Measures Vizzer's own resource cost: memory, CPU and update latency when tracking transcripts of
 * increasing size. Transcripts are synthetic; each size is measured in a fresh process.
 *
 *   npm run bench:overhead
 */
import { execFileSync } from 'child_process';
import { createWriteStream, promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { encodeProjectPath } from '../src/sessions/claudePaths';
import { SessionStore } from '../src/sessions/sessionStore';
import type { OverheadResults, OverheadSample } from './lib/results';

const SIZES_MB = [1, 10, 50];
const WORKSPACE = '/bench/workspace';
const UPDATE_SAMPLES = 15;
const MB = 1024 * 1024;
const RESULTS_FILE = path.resolve(__dirname, '..', 'results', 'overhead.json');

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vizzer-overhead-'));
  const samples: OverheadSample[] = [];
  for (const sizeMb of SIZES_MB) {
    const configDir = path.join(root, `${sizeMb}mb`);
    const projectDir = path.join(configDir, 'projects', encodeProjectPath(WORKSPACE));
    await fs.mkdir(projectDir, { recursive: true });
    await generateTranscript(path.join(projectDir, 'session.jsonl'), sizeMb * MB);

    const output = execFileSync(process.execPath, ['--expose-gc', __filename, '--child', configDir], { encoding: 'utf8' });
    const sample = { sizeMb, ...(JSON.parse(output) as Omit<OverheadSample, 'sizeMb'>) };
    samples.push(sample);
    console.log(
      `${sizeMb} MB: load ${sample.loadMs.toFixed(0)} ms, heap +${sample.heapMb.toFixed(1)} MB, ` +
        `rss +${sample.rssMb.toFixed(1)} MB, update ${sample.updateLatencyMedianMs.toFixed(0)} ms`,
    );
  }
  await fs.rm(root, { recursive: true, force: true });

  const results: OverheadResults = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    samples,
  };
  await fs.mkdir(path.dirname(RESULTS_FILE), { recursive: true });
  await fs.writeFile(RESULTS_FILE, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`written to ${path.relative(process.cwd(), RESULTS_FILE)}`);
}

/** Runs inside a fresh `node --expose-gc` process so memory readings aren't polluted. */
async function measure(configDir: string): Promise<void> {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) throw new Error('run with --expose-gc');
  const file = path.join(configDir, 'projects', encodeProjectPath(WORKSPACE), 'session.jsonl');

  gc();
  const memoryBefore = process.memoryUsage();
  const cpuBefore = process.cpuUsage();
  const loadStart = performance.now();
  const store = new SessionStore({
    claudeConfigDir: configDir,
    workspacePaths: [WORKSPACE],
    historyDays: 7,
    maxSessions: 25,
  });
  await store.start();
  const loadMs = performance.now() - loadStart;
  const cpu = process.cpuUsage(cpuBefore);
  gc();
  const memoryAfter = process.memoryUsage();

  const idleStart = performance.now();
  await store.refresh();
  const idleScanMs = performance.now() - idleStart;

  const latencies: number[] = [];
  for (let index = 0; index < UPDATE_SAMPLES; index += 1) {
    const changed = new Promise<void>((resolve) => {
      const subscription = store.onDidChange(() => {
        subscription.dispose();
        resolve();
      });
    });
    const start = performance.now();
    await fs.appendFile(file, `${assistantLine(1_000_000 + index, 180_000 + index)}\n`);
    await changed;
    latencies.push(performance.now() - start);
  }
  store.dispose();

  latencies.sort((a, b) => a - b);
  const result: Omit<OverheadSample, 'sizeMb'> = {
    fileBytes: (await fs.stat(file)).size,
    loadMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    heapMb: (memoryAfter.heapUsed - memoryBefore.heapUsed) / MB,
    rssMb: (memoryAfter.rss - memoryBefore.rss) / MB,
    idleScanMs,
    updateLatencyMedianMs: latencies[Math.floor(latencies.length / 2)],
    updateLatencyP95Ms: latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)],
  };
  process.stdout.write(JSON.stringify(result));
}

/** Writes a realistic mix of prompts, tool calls, large tool results and replies up to `bytes`. */
async function generateTranscript(file: string, bytes: number): Promise<void> {
  const stream = createWriteStream(file);
  let written = 0;
  let turn = 0;
  const write = (entry: object): void => {
    const line = `${JSON.stringify(entry)}\n`;
    written += Buffer.byteLength(line);
    stream.write(line);
  };
  while (written < bytes) {
    turn += 1;
    const timestamp = new Date(Date.UTC(2026, 8, 1) + turn * 30_000).toISOString();
    const base = { sessionId: 'session', cwd: WORKSPACE, gitBranch: 'main', isSidechain: false, timestamp };
    write({ ...base, type: 'user', uuid: `u${turn}`, message: { role: 'user', content: `Task ${turn}: update the module` } });
    write({
      ...base,
      type: 'assistant',
      uuid: `a${turn}`,
      message: {
        id: `msg_${turn}`,
        model: 'claude-sonnet-5',
        content: [{ type: 'tool_use', id: `t${turn}`, name: 'Read', input: { file_path: `${WORKSPACE}/src/module${turn}.ts` } }],
        usage: { input_tokens: 3, cache_creation_input_tokens: 900, cache_read_input_tokens: 20_000 + turn * 40, output_tokens: 120 },
      },
    });
    write({
      ...base,
      type: 'user',
      uuid: `r${turn}`,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${turn}`, content: 'x'.repeat(2_000 + (turn % 7) * 1_000) }] },
    });
    write({ ...base, type: 'assistant', uuid: `b${turn}`, message: { id: `msg_b${turn}`, model: 'claude-sonnet-5', content: [{ type: 'text', text: 'Done. '.repeat(40) }], usage: { input_tokens: 3, cache_creation_input_tokens: 1_200, cache_read_input_tokens: 21_000 + turn * 40, output_tokens: 300 } } });
  }
  await new Promise<void>((resolve, reject) => stream.end((error?: Error | null) => (error ? reject(error) : resolve())));
}

function assistantLine(id: number, cacheRead: number): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: 'session',
    cwd: WORKSPACE,
    isSidechain: false,
    timestamp: new Date().toISOString(),
    message: { id: `msg_live_${id}`, model: 'claude-sonnet-5', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 3, cache_creation_input_tokens: 500, cache_read_input_tokens: cacheRead, output_tokens: 50 } },
  });
}

const childIndex = process.argv.indexOf('--child');
(childIndex >= 0 ? measure(process.argv[childIndex + 1]) : main()).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
