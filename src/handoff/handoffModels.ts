import { describeModel } from '../core/models';

/** The models offered in the handoff-model picker, best first. */
export interface HandoffModelChoice {
  /** Value stored in `vizzer.handoff.model`; a CLI alias always resolves to the newest model of that family. */
  alias: string;
  /** Short name shown in the picker and the sidebar. */
  label: string;
  /** One-line trade-off, shown next to the label. */
  description: string;
  /** Longer explanation for the picker. */
  detail: string;
}

/** Handoffs are the one place where quality matters most, so the strongest model is the default. */
export const DEFAULT_HANDOFF_MODEL = 'opus';

export const HANDOFF_MODEL_CHOICES: readonly HandoffModelChoice[] = [
  {
    alias: 'opus',
    label: 'Opus',
    description: 'Best quality',
    detail: 'Keeps the most detail and nuance from a long session. Slowest and most expensive.',
  },
  {
    alias: 'sonnet',
    label: 'Sonnet',
    description: 'Balanced',
    detail: 'Close to Opus on handoff quality, noticeably faster and cheaper.',
  },
  {
    alias: 'haiku',
    label: 'Haiku',
    description: 'Fastest & cheapest',
    detail: 'Turns even a large session around in seconds; may drop finer details.',
  },
];

/** The catalog entry for a stored setting value, or `undefined` for a custom alias or model ID. */
export function findHandoffModelChoice(model: string): HandoffModelChoice | undefined {
  const value = model.trim().toLowerCase();
  return HANDOFF_MODEL_CHOICES.find((choice) => choice.alias === value);
}

/** Human-readable name for whatever `vizzer.handoff.model` holds: an alias, a full model ID or a custom value. */
export function handoffModelLabel(model: string): string {
  const value = model.trim();
  if (!value) return handoffModelLabel(DEFAULT_HANDOFF_MODEL);

  const choice = findHandoffModelChoice(value);
  if (choice) return choice.label;

  const described = describeModel(value);
  return described.family === 'unknown' ? value : described.label;
}

/** The trade-off line for a known choice; empty for a custom model, where we can't claim one. */
export function handoffModelDescription(model: string): string {
  return findHandoffModelChoice(model)?.description ?? '';
}
