import type { Thresholds } from '../core/levels';
import type { SessionView } from '../core/sessionView';

/** Messages exchanged between the extension host and the sidebar webview. */
export interface WebviewState {
  sessions: SessionView[];
  activeId?: string;
  following: boolean;
  thresholds: Thresholds;
}

export type HostToWebviewMessage = { type: 'state'; state: WebviewState };

export type WebviewToHostMessage =
  | { type: 'ready' }
  | { type: 'select'; id: string }
  | { type: 'follow' }
  | { type: 'handoff'; id: string }
  | { type: 'openTranscript'; id: string }
  | { type: 'openSettings' };
