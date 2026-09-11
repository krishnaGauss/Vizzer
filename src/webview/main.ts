import { formatPercent, formatRelativeTime, formatTokens } from '../core/format';
import type { Thresholds, UsageLevel } from '../core/levels';
import type { SessionView } from '../core/sessionView';
import { totalTokensOf, type TokenUsage } from '../transcript/types';
import type { HostToWebviewMessage, WebviewState, WebviewToHostMessage } from '../ui/webviewProtocol';

interface VsCodeApi {
  postMessage(message: WebviewToHostMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const RELATIVE_TIME_REFRESH_MS = 30_000;
const CHART_WIDTH = 300;
const CHART_HEIGHT = 84;
const CHART_HEADROOM = 1.15;

const LEVEL_LABEL: Record<UsageLevel, string> = { ok: 'Healthy', warn: 'Getting large', critical: 'Hand off' };
const USAGE_ROWS: ReadonlyArray<[label: string, key: keyof TokenUsage, hint: string]> = [
  ['Fresh input', 'input', 'Input tokens not served from the prompt cache'],
  ['Cache write', 'cacheWrite', 'Input tokens written to the prompt cache'],
  ['Cache read', 'cacheRead', 'Input tokens served from the prompt cache'],
  ['Output', 'output', 'Tokens Claude generated'],
];

const vscode = acquireVsCodeApi();
const root = document.getElementById('app') as HTMLElement;
let state = vscode.getState() as WebviewState | undefined;

window.addEventListener('message', (event: MessageEvent<HostToWebviewMessage>) => {
  if (event.data?.type !== 'state') return;
  state = event.data.state;
  vscode.setState(state);
  render();
});

root.addEventListener('click', (event) => {
  const target = (event.target as Element | null)?.closest<HTMLElement>('[data-action]');
  if (!target) return;
  const { action, id } = target.dataset;
  switch (action) {
    case 'select':
    case 'handoff':
    case 'openTranscript':
      if (id) vscode.postMessage({ type: action, id });
      break;
    case 'follow':
    case 'openSettings':
      vscode.postMessage({ type: action });
      break;
  }
});

setInterval(render, RELATIVE_TIME_REFRESH_MS);
if (state) render();
vscode.postMessage({ type: 'ready' });

function render(): void {
  const focusSelector = selectorForFocusedAction();

  if (!state || state.sessions.length === 0) {
    root.innerHTML = renderEmpty();
  } else {
    const current = state;
    const active = current.sessions.find((session) => session.id === current.activeId) ?? current.sessions[0];
    root.innerHTML = renderActive(active, current.thresholds) + renderList(current.sessions, active.id, current.following);
  }

  applyGeometry();
  if (focusSelector) root.querySelector<HTMLElement>(focusSelector)?.focus();
}

/** Re-rendering replaces the DOM; remember which control had focus so keyboard users keep their place. */
function selectorForFocusedAction(): string | undefined {
  const focused = document.activeElement;
  if (!(focused instanceof HTMLElement) || !focused.dataset.action) return undefined;
  const { action, id } = focused.dataset;
  return id ? `[data-action="${action}"][data-id="${CSS.escape(id)}"]` : `[data-action="${action}"]`;
}

/** Widths and offsets are applied through CSSOM because the webview CSP forbids inline style attributes. */
function applyGeometry(): void {
  root.querySelectorAll<HTMLElement>('[data-width]').forEach((element) => {
    element.style.width = `${element.dataset.width}%`;
  });
  root.querySelectorAll<HTMLElement>('[data-left]').forEach((element) => {
    element.style.left = `${element.dataset.left}%`;
  });
}

function renderActive(session: SessionView, thresholds: Thresholds): string {
  const percent = clampPercent(session.percent);
  const warnAt = effectiveThresholdPercent(thresholds.warnPercent, thresholds.warnTokens, session.contextWindow);
  const criticalAt = effectiveThresholdPercent(thresholds.criticalPercent, thresholds.criticalTokens, session.contextWindow);

  return `
    <section class="card level-${session.level}" aria-label="Focused session">
      <header>
        <h2 class="title" title="${escapeHtml(session.title)}">${escapeHtml(session.title)}</h2>
        <div class="chips">
          <span class="chip">${escapeHtml(session.modelLabel)}</span>
          ${session.gitBranch ? `<span class="chip muted" title="Git branch">${escapeHtml(session.gitBranch)}</span>` : ''}
          <span class="chip level">${LEVEL_LABEL[session.level]}</span>
        </div>
      </header>
      <div class="hero">
        <span class="hero-value">${formatTokens(session.contextTokens)}</span>
        <span class="hero-unit">tokens in context</span>
      </div>
      <p class="hero-caption">Re-sent with every message in this session.</p>
      <div class="gauge" role="meter" aria-label="Context window used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(percent)}">
        <div class="gauge-fill" data-width="${percent}"></div>
        <div class="gauge-tick warn" data-left="${warnAt}" title="Warning threshold"></div>
        <div class="gauge-tick critical" data-left="${criticalAt}" title="Handoff threshold"></div>
      </div>
      <div class="gauge-legend">
        <span>${formatPercent(session.percent)} of ${formatTokens(session.contextWindow)} window</span>
        <span>peak ${formatTokens(session.peakContextTokens)}</span>
      </div>
      ${renderAdvice(session, thresholds)}
      ${renderChart(session, thresholds)}
      ${renderBreakdown(session)}
      <p class="meta">${session.userTurns} prompts · ${session.assistantMessages} responses · active ${formatRelativeTime(session.lastActivity)}</p>
      <div class="actions">
        <button class="button ${session.level === 'ok' ? 'secondary' : 'primary'}" data-action="handoff" data-id="${escapeHtml(session.id)}">
          Create handoff &amp; new session
        </button>
        <button class="button secondary" data-action="openTranscript" data-id="${escapeHtml(session.id)}">Transcript</button>
      </div>
    </section>`;
}

function renderAdvice(session: SessionView, thresholds: Thresholds): string {
  const reason = session.reason ? escapeHtml(session.reason) : '';
  switch (session.level) {
    case 'critical':
      return `<p class="advice"><strong>Time for a fresh session.</strong> This session is ${reason}. A handoff keeps what matters and drops the rest.</p>`;
    case 'warn':
      return `<p class="advice"><strong>Context is getting large.</strong> This session is ${reason}. Plan a handoff at the next natural stopping point.</p>`;
    default: {
      const warnTokens = Math.min(thresholds.warnTokens, (thresholds.warnPercent / 100) * session.contextWindow);
      return `<p class="advice subtle">Healthy. Vizzer suggests a handoff from about ${formatTokens(warnTokens)} tokens.</p>`;
    }
  }
}

function renderChart(session: SessionView, thresholds: Thresholds): string {
  const values = session.series;
  if (values.length < 2) {
    return '<p class="chart-empty">The context chart appears after a few responses.</p>';
  }

  const peak = Math.max(...values, 1);
  const max = peak * CHART_HEADROOM;
  const x = (index: number): number => (index / (values.length - 1)) * CHART_WIDTH;
  const y = (value: number): number => CHART_HEIGHT - (value / max) * CHART_HEIGHT;
  const points = values.map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`);
  const area = `M0,${CHART_HEIGHT} L${points.join(' L')} L${CHART_WIDTH},${CHART_HEIGHT} Z`;

  const thresholdLines = (
    [
      ['warn', thresholds.warnTokens],
      ['critical', thresholds.criticalTokens],
    ] as const
  )
    .filter(([, tokens]) => tokens < max)
    .map(
      ([level, tokens]) =>
        `<line class="threshold ${level}" x1="0" x2="${CHART_WIDTH}" y1="${y(tokens).toFixed(1)}" y2="${y(tokens).toFixed(1)}" vector-effect="non-scaling-stroke"/>`,
    )
    .join('');
  const compactionLines = session.compactions
    .map(
      (index) =>
        `<line class="compaction" x1="${x(index).toFixed(1)}" x2="${x(index).toFixed(1)}" y1="0" y2="${CHART_HEIGHT}" vector-effect="non-scaling-stroke"/>`,
    )
    .join('');

  return `
    <figure class="chart">
      <figcaption><span>Context per response</span><span>max ${formatTokens(peak)}</span></figcaption>
      <svg viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" preserveAspectRatio="none" role="img" aria-label="Context size after each response, currently ${formatTokens(session.contextTokens)} tokens">
        <path class="area" d="${area}"/>
        ${thresholdLines}
        ${compactionLines}
        <polyline class="line" points="${points.join(' ')}" vector-effect="non-scaling-stroke"/>
      </svg>
      ${session.compactions.length > 0 ? '<p class="chart-note">Dotted lines mark compactions.</p>' : ''}
    </figure>`;
}

function renderBreakdown(session: SessionView): string {
  const rows = USAGE_ROWS.map(
    ([label, key, hint]) =>
      `<tr><th scope="row" title="${hint}">${label}</th><td>${formatTokens(session.lastUsage[key])}</td><td>${formatTokens(session.totals[key])}</td></tr>`,
  ).join('');
  const subagentTokens = totalTokensOf(session.subagentTotals);
  const subagentRow =
    subagentTokens > 0
      ? `<tr class="subagents"><th scope="row" title="Tokens used by subagents; they don't occupy this session's context">Subagents</th><td></td><td>${formatTokens(subagentTokens)}</td></tr>`
      : '';

  return `
    <table class="breakdown">
      <thead><tr><th scope="col">Tokens</th><th scope="col">Last request</th><th scope="col">Session</th></tr></thead>
      <tbody>${rows}${subagentRow}</tbody>
    </table>`;
}

function renderList(sessions: readonly SessionView[], activeId: string, following: boolean): string {
  const rows = sessions
    .map((session) => {
      const selected = session.id === activeId;
      return `
      <li>
        <button class="row level-${session.level}${selected ? ' selected' : ''}" data-action="select" data-id="${escapeHtml(session.id)}" aria-pressed="${selected}">
          <span class="row-line">
            <span class="row-title">${escapeHtml(session.title)}</span>
            <span class="row-tokens">${formatTokens(session.contextTokens)}</span>
          </span>
          <span class="row-bar"><span class="row-fill" data-width="${clampPercent(session.percent)}"></span></span>
          <span class="row-meta">${escapeHtml(session.modelLabel)} · ${formatPercent(session.percent)} · ${formatRelativeTime(session.lastActivity)}</span>
        </button>
      </li>`;
    })
    .join('');

  return `
    <section class="sessions" aria-label="Sessions in this workspace">
      <header class="section-header">
        <h3>Sessions</h3>
        ${following ? '<span class="pill">Following latest</span>' : '<button class="link" data-action="follow">Follow latest</button>'}
      </header>
      <ul class="session-list">${rows}</ul>
      <footer class="footer"><button class="link" data-action="openSettings">Thresholds &amp; settings</button></footer>
    </section>`;
}

function renderEmpty(): string {
  return `
    <div class="empty">
      <h2>No Claude Code sessions yet</h2>
      <p>Start a Claude Code conversation in this workspace. Vizzer picks it up automatically and shows its live token usage here.</p>
      <button class="link" data-action="openSettings">Settings</button>
    </div>`;
}

/** Where a threshold falls on the gauge: whichever of its token or percent limit is reached first. */
function effectiveThresholdPercent(percentLimit: number, tokenLimit: number, contextWindow: number): number {
  const tokenPercent = contextWindow > 0 ? (tokenLimit / contextWindow) * 100 : percentLimit;
  return clampPercent(Math.min(percentLimit, tokenPercent));
}

function clampPercent(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
