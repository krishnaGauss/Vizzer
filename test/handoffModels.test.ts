import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HANDOFF_MODEL,
  HANDOFF_MODEL_CHOICES,
  findHandoffModelChoice,
  handoffModelDescription,
  handoffModelLabel,
} from '../src/handoff/handoffModels';

describe('handoff model catalog', () => {
  it('defaults to the strongest model and offers it first', () => {
    expect(DEFAULT_HANDOFF_MODEL).toBe('opus');
    expect(HANDOFF_MODEL_CHOICES[0].alias).toBe(DEFAULT_HANDOFF_MODEL);
    expect(HANDOFF_MODEL_CHOICES.map((choice) => choice.alias)).toEqual(['opus', 'sonnet', 'haiku']);
    expect(findHandoffModelChoice(DEFAULT_HANDOFF_MODEL)).toBeDefined();
  });

  it('matches aliases regardless of case and surrounding space', () => {
    expect(findHandoffModelChoice('  Haiku ')?.label).toBe('Haiku');
    expect(findHandoffModelChoice('claude-haiku-4-5-20251001')).toBeUndefined();
  });
});

describe('handoffModelLabel', () => {
  it('names aliases, full model IDs and custom values', () => {
    expect(handoffModelLabel('sonnet')).toBe('Sonnet');
    expect(handoffModelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(handoffModelLabel('some-internal-model')).toBe('some-internal-model');
  });

  it('falls back to the default when the setting is blank', () => {
    expect(handoffModelLabel('   ')).toBe('Opus');
  });
});

describe('handoffModelDescription', () => {
  it('describes the trade-off for known choices only', () => {
    expect(handoffModelDescription('opus')).toBe('Best quality');
    expect(handoffModelDescription('claude-sonnet-5')).toBe('');
  });
});
