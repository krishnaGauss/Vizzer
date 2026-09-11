import { promises as fs } from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  encodeProjectPath,
  findProjectDirs,
  isSameOrInside,
  resolveClaudeConfigDir,
} from '../src/sessions/claudePaths';
import { assistant, makeTempDir, writeLines } from './helpers/transcript';

describe('encodeProjectPath', () => {
  it('replaces every non-alphanumeric character with a dash', () => {
    expect(encodeProjectPath('/Users/me/Code/my_app.v2')).toBe('-Users-me-Code-my-app-v2');
  });
});

describe('resolveClaudeConfigDir', () => {
  it('prefers the setting, then CLAUDE_CONFIG_DIR, then ~/.claude', () => {
    expect(resolveClaudeConfigDir('~/custom', {}, '/home/me')).toBe(path.join('/home/me', 'custom'));
    expect(resolveClaudeConfigDir('', { CLAUDE_CONFIG_DIR: '/env/claude' }, '/home/me')).toBe('/env/claude');
    expect(resolveClaudeConfigDir('', {}, '/home/me')).toBe(path.join('/home/me', '.claude'));
  });
});

describe('isSameOrInside', () => {
  it('matches the folder itself and its descendants only', () => {
    expect(isSameOrInside('/work/app', '/work/app')).toBe(true);
    expect(isSameOrInside('/work/app/server', '/work/app')).toBe(true);
    expect(isSameOrInside('/work/app-old', '/work/app')).toBe(false);
    expect(isSameOrInside('/work', '/work/app')).toBe(false);
  });
});

describe('findProjectDirs', () => {
  it('finds exact and nested project folders and rejects look-alike siblings', async () => {
    const root = await makeTempDir();
    const exact = path.join(root, '-work-app');
    const nested = path.join(root, '-work-app-server');
    const sibling = path.join(root, '-work-app-old');
    await fs.mkdir(exact);
    await writeLines(path.join(nested, 's1.jsonl'), [assistant({ cwd: '/work/app/server' })]);
    await writeLines(path.join(sibling, 's2.jsonl'), [assistant({ cwd: '/work/app-old' })]);
    await fs.mkdir(path.join(root, '-other'));

    expect((await findProjectDirs(root, '/work/app')).sort()).toEqual([exact, nested].sort());
  });

  it('returns nothing when the projects folder does not exist', async () => {
    expect(await findProjectDirs(path.join(await makeTempDir(), 'missing'), '/work/app')).toEqual([]);
  });
});
