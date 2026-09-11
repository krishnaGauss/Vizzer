import { formatCount } from '../core/format';
import type { TranscriptDigest } from './digest';

/** Rough characters-per-token ratio used to size the digest. */
export const CHARS_PER_TOKEN = 4;

/** Facts about the session being handed off. */
export interface HandoffSource {
  sessionId: string;
  title: string;
  modelLabel: string;
  contextTokens: number;
  cwd?: string;
  gitBranch?: string;
}

export const HANDOFF_SYSTEM_PROMPT =
  'You are a meticulous technical writer who turns condensed coding-session transcripts into handoff documents for a fresh AI coding session.';

const INSTRUCTIONS = `Write a handoff document for the Claude Code session below. The next session will read ONLY this document, so it must carry every fact needed to continue the work without the old conversation.

Rules:
- Be concrete: exact file paths, function and component names, commands, error messages, config values and versions.
- Record each decision together with its reason, and anything the user explicitly asked for or rejected.
- Separate what is done and verified from what is in progress or only planned.
- Do not invent details. If something is unclear from the transcript, list it under "Open questions & gotchas".
- When earlier and later messages conflict, the later state wins.
- Stay under about 1,200 words. Use Markdown. Output only the document, with no preamble or closing remarks.

Use exactly these sections:
# Handoff: <short title>
## Goal
## Current state
## Key decisions & constraints
## Files touched
## Next steps
## Open questions & gotchas
## Useful commands`;

/** The full request sent to the handoff model (instructions, session facts and transcript digest). */
export function buildHandoffRequest(source: HandoffSource, digest: TranscriptDigest): string {
  const lines: string[] = [
    INSTRUCTIONS,
    '',
    '<session_metadata>',
    `title: ${source.title}`,
    `session_id: ${source.sessionId}`,
    `model: ${source.modelLabel}`,
    `context_tokens_at_handoff: ${formatCount(source.contextTokens)}`,
    `user_prompts: ${digest.userTurns}`,
  ];
  if (source.cwd) lines.push(`working_directory: ${source.cwd}`);
  if (source.gitBranch) lines.push(`git_branch: ${source.gitBranch}`);
  if (digest.condensed) {
    lines.push('note: the middle of the conversation was condensed to fit; user requests from it are abbreviated.');
  }
  lines.push('</session_metadata>', '', '<files_modified>');
  lines.push(...(digest.filesTouched.length > 0 ? digest.filesTouched.map((file) => `- ${file}`) : ['(none recorded)']));
  lines.push('</files_modified>', '');

  if (digest.todos.length > 0) {
    lines.push('<latest_todo_list>', ...digest.todos.map((todo) => `- [${todo.status}] ${todo.content}`));
    lines.push('</latest_todo_list>', '');
  }

  lines.push('<transcript_digest>', digest.conversation, '</transcript_digest>');
  return lines.join('\n');
}

/**
 * The first message for the new session. Kept free of `&`, `=` and `#` so it survives being passed
 * through a URI query string unchanged.
 */
export function buildContinuationPrompt(handoffRelativePath: string): string {
  const posixPath = handoffRelativePath.split(/[\\/]+/).join('/');
  return (
    `Continue the work from my previous session. First read the handoff file @${posixPath}, ` +
    'check that its current state still matches the code, then carry on with its next steps.'
  );
}
