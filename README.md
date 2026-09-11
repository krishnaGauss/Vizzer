# Vizzer — Claude Code token visualizer

Vizzer shows, live, how many tokens each **Claude Code session** in your workspace is carrying, which model it runs on, and when the context has grown large enough that you'd be better off in a fresh session. When that point comes, one click has **Haiku** write a handoff document, and Vizzer opens a new Claude Code session that continues from it.

Account-level meters tell you how much of your plan you've used. Vizzer shows the per-session number behind that: every message in a session re-sends the whole context, so a 400k-token session costs about 400k input tokens per turn, cached or not.

## Features

- **Status bar meter**: `Opus 5 · 182k/1M · 18%` for the session you're working in. It turns yellow or red as the session crosses your thresholds. Hover for a token breakdown (fresh input, cache write, cache read, output) for the last request and the whole session.
- **Sidebar panel**: a card for the focused session with a context gauge, a per-response context chart (compactions marked), token totals, and subagent usage. Below it is a list of every recent session in the workspace. Click one to pin it.
- **Handoff advice**: Vizzer warns once when a live session re-sends more than a set number of tokens per message (default 150k, critical at 300k) or fills a set share of its window (60% / 80%), whichever comes first. Warnings can be snoozed or muted per session.
- **One-click handoff**:
  1. Vizzer condenses the transcript locally (the goal, recent activity, files edited, the latest todo list) to fit Haiku's window.
  2. It runs `claude -p --model haiku` with your existing Claude Code login. No API key is needed, and no extra session is recorded.
  3. It saves the document to `.vizzer/handoffs/<date>-<title>.md` and opens it for you to review.
  4. It opens a new Claude Code tab with a prompt pre-filled to continue from the handoff. You press Enter.

## Requirements

- VS Code 1.90+ or a VS Code-based editor (Cursor, Windsurf, …).
- Claude Code: the VS Code extension for the new-session tab, and the `claude` CLI on your machine for writing handoffs ([setup](https://code.claude.com/docs/en/setup)). If VS Code can't find the CLI, set `vizzer.claudePath`.

## How it works

Claude Code stores each session as an append-only JSONL transcript under `~/.claude/projects/<encoded-project-path>/<session-id>.jsonl` (or under `CLAUDE_CONFIG_DIR`). Each assistant entry records the model and the API's token usage. Vizzer:

- finds the transcript folders for your workspace folders, including sessions started in subfolders;
- tails them incrementally (only new bytes are read) using `fs.watch`, with polling as a fallback;
- counts each API message once, even though Claude Code writes one entry per streamed content block;
- takes the current context size as `input + cache_creation + cache_read` of the latest main-conversation request, the same formula Claude Code's own status line uses. Subagent traffic is counted separately because it doesn't occupy your session's context.

Vizzer only **reads** `~/.claude`. It never writes there. Nothing leaves your machine except the handoff request, which goes through your own `claude` CLI.

### Context window size

Transcripts don't record the window size. Vizzer infers it from the model (Haiku 4.5: 200k; Sonnet 5, Fable, Opus 4.7+: 1M) and switches to 1M once a session has gone past 200k. If your plan runs Opus with a 200k window, set `vizzer.contextWindowOverride` to `200000`. The absolute token thresholds still protect you either way.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `vizzer.thresholds.warnTokens` | `150000` | Warn at this many context tokens re-sent per message. |
| `vizzer.thresholds.criticalTokens` | `300000` | Mark critical and suggest a handoff. |
| `vizzer.thresholds.warnPercent` | `60` | Warn at this share of the context window. |
| `vizzer.thresholds.criticalPercent` | `80` | Critical at this share of the context window. |
| `vizzer.notifications.enabled` | `true` | Show handoff suggestions as notifications. |
| `vizzer.contextWindowOverride` | `0` | Force a window size in tokens (`0` = detect). |
| `vizzer.claudeConfigDir` | `""` | Claude config directory (defaults to `CLAUDE_CONFIG_DIR` or `~/.claude`). |
| `vizzer.claudePath` | `""` | Path to the `claude` CLI (defaults to PATH and common install locations). |
| `vizzer.handoff.model` | `haiku` | Model that writes handoffs. |
| `vizzer.handoff.maxDigestTokens` | `60000` | Budget for the condensed transcript sent to that model. |
| `vizzer.handoff.openIn` | `claudeExtension` | Open the new session in the Claude Code extension or a terminal. |
| `vizzer.sessions.historyDays` | `7` | Only load sessions active within this many days. |
| `vizzer.sessions.maxSessions` | `25` | Maximum sessions tracked per workspace. |

## Commands

- **Vizzer: Show Token Panel**
- **Vizzer: Create Handoff for Current Session**
- **Vizzer: Start New Claude Session from This Handoff**: also in the editor title bar when a handoff file is open
- **Vizzer: Select Session…** / **Follow Most Recent Session**
- **Vizzer: Open Session Transcript**
- **Vizzer: Refresh**

## Development

```bash
npm install
npm run build        # bundle dist/extension.js and dist/webview.js
npm run watch        # rebuild on change
npm run check        # typecheck + lint + unit tests
npm run package      # produce a .vsix
```

Press **F5** in VS Code to launch an Extension Development Host with Vizzer loaded.

### Architecture

```
src/
  transcript/   JSONL tail reader, entry parser, per-session accumulator (pure)
  sessions/     Claude paths + SessionStore that discovers and watches transcripts (pure Node)
  core/         models/context windows, usage levels, formatting, view models (pure)
  handoff/      digest, prompt, claude CLI runner, handoff file writer (pure)
                + handoffService / sessionLauncher (VS Code)
  ui/           status bar, sidebar webview provider, webview protocol (VS Code)
  webview/      sidebar renderer (browser bundle)
  controller.ts, advisor.ts, commands.ts, config.ts, extension.ts (composition root)
```

Modules marked *pure* have no dependency on the `vscode` API (lint enforces this) and are covered by the Vitest suite in `test/`. The tests build synthetic transcripts and never read real session files.

## Limitations

- The transcript format is internal to Claude Code and may change. Vizzer parses it defensively and ignores entries it doesn't recognise.
- The context window is inferred, not reported. See [Context window size](#context-window-size).
- The new-session prompt is pre-filled but not sent. That's how Claude Code's URI handler works, and it gives you a chance to adjust it.
