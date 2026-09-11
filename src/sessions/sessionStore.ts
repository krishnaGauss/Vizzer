import * as fs from 'fs';
import * as path from 'path';
import { parseLine } from '../transcript/parser';
import { SessionAccumulator } from '../transcript/sessionAccumulator';
import { JsonlTailReader } from '../transcript/tailReader';
import { sumUsage } from '../transcript/types';
import { findProjectDirs, projectsRoot } from './claudePaths';
import type { Disposable, SessionRecord } from './types';

export interface SessionStoreOptions {
  claudeConfigDir: string;
  workspacePaths: readonly string[];
  /** Sessions whose transcript hasn't changed within this many days are not loaded. */
  historyDays: number;
  maxSessions: number;
  pollIntervalMs?: number;
  discoveryIntervalMs?: number;
  onError?: (error: unknown) => void;
}

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_DISCOVERY_MS = 15_000;
const WATCH_DEBOUNCE_MS = 120;
const DAY_MS = 24 * 60 * 60 * 1000;
const TRANSCRIPT_EXTENSION = '.jsonl';

interface TranscriptFile {
  reader: JsonlTailReader;
  accumulator: SessionAccumulator;
}

interface TrackedSession {
  id: string;
  projectDir: string;
  mtime: number;
  main: TranscriptFile;
  /** Subagent transcripts, when Claude Code stores them beside the session (`<id>/subagents/*.jsonl`). */
  subagents: Map<string, TranscriptFile>;
  record?: SessionRecord;
}

interface Candidate {
  id: string;
  projectDir: string;
  filePath: string;
  mtime: number;
  size: number;
}

/**
 * Tracks the Claude Code sessions belonging to a set of workspace folders. Transcripts are read
 * incrementally; changes are picked up through `fs.watch` with polling as a fallback.
 */
export class SessionStore implements Disposable {
  private readonly sessions = new Map<string, TrackedSession>();
  private readonly watchers = new Map<string, fs.FSWatcher>();
  private readonly listeners = new Set<() => void>();
  private readonly timers: NodeJS.Timeout[] = [];
  private projectDirs: string[] = [];
  private scanInFlight: Promise<void> | undefined;
  private scanQueued = false;
  private debounceTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(private options: SessionStoreOptions) {}

  async start(): Promise<void> {
    await this.refresh();
    this.timers.push(
      setInterval(() => this.guard(this.scan()), this.options.pollIntervalMs ?? DEFAULT_POLL_MS),
      setInterval(() => this.guard(this.refresh()), this.options.discoveryIntervalMs ?? DEFAULT_DISCOVERY_MS),
    );
  }

  /** Re-discovers project directories and rescans all transcripts. */
  async refresh(): Promise<void> {
    await this.discover();
    await this.scan();
  }

  async updateOptions(changes: Partial<SessionStoreOptions>): Promise<void> {
    const locationChanged =
      (changes.claudeConfigDir !== undefined && changes.claudeConfigDir !== this.options.claudeConfigDir) ||
      (changes.workspacePaths !== undefined &&
        changes.workspacePaths.join('\0') !== this.options.workspacePaths.join('\0'));
    this.options = { ...this.options, ...changes };
    if (locationChanged) this.sessions.clear();
    await this.refresh();
    if (locationChanged) this.emit();
  }

