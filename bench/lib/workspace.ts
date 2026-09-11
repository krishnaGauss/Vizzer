import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';

const ESC = String.fromCharCode(27);
const ANSI_ESCAPE = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

/** Removes terminal colour codes; some tools ignore FORCE_COLOR=0. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, '');
}

/** Files copied from the repository into each benchmark workspace. */
const WORKSPACE_ENTRIES = [
  'src',
  'test',
  'package.json',
  'tsconfig.json',
  'vitest.config.ts',
  'eslint.config.mjs',
  'esbuild.mjs',
  'README.md',
  '.gitignore',
];

/** Creates an isolated copy of the Vizzer codebase for one benchmark arm and returns its real path. */
export async function createWorkspace(repoRoot: string, target: string): Promise<string> {
  await fs.mkdir(target, { recursive: true });
  for (const entry of WORKSPACE_ENTRIES) {
    await fs.cp(path.join(repoRoot, entry), path.join(target, entry), { recursive: true });
  }
  // Share dependencies instead of reinstalling them.
  await fs.symlink(path.join(repoRoot, 'node_modules'), path.join(target, 'node_modules'), 'dir');
  return fs.realpath(target);
}

export interface CheckResult {
  ok: boolean;
  summary: string;
}

/** Runs a verification command (tests, typecheck) in a workspace. */
export function runCheck(cwd: string, command: string, args: string[]): Promise<CheckResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, CI: '1', FORCE_COLOR: '0' } });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.on('error', (error) => resolve({ ok: false, summary: error.message }));
    child.on('close', (code) => {
      const clean = stripAnsi(output);
      const testLine = /Tests\s+(.+)/.exec(clean)?.[1]?.trim();
      const errorCount = clean.match(/error TS\d+/g)?.length ?? 0;
      const summary = testLine ?? (code === 0 ? 'passed' : `${errorCount} error(s)`);
      resolve({ ok: code === 0, summary });
    });
  });
}
