import { promises as fs } from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  ClaudeCliError,
  buildPrintArgs,
  parsePrintOutput,
  resolveClaudeBinary,
  runClaudePrint,
} from '../src/handoff/claudeCli';
import { makeTempDir } from './helpers/transcript';

const posixOnly = it.skipIf(process.platform === 'win32');

async function writeScript(dir: string, name: string, body: string): Promise<string> {
  const file = path.join(dir, name);
  await fs.writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

describe('parsePrintOutput', () => {
  it('reads a successful result', () => {
    const stdout = JSON.stringify({
      type: 'result',
      is_error: false,
      result: '# Handoff\n',
      total_cost_usd: 0.01,
      duration_ms: 1_200,
    });
    expect(parsePrintOutput(stdout, 0)).toEqual({ text: '# Handoff', costUsd: 0.01, durationMs: 1_200 });
  });

  it('surfaces errors reported by claude', () => {
    const stdout = JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in' });
    expect(() => parsePrintOutput(stdout, 1)).toThrowError(new ClaudeCliError('failed', 'Not logged in'));
  });

  it('includes stderr when the output is not JSON', () => {
    expect(() => parsePrintOutput('', 1, 'boom')).toThrow(/code 1: boom/);
  });

  it('rejects empty responses', () => {
    const stdout = JSON.stringify({ type: 'result', is_error: false, result: '  ' });
    expect(() => parsePrintOutput(stdout, 0)).toThrow(ClaudeCliError);
  });
});

describe('buildPrintArgs', () => {
  it('asks for a one-shot, tool-less, non-persisted run', () => {
    const args = buildPrintArgs('haiku', 'system text');
    expect(args).toContain('-p');
    expect(args).toContain('--no-session-persistence');
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'haiku']);
    expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual(['--tools', '']);
    expect(args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 2)).toEqual([
      '--output-format',
      'json',
    ]);
  });
});

describe('resolveClaudeBinary', () => {
  posixOnly('uses an explicitly configured executable', async () => {
    const script = await writeScript(await makeTempDir(), 'claude', 'exit 0');
    expect(await resolveClaudeBinary({ configuredPath: script, useLoginShell: false })).toBe(script);
  });

  it('fails clearly when the configured path is not executable', async () => {
    await expect(
      resolveClaudeBinary({ configuredPath: '/definitely/not/here/claude', useLoginShell: false }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  posixOnly('finds claude on PATH', async () => {
    const dir = await makeTempDir();
    const script = await writeScript(dir, 'claude', 'exit 0');
    const resolved = await resolveClaudeBinary({
      env: { PATH: dir },
      home: await makeTempDir(),
      platform: 'linux',
      useLoginShell: false,
    });
    expect(resolved).toBe(script);
  });
});

describe('runClaudePrint', () => {
  posixOnly('sends the prompt on stdin and returns the result text', async () => {
    const dir = await makeTempDir();
    const script = await writeScript(
      dir,
      'claude',
      'input=$(cat)\nprintf \'{"type":"result","is_error":false,"result":"args=%s bytes=%s"}\' "$#" "${#input}"',
    );
    const result = await runClaudePrint({
      binary: script,
      model: 'haiku',
      prompt: 'hello',
      systemPrompt: 'system text',
      cwd: dir,
      timeoutMs: 5_000,
    });
    expect(result.text).toBe(`args=${buildPrintArgs('haiku', 'system text').length} bytes=5`);
  });

  posixOnly('times out a hung process', async () => {
    const dir = await makeTempDir();
    const script = await writeScript(dir, 'claude', 'sleep 5');
    await expect(
      runClaudePrint({ binary: script, model: 'haiku', prompt: '', systemPrompt: '', cwd: dir, timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  posixOnly('stops when cancelled', async () => {
    const dir = await makeTempDir();
    const script = await writeScript(dir, 'claude', 'sleep 5');
    const controller = new AbortController();
    const run = runClaudePrint({
      binary: script,
      model: 'haiku',
      prompt: '',
      systemPrompt: '',
      cwd: dir,
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(run).rejects.toMatchObject({ code: 'cancelled' });
  });
});