  onDidChange(listener: () => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** Sessions ordered by most recent activity first. */
  getSessions(): SessionRecord[] {
    const records: SessionRecord[] = [];
    for (const session of this.sessions.values()) {
      if (session.record) records.push(session.record);
    }
    return records.sort((a, b) => (b.lastActivity ?? b.mtime) - (a.lastActivity ?? a.mtime));
  }

  getSession(id: string): SessionRecord | undefined {
    return this.sessions.get(id)?.record;
  }

  getProjectDirs(): readonly string[] {
    return this.projectDirs;
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers) clearInterval(timer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.listeners.clear();
  }

  private async discover(): Promise<void> {
    const root = projectsRoot(this.options.claudeConfigDir);
    const dirs = new Set<string>();
    for (const workspacePath of this.options.workspacePaths) {
      for (const dir of await findProjectDirs(root, workspacePath)) dirs.add(dir);
    }
    this.projectDirs = [...dirs];
    this.syncWatchers();
  }

  private syncWatchers(): void {
    if (this.disposed) return;
    for (const [dir, watcher] of this.watchers) {
      if (!this.projectDirs.includes(dir)) {
        watcher.close();
        this.watchers.delete(dir);
      }
    }
    for (const dir of this.projectDirs) {
      if (this.watchers.has(dir)) continue;
      try {
        const watcher = fs.watch(dir, { persistent: false }, (_event, fileName) => {
          if (!fileName || String(fileName).endsWith(TRANSCRIPT_EXTENSION)) this.scheduleScan();
        });
        watcher.on('error', () => {
          watcher.close();
          this.watchers.delete(dir);
        });
        this.watchers.set(dir, watcher);
      } catch {
        // Polling still picks up changes where fs.watch is unavailable.
      }
    }
  }

  private scheduleScan(): void {
    if (this.debounceTimer || this.disposed) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.guard(this.scan());
    }, WATCH_DEBOUNCE_MS);
  }

  /** Serializes scans: requests made while a scan runs collapse into a single follow-up scan. */
  private scan(): Promise<void> {
    if (this.scanInFlight) {
      this.scanQueued = true;
      return this.scanInFlight;
    }
    this.scanInFlight = (async () => {
      try {
        do {
          this.scanQueued = false;
          if (await this.scanOnce()) this.emit();
        } while (this.scanQueued && !this.disposed);
      } finally {
        this.scanInFlight = undefined;
      }
    })();
    return this.scanInFlight;
  }

  private async scanOnce(): Promise<boolean> {
    if (this.disposed) return false;
    const candidates = await this.listCandidates();
    let changed = false;

    const keep = new Set(candidates.map((candidate) => candidate.id));
    for (const id of this.sessions.keys()) {
      if (!keep.has(id)) {
        this.sessions.delete(id);
        changed = true;
      }
    }

    for (const candidate of candidates) {
      let session = this.sessions.get(candidate.id);
      if (!session) {
        session = {
          id: candidate.id,
          projectDir: candidate.projectDir,
          mtime: candidate.mtime,
          main: createTranscriptFile(candidate.filePath),
          subagents: new Map(),
        };
        this.sessions.set(candidate.id, session);
      }
      session.mtime = candidate.mtime;

      let sessionChanged = await readTranscript(session.main, candidate.size);
      sessionChanged = (await this.syncSubagents(session)) || sessionChanged;
      if (sessionChanged || !session.record) {
        session.record = buildRecord(session);
        changed = true;
      }
    }
    return changed;
  }

  private async listCandidates(): Promise<Candidate[]> {
    const cutoff = Date.now() - this.options.historyDays * DAY_MS;
    const candidates: Candidate[] = [];
    for (const projectDir of this.projectDirs) {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(projectDir, { withFileTypes: true });
      } catch {
        continue;
      }
      await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(TRANSCRIPT_EXTENSION))
          .map(async (entry) => {
            const filePath = path.join(projectDir, entry.name);
            try {
              const stat = await fs.promises.stat(filePath);
              if (stat.mtimeMs < cutoff) return;
              candidates.push({
                id: entry.name.slice(0, -TRANSCRIPT_EXTENSION.length),
                projectDir,
                filePath,
                mtime: stat.mtimeMs,
                size: stat.size,
              });
            } catch {
              // The file vanished between readdir and stat.
            }
          }),
      );
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    return candidates.slice(0, this.options.maxSessions);
  }

  private async syncSubagents(session: TrackedSession): Promise<boolean> {
    const dir = path.join(session.projectDir, session.id, 'subagents');
    let names: string[];
    try {
      names = (await fs.promises.readdir(dir)).filter((name) => name.endsWith(TRANSCRIPT_EXTENSION));
    } catch {
      return false;
    }

    let changed = false;
    for (const name of names) {
      const filePath = path.join(dir, name);
      let file = session.subagents.get(name);
      if (!file) {
        file = createTranscriptFile(filePath);
        session.subagents.set(name, file);
      }
      try {
        const { size } = await fs.promises.stat(filePath);
        if (await readTranscript(file, size)) changed = true;
      } catch {
        // Ignore subagent files that disappear mid-scan.
      }
    }
    return changed;
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        this.options.onError?.(error);
      }
    }
  }

  private guard(task: Promise<unknown>): void {
    task.catch((error: unknown) => this.options.onError?.(error));
  }
}

function createTranscriptFile(filePath: string): TranscriptFile {
  return { reader: new JsonlTailReader(filePath), accumulator: new SessionAccumulator() };
}

/** Applies newly appended lines; returns whether anything changed. */
async function readTranscript(file: TranscriptFile, size: number): Promise<boolean> {
  if (size === file.reader.position) return false;
  const { lines, reset } = await file.reader.readNew();
  if (reset) file.accumulator = new SessionAccumulator();
  for (const line of lines) {
    const event = parseLine(line);
    if (event) file.accumulator.apply(event);
  }
  return reset || lines.length > 0;
}

function buildRecord(session: TrackedSession): SessionRecord {
  const stats = session.main.accumulator.snapshot();
  const subagents = [...session.subagents.values()].map((file) => file.accumulator.snapshot());
  // Newer Claude Code versions keep subagent traffic in separate files; older ones inline it as sidechains.
  const subagentTotals =
    subagents.length > 0
      ? sumUsage(subagents.flatMap((sub) => [sub.totals, sub.subagentTotals]))
      : stats.subagentTotals;

  return {
    ...stats,
    subagentTotals,
    id: session.id,
    filePath: session.main.reader.filePath,
    projectDir: session.projectDir,
    mtime: session.mtime,
    lastActivity: Math.max(stats.lastActivity ?? 0, ...subagents.map((sub) => sub.lastActivity ?? 0)) || session.mtime,
  };
}
