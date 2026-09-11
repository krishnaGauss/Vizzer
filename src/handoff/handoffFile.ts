import { promises as fs } from 'fs';
import * as path from 'path';

export const VIZZER_DIR = '.vizzer';
export const HANDOFF_SUBDIR = 'handoffs';

const GITIGNORE_CONTENT = '# Created by Vizzer: keeps handoff files out of version control.\n*\n';
const MAX_SLUG_LENGTH = 48;

export interface HandoffMetadata {
  sessionId: string;
  title: string;
  model: string;
  contextTokens: number;
  generatedBy: string;
  createdAt: Date;
}

/**
 * Writes a handoff to `<workspace>/.vizzer/handoffs/<timestamp>-<slug>.md` and returns its path.
 * The `.vizzer` folder gets its own `.gitignore`, so the user's ignore files are never modified.
 */
export async function writeHandoffFile(workspaceRoot: string, markdown: string, meta: HandoffMetadata): Promise<string> {
  const vizzerDir = path.join(workspaceRoot, VIZZER_DIR);
  const handoffDir = path.join(vizzerDir, HANDOFF_SUBDIR);
  await fs.mkdir(handoffDir, { recursive: true });
  await ensureGitignore(vizzerDir);

  const filePath = await uniquePath(handoffDir, `${fileTimestamp(meta.createdAt)}-${slugify(meta.title)}`, '.md');
  await fs.writeFile(filePath, renderHandoff(markdown, meta), 'utf8');
  return filePath;
}

export function renderHandoff(markdown: string, meta: HandoffMetadata): string {
  const frontMatter = [
    '---',
    `source_session: ${meta.sessionId}`,
    `source_title: ${JSON.stringify(meta.title)}`,
    `source_model: ${JSON.stringify(meta.model)}`,
    `context_tokens_at_handoff: ${meta.contextTokens}`,
    `generated_by: ${JSON.stringify(meta.generatedBy)}`,
    `created: ${meta.createdAt.toISOString()}`,
    '---',
  ].join('\n');
  return `${frontMatter}\n\n${stripOuterCodeFence(markdown).trim()}\n`;
}

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');
  return slug || 'session';
}

/** Local time as `YYYY-MM-DD-HHmm`, so files sort chronologically. */
export function fileTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}`
  );
}

/** Models sometimes wrap the whole document in a ```markdown fence; unwrap it. */
export function stripOuterCodeFence(text: string): string {
  const match = /^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i.exec(text);
  return match ? match[1] : text;
}

async function ensureGitignore(dir: string): Promise<void> {
  try {
    await fs.writeFile(path.join(dir, '.gitignore'), GITIGNORE_CONTENT, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

async function uniquePath(dir: string, base: string, extension: string): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    const candidate = path.join(dir, `${attempt === 1 ? base : `${base}-${attempt}`}${extension}`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
}
