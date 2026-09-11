import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { DigestCollector, buildDigest, fitToBudget } from '../src/handoff/digest';
import { parseLine } from '../src/transcript/parser';
import { assistant, makeTempDir, userPrompt, writeLines } from './helpers/transcript';

function collect(lines: readonly string[]): DigestCollector {
  const collector = new DigestCollector();
  for (const line of lines) {
    const event = parseLine(line);
    if (event) collector.add(event);
  }
  return collector;
}

describe('DigestCollector', () => {
  it('renders prompts, replies and one-line tool calls in order', () => {
    const digest = collect([
      userPrompt('Add a login page'),
      assistant({
        content: [
          { type: 'text', text: 'I will add it.' },
          { type: 'tool_use', name: 'Write', input: { file_path: '/work/project/src/login.tsx', content: '<Login />' } },
          { type: 'tool_use', name: 'Bash', input: { command: 'npm   test\n --watch=false' } },
        ],
      }),
    ]).finish(100_000);

    expect(digest.conversation).toBe(
      ['[USER] Add a login page', '[CLAUDE] I will add it.', '  → Write: src/login.tsx', '  → Bash: npm test --watch=false'].join(
        '\n',
      ),
    );
    expect(digest.filesTouched).toEqual(['src/login.tsx']);
    expect(digest.userTurns).toBe(1);
    expect(digest.condensed).toBe(false);
  });

  it('keeps only the latest todo list', () => {
    const todoWrite = (todos: unknown[]) =>
      assistant({ content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos } }] });
    const digest = collect([
      todoWrite([{ content: 'Old task', status: 'pending' }]),
      todoWrite([
        { content: 'Write parser', status: 'completed' },
        { content: 'Write tests', status: 'in_progress' },
      ]),
    ]).finish(100_000);

    expect(digest.todos).toEqual([
      { content: 'Write parser', status: 'completed' },
      { content: 'Write tests', status: 'in_progress' },
    ]);
  });

  it('skips subagent traffic and repeated streamed blocks', () => {
    const block = [{ type: 'text', text: 'Same streamed text' }];
    const digest = collect([
      assistant({ id: 'msg_1', content: block }),
      assistant({ id: 'msg_1', content: block }),
      assistant({ sidechain: true, content: [{ type: 'text', text: 'Subagent chatter' }] }),
      userPrompt('Subagent prompt', { sidechain: true }),
    ]).finish(100_000);

    expect(digest.conversation).toBe('[CLAUDE] Same streamed text');
    expect(digest.userTurns).toBe(0);
  });

  it('includes compaction summaries', () => {
    const digest = collect([userPrompt('Earlier we built the API.', { isCompactSummary: true })]).finish(100_000);
    expect(digest.conversation).toBe('[SUMMARY OF EARLIER CONVERSATION]\nEarlier we built the API.');
  });
});

describe('fitToBudget', () => {
  it('returns everything when it fits', () => {
    expect(fitToBudget([{ kind: 'user', text: 'hi' }], 1_000)).toEqual({ text: '[USER] hi', condensed: false });
  });

  it('keeps the opening, the recent tail and abbreviated requests from the middle', () => {
    const lines: string[] = [];
    for (let index = 0; index < 200; index += 1) {
      lines.push(userPrompt(`Request ${index} ${'x'.repeat(400)}`));
      lines.push(assistant({ content: [{ type: 'text', text: `Reply ${index} ${'y'.repeat(1_000)}` }] }));
    }
    const { conversation, condensed } = collect(lines).finish(20_000);

    expect(condensed).toBe(true);
    expect(conversation.length).toBeLessThanOrEqual(20_200);
    expect(conversation).toContain('[USER] Request 0 ');
    expect(conversation).toContain('Reply 199 ');
    expect(conversation).toMatch(/\[… \d+ older item\(s\) omitted/);
    expect(conversation).toMatch(/\[USER\] Request \d+ x+ … \[\d+ more chars\]/);
  });
});

describe('buildDigest', () => {
  it('reads a transcript file from disk', async () => {
    const file = path.join(await makeTempDir(), 'session.jsonl');
    await writeLines(file, [userPrompt('Ship the release'), assistant({ content: [{ type: 'text', text: 'Shipped.' }] })]);
    const digest = await buildDigest(file, 10_000);
    expect(digest.conversation).toBe('[USER] Ship the release\n[CLAUDE] Shipped.');
  });
});
