import { describe, expect, it } from 'vitest';
import { cleanPromptText, parseLine } from '../src/transcript/parser';
import { aiTitle, assistant, compactBoundary, customTitle, toolResult, userPrompt } from './helpers/transcript';

describe('parseLine', () => {
  it('extracts usage, model and content blocks from assistant entries', () => {
    const event = parseLine(
      assistant({
        id: 'msg_1',
        input: 3,
        cacheWrite: 200,
        cacheRead: 5_000,
        output: 42,
        content: [
          { type: 'text', text: 'hi' },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
          { type: 'thinking', thinking: 'hidden' },
        ],
      }),
    );
    if (event?.kind !== 'assistant') throw new Error('expected an assistant event');
    expect(event).toMatchObject({
      messageId: 'msg_1',
      model: 'claude-opus-5',
      usage: { input: 3, cacheWrite: 200, cacheRead: 5_000, output: 42 },
      isSidechain: false,
      cwd: '/work/project',
      gitBranch: 'main',
    });
    expect(event.blocks).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
    ]);
  });

  it('ignores synthetic assistant messages', () => {
    expect(parseLine(assistant({ model: '<synthetic>' }))).toBeNull();
  });

  it('distinguishes tool results from prompts', () => {
    expect(parseLine(toolResult())).toMatchObject({ kind: 'toolResult' });
    expect(parseLine(userPrompt('Fix the bug'))).toMatchObject({ kind: 'userPrompt', text: 'Fix the bug' });
  });

  it('skips meta entries and flags compaction summaries', () => {
    expect(parseLine(userPrompt('caveat', { isMeta: true }))).toBeNull();
    expect(parseLine(userPrompt('Summary of earlier work', { isCompactSummary: true }))).toMatchObject({
      kind: 'userPrompt',
      isCompactSummary: true,
    });
  });

  it('reads titles by source', () => {
    expect(parseLine(aiTitle('Parser refactor'))).toEqual({ kind: 'title', title: 'Parser refactor', source: 'ai' });
    expect(parseLine(customTitle('Mine'))).toEqual({ kind: 'title', title: 'Mine', source: 'custom' });
  });

  it('recognises compact boundaries', () => {
    expect(parseLine(compactBoundary())).toMatchObject({ kind: 'compactBoundary', preTokens: 180_000 });
  });

  it('returns null for blank, malformed and irrelevant lines', () => {
    for (const line of ['', '   ', 'not json', '{broken', '{"type":"file-history-snapshot"}', '[1,2]']) {
      expect(parseLine(line)).toBeNull();
    }
  });
});

describe('cleanPromptText', () => {
  it('removes injected wrapper tags', () => {
    expect(cleanPromptText('<system-reminder>be nice</system-reminder>\nFix the bug')).toBe('Fix the bug');
    expect(cleanPromptText('<ide_opened_file>a.ts</ide_opened_file>')).toBe('');
  });

  it('rewrites slash-command markup to the command the user typed', () => {
    const markup =
      '<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>12</command-args>';
    expect(cleanPromptText(markup)).toBe('/review 12');
    expect(cleanPromptText('<command-name>/clear</command-name>')).toBe('/clear');
  });
});
