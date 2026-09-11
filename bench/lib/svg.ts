/**
 * Dependency-free SVG charts for the benchmark report. Static images for a README, so identity is
 * carried by a legend plus direct end labels, and every value also appears in the report's tables.
 * Colours are the validated reference palette (light surface).
 */

export const THEME = {
  surface: '#fcfcfb',
  border: 'rgba(11,11,11,0.10)',
  ink: '#0b0b0b',
  inkSecondary: '#52514e',
  muted: '#898781',
  grid: '#e1e0d9',
  baseline: '#c3c2b7',
  /** Categorical slots 1 and 2 (blue, orange), assigned in fixed order. */
  series: ['#2a78d6', '#eb6834'] as const,
  font: "'Helvetica Neue', Helvetica, Arial, sans-serif",
} as const;

export interface LineSeries {
  name: string;
  color: string;
  values: ReadonlyArray<number | null>;
}

export interface ChartMarker {
  /** Fractional x index, e.g. 6.5 sits between the 7th and 8th category. */
  at: number;
  label: string;
}

export interface LineChartSpec {
  title: string;
  subtitle: string;
  description: string;
  xLabels: readonly string[];
  xTitle: string;
  formatY: (value: number) => string;
  series: readonly LineSeries[];
  markers?: readonly ChartMarker[];
}

export interface BarChartSpec {
  title: string;
  subtitle: string;
  description: string;
  categories: readonly string[];
  values: readonly number[];
  color: string;
  xTitle: string;
  formatY: (value: number) => string;
  formatValue: (value: number) => string;
}

const LINE_SIZE = { width: 840, height: 440 };
const LINE_MARGIN = { top: 124, right: 150, bottom: 64, left: 72 };
const BAR_SIZE = { width: 640, height: 400 };
const BAR_MARGIN = { top: 100, right: 40, bottom: 64, left: 72 };
const TITLE_X = 32;
const MAX_BAR_WIDTH = 24;
const BAR_RADIUS = 4;
/** End labels closer than this (px) would collide; the legend then carries identity alone. */
const MIN_LABEL_GAP = 34;

export function lineChart(spec: LineChartSpec): string {
  const { width, height } = LINE_SIZE;
  const plot = {
    x0: LINE_MARGIN.left,
    x1: width - LINE_MARGIN.right,
    y0: LINE_MARGIN.top,
    y1: height - LINE_MARGIN.bottom,
  };
  const values = spec.series.flatMap((series) => series.values.filter((value): value is number => value !== null));
  const scale = niceScale(Math.max(1, ...values));
  const count = spec.xLabels.length;
  const x = (index: number): number => plot.x0 + (count <= 1 ? 0 : (index / (count - 1)) * (plot.x1 - plot.x0));
  const y = (value: number): number => plot.y1 - (value / scale.max) * (plot.y1 - plot.y0);

  const parts: string[] = [];
  for (const tick of scale.ticks) {
    const ty = y(tick);
    parts.push(hline(plot.x0, plot.x1, ty, tick === 0 ? THEME.baseline : THEME.grid));
    parts.push(text(plot.x0 - 10, ty + 4, spec.formatY(tick), { anchor: 'end', fill: THEME.muted, tabular: true }));
  }
  spec.xLabels.forEach((label, index) =>
    parts.push(text(x(index), plot.y1 + 22, label, { anchor: 'middle', fill: THEME.muted, tabular: true })),
  );
  parts.push(text((plot.x0 + plot.x1) / 2, height - 18, spec.xTitle, { anchor: 'middle', fill: THEME.inkSecondary }));

  for (const marker of spec.markers ?? []) {
    const mx = x(marker.at);
    parts.push(`<line x1="${n(mx)}" x2="${n(mx)}" y1="${n(plot.y0 - 10)}" y2="${n(plot.y1)}" stroke="${THEME.muted}" stroke-width="1"/>`);
    parts.push(text(mx + 6, plot.y0 - 14, marker.label, { fill: THEME.inkSecondary }));
  }

  for (const series of spec.series) {
    for (const segment of segments(series.values)) {
      const d = segment.map(([index, value], i) => `${i === 0 ? 'M' : 'L'}${n(x(index))},${n(y(value))}`).join(' ');
      parts.push(
        `<path d="${d}" fill="none" stroke="${series.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`,
      );
    }
  }

  const ends = spec.series
    .map((series) => {
      const index = lastIndex(series.values);
      return index < 0 ? undefined : { series, px: x(index), py: y(series.values[index] as number), value: series.values[index] as number };
    })
    .filter((end): end is NonNullable<typeof end> => end !== undefined);
  const labelsFit = ends.every((a, i) => ends.every((b, j) => i === j || Math.abs(a.py - b.py) >= MIN_LABEL_GAP));
  for (const end of ends) {
    parts.push(dot(end.px, end.py, end.series.color));
    if (!labelsFit) continue;
    parts.push(text(end.px + 12, end.py - 1, spec.formatY(end.value), { size: 13, weight: 600, tabular: true }));
    parts.push(text(end.px + 12, end.py + 15, end.series.name, { fill: THEME.inkSecondary }));
  }

  return frame(width, height, spec.title, spec.subtitle, spec.description, [legend(spec.series, 92), ...parts]);
}

