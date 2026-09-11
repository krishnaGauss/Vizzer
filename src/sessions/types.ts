import type { SessionStats } from '../transcript/sessionAccumulator';

/** Statistics for one Claude Code session plus where its transcript lives. */
export interface SessionRecord extends SessionStats {
  id: string;
  filePath: string;
  projectDir: string;
  /** Transcript modification time (ms since epoch). */
  mtime: number;
}

export interface Disposable {
  dispose(): void;
}
