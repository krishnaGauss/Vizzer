import { promises as fs } from 'fs';
import * as path from 'path';
import { encodeProjectPath, projectsRoot } from '../../src/sessions/claudePaths';
import { parseLine } from '../../src/transcript/parser';
import { SessionAccumulator, type SessionStats } from '../../src/transcript/sessionAccumulator';
import { JsonlTailReader } from '../../src/transcript/tailReader';
import { addUsage, emptyUsage, sumUsage, type TokenUsage } from '../../src/transcript/types';

export interface MeasuredSession {
  transcriptPath: string;
  stats: SessionStats;
  /** Main conversation plus subagents: everything the session sent to or received from the API. */
  allUsage: TokenUsage;
}

/**
 * Measures one benchmark session with Vizzer's own transcript parser. Only that session's transcript
 * (and its subagent transcripts) is read; the path is derived, not discovered.
 */
export async function measureSession(configDir: string, workspace: string, sessionId: string): Promise<MeasuredSession> {
  const projectDir = path.join(projectsRoot(configDir), encodeProjectPath(await fs.realpath(workspace)));
  const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
  const stats = await accumulateFile(transcriptPath);

  const subagentDir = path.join(projectDir, sessionId, 'subagents');
  const subagentFiles = (await fs.readdir(subagentDir).catch(() => [] as string[])).filter((name) =>
    name.endsWith('.jsonl'),
  );
  const subagents = await Promise.all(subagentFiles.map((name) => accumulateFile(path.join(subagentDir, name))));
  // Newer Claude Code versions store subagent traffic in separate files, older ones inline it.
  const subagentUsage =
    subagents.length > 0 ? sumUsage(subagents.flatMap((sub) => [sub.totals, sub.subagentTotals])) : stats.subagentTotals;

  const allUsage = emptyUsage();
  addUsage(allUsage, stats.totals);
  addUsage(allUsage, subagentUsage);
  return { transcriptPath, stats, allUsage };
}

export function tokensProcessed(usage: TokenUsage): number {
  return usage.input + usage.cacheWrite + usage.cacheRead + usage.output;
}

export function usageDelta(current: TokenUsage, previous: TokenUsage): TokenUsage {
  const delta = { ...current };
  addUsage(delta, previous, -1);
  return delta;
}

async function accumulateFile(file: string): Promise<SessionStats> {
  const accumulator = new SessionAccumulator();
  const { lines } = await new JsonlTailReader(file).readNew();
  for (const line of lines) {
    const event = parseLine(line);
    if (event) accumulator.apply(event);
  }
  return accumulator.snapshot();
}
