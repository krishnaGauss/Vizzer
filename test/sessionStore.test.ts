import { promises as fs } from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeProjectPath } from '../src/sessions/claudePaths';
import { SessionStore, type SessionStoreOptions } from '../src/sessions/sessionStore';
import { appendLines, assistant, makeTempDir, userPrompt, writeLines } from './helpers/transcript';

const WORKSPACE = '/work/app';

function waitForChange(store: SessionStore, timeoutMs = 3_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      subscription.dispose();
      reject(new Error('timed out waiting for a store change'));
    }, timeoutMs);
    const subscription = store.onDidChange(() => {
      clearTimeout(timer);
      subscription.dispose();
      resolve();
    });
  });
}

describe('SessionStore', () => {
  let configDir: string;
  let projectDir: string;
  let store: SessionStore | undefined;

  const createStore = (options: Partial<SessionStoreOptions> = {}): SessionStore => {
    store = new SessionStore({
      claudeConfigDir: configDir,
      workspacePaths: [WORKSPACE],
      historyDays: 7,
      maxSessions: 10,
      pollIntervalMs: 25,
      discoveryIntervalMs: 60_000,
      ...options,
    });
    return store;
  };

  beforeEach(async () => {
    configDir = await makeTempDir();
    projectDir = path.join(configDir, 'projects', encodeProjectPath(WORKSPACE));
  });

  afterEach(() => {
    store?.dispose();
    store = undefined;
  });

  it('loads workspace sessions and follows appended lines', async () => {
    const file = path.join(projectDir, 'session-1.jsonl');
    await writeLines(file, [userPrompt('hello', { cwd: WORKSPACE }), assistant({ cwd: WORKSPACE, input: 10, cacheWrite: 5_000 })]);

    const sessions = createStore();
    await sessions.start();
    expect(sessions.getSessions().map((session) => session.id)).toEqual(['session-1']);
    expect(sessions.getSession('session-1')?.contextTokens).toBe(5_010);

    const changed = waitForChange(sessions);
    await appendLines(file, [assistant({ cwd: WORKSPACE, input: 5, cacheWrite: 300, cacheRead: 5_010 })]);
    await changed;
    expect(sessions.getSession('session-1')?.contextTokens).toBe(5_315);
  });

  it('skips stale sessions and caps the number tracked', async () => {
    for (const id of ['a', 'b', 'c']) {
      await writeLines(path.join(projectDir, `${id}.jsonl`), [assistant({ cwd: WORKSPACE })]);
    }
    const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await fs.utimes(path.join(projectDir, 'c.jsonl'), stale, stale);

    const sessions = createStore({ maxSessions: 1 });
    await sessions.start();
    expect(sessions.getSessions()).toHaveLength(1);
    expect(sessions.getSessions()[0].id).not.toBe('c');
  });

  it('adds subagent transcripts to subagent totals without touching the context', async () => {
    await writeLines(path.join(projectDir, 'main.jsonl'), [assistant({ cwd: WORKSPACE, input: 1_000 })]);
    await writeLines(path.join(projectDir, 'main', 'subagents', 'agent-1.jsonl'), [
      assistant({ cwd: WORKSPACE, input: 7_000, sidechain: true }),
    ]);

    const sessions = createStore();
    await sessions.start();
    const session = sessions.getSession('main');
    expect(session?.contextTokens).toBe(1_000);
    expect(session?.subagentTotals.input).toBe(7_000);
  });

  it('discovers a project folder created after start-up', async () => {
    const sessions = createStore();
    await sessions.start();
    expect(sessions.getSessions()).toEqual([]);

    await writeLines(path.join(projectDir, 'late.jsonl'), [assistant({ cwd: WORKSPACE })]);
    await sessions.refresh();
    expect(sessions.getSessions().map((session) => session.id)).toEqual(['late']);
  });
});
