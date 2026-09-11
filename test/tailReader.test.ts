import { promises as fs } from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { JsonlTailReader } from '../src/transcript/tailReader';
import { makeTempDir } from './helpers/transcript';

describe('JsonlTailReader', () => {
  let file: string;

  beforeEach(async () => {
    file = path.join(await makeTempDir(), 'session.jsonl');
  });

  it('returns only lines appended since the previous read', async () => {
    await fs.writeFile(file, '{"n":1}\n{"n":2}\n');
    const reader = new JsonlTailReader(file);
    expect((await reader.readNew()).lines).toEqual(['{"n":1}', '{"n":2}']);

    await fs.appendFile(file, '{"n":3}\n');
    expect((await reader.readNew()).lines).toEqual(['{"n":3}']);
    expect((await reader.readNew()).lines).toEqual([]);
  });

  it('holds back a partially written line until it is complete', async () => {
    await fs.writeFile(file, '{"a":1}\n{"b":');
    const reader = new JsonlTailReader(file);
    expect((await reader.readNew()).lines).toEqual(['{"a":1}']);

    await fs.appendFile(file, '2}\n');
    expect((await reader.readNew()).lines).toEqual(['{"b":2}']);
  });

  it('emits a complete trailing object even before its newline arrives', async () => {
    await fs.writeFile(file, '{"a":1}');
    const reader = new JsonlTailReader(file);
    expect((await reader.readNew()).lines).toEqual(['{"a":1}']);

    await fs.appendFile(file, '\n{"b":2}\n');
    expect((await reader.readNew()).lines).toEqual(['{"b":2}']);
  });

  it('restarts from the beginning when the file shrinks', async () => {
    await fs.writeFile(file, '{"n":1}\n{"n":2}\n{"n":3}\n');
    const reader = new JsonlTailReader(file);
    await reader.readNew();

    await fs.writeFile(file, '{"n":9}\n');
    expect(await reader.readNew()).toEqual({ lines: ['{"n":9}'], reset: true });
  });

  it('treats a missing file as empty', async () => {
    expect(await new JsonlTailReader(path.join(path.dirname(file), 'missing.jsonl')).readNew()).toEqual({
      lines: [],
      reset: false,
    });
  });

  it('decodes multi-byte characters that straddle read chunks', async () => {
    const text = `${'x'.repeat(1024 * 1024 - 10)}${'🙂'.repeat(10)}`;
    await fs.writeFile(file, `${JSON.stringify({ text })}\n`);
    const { lines } = await new JsonlTailReader(file).readNew();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).text).toBe(text);
  });
});
