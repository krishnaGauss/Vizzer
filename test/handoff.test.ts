import { promises as fs } from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { TranscriptDigest } from '../src/handoff/digest';
import { slugify, stripOuterCodeFence, writeHandoffFile, type HandoffMetadata } from '../src/handoff/handoffFile';
import { buildContinuationPrompt, buildHandoffRequest } from '../src/handoff/prompt';
import { makeTempDir } from './helpers/transcript';

const meta: HandoffMetadata = {
  sessionId: 's1',
  title: 'Parser refactor',
  model: 'claude-opus-5',
  contextTokens: 312_000,
  generatedBy: 'Vizzer (test)',
  createdAt: new Date(2026, 8, 11, 17, 5),
};

describe('writeHandoffFile', () => {
  it('writes front matter plus the document, and a self-contained .gitignore', async () => {
    const root = await makeTempDir();
    const file = await writeHandoffFile(root, '```markdown\n# Handoff: Parser\n## Goal\nShip it\n```', meta);

    expect(file).toBe(path.join(root, '.vizzer', 'handoffs', '2026-09-11-1705-parser-refactor.md'));
    const content = await fs.readFile(file, 'utf8');
    expect(content.startsWith('---\nsource_session: s1\nsource_title: "Parser refactor"\n')).toBe(true);
    expect(content).toContain('context_tokens_at_handoff: 312000');
    expect(content).toContain('# Handoff: Parser\n## Goal\nShip it\n');
    expect(content).not.toContain('```');
    expect(await fs.readFile(path.join(root, '.vizzer', '.gitignore'), 'utf8')).toContain('*');
  });

  it('never overwrites an earlier handoff', async () => {
    const root = await makeTempDir();
    const first = await writeHandoffFile(root, '# One', meta);
    const second = await writeHandoffFile(root, '# Two', meta);
    expect(second).toBe(first.replace(/\.md$/, '-2.md'));
  });

  it('leaves an existing .vizzer/.gitignore untouched', async () => {
    const root = await makeTempDir();
    await fs.mkdir(path.join(root, '.vizzer'));
    await fs.writeFile(path.join(root, '.vizzer', '.gitignore'), 'custom\n');
    await writeHandoffFile(root, '# Doc', meta);
    expect(await fs.readFile(path.join(root, '.vizzer', '.gitignore'), 'utf8')).toBe('custom\n');
  });
});

describe('slugify and stripOuterCodeFence', () => {
  it('produces short, safe file slugs', () => {
    expect(slugify('Fix: the API (v2)!')).toBe('fix-the-api-v2');
    expect(slugify('???')).toBe('session');
    const long = slugify('a very long title that keeps going and going well past the limit');
    expect(long.length).toBeLessThanOrEqual(48);
    expect(long.endsWith('-')).toBe(false);
  });

  it('only unwraps a fence around the whole document', () => {
    expect(stripOuterCodeFence('```md\n# Doc\n```')).toBe('# Doc');
    const inner = '# Doc\n```ts\nconst a = 1;\n```';
    expect(stripOuterCodeFence(inner)).toBe(inner);
  });
});

describe('buildContinuationPrompt', () => {
  it('references the handoff with a forward-slash path that survives URI encoding', () => {
    const prompt = buildContinuationPrompt(path.join('.vizzer', 'handoffs', 'a.md'));
    expect(prompt).toContain('@.vizzer/handoffs/a.md');
    expect(prompt).not.toMatch(/[&=#]/);
    expect(decodeURIComponent(encodeURIComponent(prompt))).toBe(prompt);
  });
});

describe('buildHandoffRequest', () => {
  const digest: TranscriptDigest = {
    conversation: '[USER] Build it',
    filesTouched: ['src/a.ts'],
    todos: [{ content: 'Write tests', status: 'in_progress' }],
    userTurns: 1,
    condensed: true,
  };

  it('bundles instructions, session facts, files, todos and the digest', () => {
    const request = buildHandoffRequest(
      { sessionId: 's1', title: 'Build', modelLabel: 'Opus 5', contextTokens: 312_000, gitBranch: 'main' },
      digest,
    );
    expect(request).toContain('## Next steps');
    expect(request).toContain('context_tokens_at_handoff: 312,000');
    expect(request).toContain('git_branch: main');
    expect(request).toContain('note: the middle of the conversation was condensed');
    expect(request).toContain('- src/a.ts');
    expect(request).toContain('- [in_progress] Write tests');
    expect(request).toContain('<transcript_digest>\n[USER] Build it\n</transcript_digest>');
  });
});
