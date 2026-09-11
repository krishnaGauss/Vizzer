export type ModelFamily = 'opus' | 'sonnet' | 'haiku' | 'fable' | 'unknown';

export interface ModelInfo {
  id: string;
  family: ModelFamily;
  major?: number;
  minor?: number;
  /** Human-readable name such as "Opus 5" or "Haiku 4.5". */
  label: string;
  /** True when the id explicitly requests the 1M-token window (`[1m]` suffix). */
  extendedContext: boolean;
}

export const STANDARD_CONTEXT_WINDOW = 200_000;
export const EXTENDED_CONTEXT_WINDOW = 1_000_000;

/** e.g. `claude-opus-5`, `claude-haiku-4-5-20251001`, `claude-fable-5-1`. The minor must not be a date. */
const MODERN_ID = /claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?!\d)/i;
/** e.g. `claude-3-5-sonnet-20241022`. */
const LEGACY_ID = /claude-(\d+)(?:-(\d{1,2}))?-(opus|sonnet|haiku)/i;
const EXTENDED_SUFFIX = /\[1m\]$/i;

export function describeModel(id: string | undefined): ModelInfo {
  if (!id) return { id: '', family: 'unknown', label: 'No model yet', extendedContext: false };

  const extendedContext = EXTENDED_SUFFIX.test(id);
  const modern = MODERN_ID.exec(id);
  if (modern) {
    return build(id, modern[1], Number(modern[2]), optionalNumber(modern[3]), extendedContext);
  }
  const legacy = LEGACY_ID.exec(id);
  if (legacy) {
    return build(id, legacy[3], Number(legacy[1]), optionalNumber(legacy[2]), extendedContext);
  }
  return { id, family: 'unknown', label: id.replace(EXTENDED_SUFFIX, ''), extendedContext };
}

/** The window a model runs with by default in Claude Code, per the model configuration docs. */
export function nativeContextWindow(info: ModelInfo): number {
  if (info.extendedContext) return EXTENDED_CONTEXT_WINDOW;
  const major = info.major ?? 0;
  const minor = info.minor ?? 0;
  switch (info.family) {
    case 'fable':
      return EXTENDED_CONTEXT_WINDOW;
    case 'sonnet':
      return major >= 5 ? EXTENDED_CONTEXT_WINDOW : STANDARD_CONTEXT_WINDOW;
    case 'opus':
      return major > 4 || (major === 4 && minor >= 7) ? EXTENDED_CONTEXT_WINDOW : STANDARD_CONTEXT_WINDOW;
    default:
      return STANDARD_CONTEXT_WINDOW;
  }
}

/**
 * Best estimate of a session's context window. Transcripts don't record the window, so this uses the
 * model's default, upgrades to 1M when the session has already exceeded 200k, and honours an override.
 */
export function resolveContextWindow(modelId: string | undefined, peakContextTokens: number, override = 0): number {
  if (override > 0) return override;
  const native = nativeContextWindow(describeModel(modelId));
  return peakContextTokens > native ? Math.max(EXTENDED_CONTEXT_WINDOW, native) : native;
}

function build(id: string, family: string, major: number, minor: number | undefined, extendedContext: boolean): ModelInfo {
  const normalized = family.toLowerCase() as ModelFamily;
  const name = normalized.charAt(0).toUpperCase() + normalized.slice(1);
  const version = minor === undefined ? `${major}` : `${major}.${minor}`;
  return { id, family: normalized, major, minor, label: `${name} ${version}`, extendedContext };
}

function optionalNumber(value: string | undefined): number | undefined {
  return value === undefined ? undefined : Number(value);
}