export function barChart(spec: BarChartSpec): string {
  const { width, height } = BAR_SIZE;
  const plot = { x0: BAR_MARGIN.left, x1: width - BAR_MARGIN.right, y0: BAR_MARGIN.top, y1: height - BAR_MARGIN.bottom };
  const scale = niceScale(Math.max(1e-9, ...spec.values));
  const band = (plot.x1 - plot.x0) / spec.categories.length;
  const barWidth = Math.min(MAX_BAR_WIDTH, band * 0.5);
  const y = (value: number): number => plot.y1 - (value / scale.max) * (plot.y1 - plot.y0);

  const parts: string[] = [];
  for (const tick of scale.ticks) {
    const ty = y(tick);
    parts.push(hline(plot.x0, plot.x1, ty, tick === 0 ? THEME.baseline : THEME.grid));
    parts.push(text(plot.x0 - 10, ty + 4, spec.formatY(tick), { anchor: 'end', fill: THEME.muted, tabular: true }));
  }
  spec.categories.forEach((category, index) => {
    const cx = plot.x0 + band * (index + 0.5);
    const top = y(spec.values[index]);
    parts.push(`<path d="${columnPath(cx, top, plot.y1, barWidth)}" fill="${spec.color}"/>`);
    parts.push(text(cx, top - 8, spec.formatValue(spec.values[index]), { anchor: 'middle', size: 13, weight: 600, tabular: true }));
    parts.push(text(cx, plot.y1 + 22, category, { anchor: 'middle', fill: THEME.muted, tabular: true }));
  });
  parts.push(text((plot.x0 + plot.x1) / 2, height - 18, spec.xTitle, { anchor: 'middle', fill: THEME.inkSecondary }));

  return frame(width, height, spec.title, spec.subtitle, spec.description, parts);
}

/** Rounds the axis up to a clean maximum with 4–6 evenly spaced ticks (1, 2, 2.5 or 5 × 10ⁿ). */
export function niceScale(maxValue: number, targetTicks = 5): { max: number; ticks: number[] } {
  const rough = maxValue / (targetTicks - 1);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((multiple) => multiple * magnitude).find((candidate) => candidate >= rough) ?? 10 * magnitude;
  const max = Math.ceil(maxValue / step) * step;
  const ticks: number[] = [];
  for (let tick = 0; tick <= max + step / 2; tick += step) ticks.push(Number(tick.toPrecision(12)));
  return { max, ticks };
}

function frame(width: number, height: number, title: string, subtitle: string, description: string, body: string[]): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${THEME.font}" role="img" aria-labelledby="title desc">`,
    `<title id="title">${escapeXml(title)}</title>`,
    `<desc id="desc">${escapeXml(description)}</desc>`,
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="12" fill="${THEME.surface}" stroke="${THEME.border}"/>`,
    text(TITLE_X, 40, title, { size: 20, weight: 600 }),
    text(TITLE_X, 64, subtitle, { size: 13, fill: THEME.inkSecondary }),
    ...body,
    '</svg>',
    '',
  ].join('\n');
}

function legend(series: readonly LineSeries[], top: number): string {
  let x = TITLE_X;
  const items: string[] = [];
  for (const item of series) {
    items.push(`<line x1="${x}" x2="${x + 18}" y1="${top}" y2="${top}" stroke="${item.color}" stroke-width="2" stroke-linecap="round"/>`);
    // No surface ring here: in the key it would break the line and read as a dashed (threshold) style.
    items.push(`<circle cx="${n(x + 9)}" cy="${n(top)}" r="4" fill="${item.color}"/>`);
    items.push(text(x + 26, top + 4, item.name, { size: 13, fill: THEME.inkSecondary }));
    x += 26 + estimateTextWidth(item.name, 13) + 24;
  }
  return items.join('\n');
}

function dot(cx: number, cy: number, color: string): string {
  return `<circle cx="${n(cx)}" cy="${n(cy)}" r="4" fill="${color}" stroke="${THEME.surface}" stroke-width="2"/>`;
}

function hline(x0: number, x1: number, y: number, color: string): string {
  return `<line x1="${n(x0)}" x2="${n(x1)}" y1="${n(y)}" y2="${n(y)}" stroke="${color}" stroke-width="1"/>`;
}

/** A column with a 4px rounded data end and a square foot on the baseline. */
function columnPath(cx: number, top: number, bottom: number, width: number): string {
  const x0 = cx - width / 2;
  const x1 = cx + width / 2;
  const r = Math.min(BAR_RADIUS, width / 2, Math.max(0, bottom - top));
  return `M${n(x0)},${n(bottom)} V${n(top + r)} A${r},${r} 0 0 1 ${n(x0 + r)},${n(top)} H${n(x1 - r)} A${r},${r} 0 0 1 ${n(x1)},${n(top + r)} V${n(bottom)} Z`;
}

interface TextOptions {
  anchor?: 'start' | 'middle' | 'end';
  size?: number;
  weight?: number;
  fill?: string;
  tabular?: boolean;
}

function text(x: number, y: number, content: string, options: TextOptions = {}): string {
  const attributes = [
    `x="${n(x)}"`,
    `y="${n(y)}"`,
    `font-size="${options.size ?? 12}"`,
    options.weight ? `font-weight="${options.weight}"` : '',
    `fill="${options.fill ?? THEME.ink}"`,
    `text-anchor="${options.anchor ?? 'start'}"`,
    options.tabular ? 'style="font-variant-numeric: tabular-nums"' : '',
  ].filter(Boolean);
  return `<text ${attributes.join(' ')}>${escapeXml(content)}</text>`;
}

function segments(values: ReadonlyArray<number | null>): Array<Array<[number, number]>> {
  const result: Array<Array<[number, number]>> = [];
  let current: Array<[number, number]> = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (current.length > 0) result.push(current);
      current = [];
    } else {
      current.push([index, value]);
    }
  });
  if (current.length > 0) result.push(current);
  return result;
}

function lastIndex(values: ReadonlyArray<number | null>): number {
  for (let index = values.length - 1; index >= 0; index -= 1) if (values[index] !== null) return index;
  return -1;
}

function estimateTextWidth(content: string, size: number): number {
  return content.length * size * 0.56;
}

function n(value: number): string {
  return Number(value.toFixed(1)).toString();
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
