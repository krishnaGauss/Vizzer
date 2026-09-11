/** Compact token count: 950, 9.5k, 182k, 1.25M. */
export function formatTokens(value: number): string {
  const n = Math.max(0, Math.round(value));
  if (n < 1_000) return String(n);
  if (n < 9_950) return `${trimDecimals(n / 1_000, 1)}k`;
  if (n < 999_500) return `${Math.round(n / 1_000)}k`;
  return `${trimDecimals(n / 1_000_000, n < 9_995_000 ? 2 : 1)}M`;
}

/** Full count with thousands separators: 182,340. */
export function formatCount(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

export function formatPercent(percent: number): string {
  if (percent > 0 && percent < 1) return '<1%';
  return `${Math.round(percent)}%`;
}

export function formatRelativeTime(timestamp: number | undefined, now = Date.now()): string {
  if (timestamp === undefined) return 'unknown';
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Collapses whitespace and cuts to `max` characters with an ellipsis. */
export function truncateText(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length <= max ? single : `${single.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function trimDecimals(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.?0+$/, '');
}
