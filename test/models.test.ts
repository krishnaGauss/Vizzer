import { describe, expect, it } from 'vitest';
import { describeModel, nativeContextWindow, resolveContextWindow } from '../src/core/models';

describe('describeModel', () => {
  it.each([
    ['claude-opus-5', 'Opus 5', 'opus', 1_000_000],
    ['claude-sonnet-5', 'Sonnet 5', 'sonnet', 1_000_000],
    ['claude-fable-5-1', 'Fable 5.1', 'fable', 1_000_000],
    ['claude-haiku-4-5-20251001', 'Haiku 4.5', 'haiku', 200_000],
    ['claude-opus-4-6', 'Opus 4.6', 'opus', 200_000],
    ['claude-opus-4-7', 'Opus 4.7', 'opus', 1_000_000],
    ['claude-sonnet-4-6[1m]', 'Sonnet 4.6', 'sonnet', 1_000_000],
    ['claude-3-5-sonnet-20241022', 'Sonnet 3.5', 'sonnet', 200_000],
  ])('%s → %s', (id, label, family, window) => {
    const info = describeModel(id);
    expect(info.label).toBe(label);
    expect(info.family).toBe(family);
    expect(nativeContextWindow(info)).toBe(window);
  });

  it('labels missing and unrecognised models', () => {
    expect(describeModel(undefined).label).toBe('No model yet');
    expect(describeModel('some-other-model')).toMatchObject({ family: 'unknown', label: 'some-other-model' });
  });
});

describe('resolveContextWindow', () => {
  it('upgrades to the extended window once a session exceeds 200k tokens', () => {
    expect(resolveContextWindow('claude-opus-4-6', 150_000)).toBe(200_000);
    expect(resolveContextWindow('claude-opus-4-6', 250_000)).toBe(1_000_000);
  });

  it('honours an explicit override', () => {
    expect(resolveContextWindow('claude-opus-5', 0, 200_000)).toBe(200_000);
  });
});
