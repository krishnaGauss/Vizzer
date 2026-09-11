import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Claude Code shortens long project directory names; longer paths are matched by prefix, then verified. */
const MAX_ENCODED_LENGTH = 200;
const CWD_PROBE_BYTES = 64 * 1024;

/** Claude Code's config directory: explicit setting, then `CLAUDE_CONFIG_DIR`, then `~/.claude`. */
export function resolveClaudeConfigDir(
  configured = '',
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  const chosen = configured.trim() || env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, '.claude');
  return expandHome(chosen, home);
}

export function expandHome(value: string, home: string = os.homedir()): string {
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(home, value.slice(2));
  return value;
}

export function projectsRoot(configDir: string): string {
  return path.join(configDir, 'projects');
}

/** Claude Code names a project's transcript directory after its path, with non-alphanumerics as `-`. */
export function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Finds transcript directories for sessions started in `workspacePath` or any folder inside it.
 * Only an exact name match is trusted outright; other candidates are confirmed from the `cwd` recorded
 * in their newest transcript, because the encoding maps `/a/b-c` and `/a/b/c` to the same name.
 */
export async function findProjectDirs(root: string, workspacePath: string): Promise<string[]> {
  let names: string[];
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }

  const encoded = encodeProjectPath(workspacePath);
  const prefix = encoded.slice(0, MAX_ENCODED_LENGTH);
  const matches: string[] = [];
  for (const name of names) {
    const dir = path.join(root, name);
    if (name === encoded) {
      matches.push(dir);
      continue;
    }
    if (!name.startsWith(prefix)) continue;
    const cwd = await probeTranscriptCwd(dir);
    if (cwd && isSameOrInside(cwd, workspacePath)) matches.push(dir);
  }
  return matches;
}

/** Reads the working directory recorded in the most recently modified transcript of `dir`. */
export async function probeTranscriptCwd(dir: string): Promise<string | undefined> {
  const newest = await newestTranscript(dir);
  if (!newest) return undefined;

  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(newest, 'r');
    const buffer = Buffer.alloc(CWD_PROBE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, CWD_PROBE_BYTES, 0);
    for (const line of buffer.toString('utf8', 0, bytesRead).split('\n')) {
      const cwd = cwdFromLine(line);
      if (cwd) return cwd;
    }
  } catch {
    // Unreadable transcripts are simply not matched.
  } finally {
    await handle?.close();
  }
  return undefined;
}

export function isSameOrInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function newestTranscript(dir: string): Promise<string | undefined> {
  let best: { file: string; mtime: number } | undefined;
  try {
    for (const name of await fs.readdir(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      const { mtimeMs } = await fs.stat(file);
      if (!best || mtimeMs > best.mtime) best = { file, mtime: mtimeMs };
    }
  } catch {
    return undefined;
  }
  return best?.file;
}

function cwdFromLine(line: string): string | undefined {
  if (!line.includes('"cwd"')) return undefined;
  try {
    const entry: unknown = JSON.parse(line);
    const cwd = typeof entry === 'object' && entry !== null ? (entry as { cwd?: unknown }).cwd : undefined;
    return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined;
  } catch {
    return undefined;
  }
}
