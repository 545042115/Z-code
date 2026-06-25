// @z-assistant/app-desktop — Agent Activity Event Bus
//
// A simple global event bus that bridges use to report agent activities
// (e.g. "Research Agent is searching for X", "Browser Agent clicked button Y").
// The runtime-bridge subscribes and forwards them to the connector's event system,
// which flows through IPC to the renderer's Agent Activity panel.

export interface AgentActivity {
  /** Agent name (e.g. 'research', 'browser', 'chat'). */
  agent: string;
  /** Icon/emoji for the activity type. */
  icon: string;
  /** Short description of what the agent is doing. */
  message: string;
  /** ISO timestamp (auto-filled if omitted). */
  timestamp?: string;
  /** Optional detail (URL, query, element text, etc.). */
  detail?: string;
}

type ActivityListener = (activity: AgentActivity) => void;

const listeners = new Set<ActivityListener>();

export function onAgentActivity(fn: ActivityListener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function emitAgentActivity(activity: AgentActivity): void {
  const entry = {
    ...activity,
    timestamp: activity.timestamp || new Date().toISOString(),
  };
  for (const fn of listeners) {
    try { fn(entry); } catch { /* ignore */ }
  }
}
