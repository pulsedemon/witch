import type { DisplayItem } from '../../core/state.js';
import type { Snapshot } from '../../core/snapshot.js';
import { oneLine } from '../links.js';

/** what the agent's own rows, those after its newest row unchanged since the Witch operation began, and its last reported reasoning say of its work. */
export interface AgentActivity {
  /** when one of those rows last changed, else when that operation began, in epoch milliseconds. */
  quietSince: number;
  /** the newest unfinished tool call among them, as `RUNNING <title>`. */
  doing?: string;
  /** the newest message among them, on one line. */
  message?: { text: string; at: number };
  /** when the model last reported reasoning, while that is newer than `quietSince`. */
  reasonedAt?: number;
}

// a row shows far less, and a long reply is cleaned on every update while it streams
const messageLength = 1000;

/** agent rows use `<activity>/<agent>/<native id>`; familiar and brew rows have bare ids, and `!` commands are the user's. */
export function agentRow(item: DisplayItem): boolean {
  return item.id.includes('/') && !item.shell;
}

export function agentActivity({
  phase,
  activityStartedAt,
  items,
  reasonedAt,
}: Pick<Snapshot, 'phase' | 'activityStartedAt' | 'items' | 'reasonedAt'>):
  AgentActivity | undefined {
  // a handoff's turns run in switching and keep the plain row, as every working phase but running does
  if (phase !== 'running') return;

  let quietSince = activityStartedAt;
  let doing: string | undefined;
  let message: AgentActivity['message'];

  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;

    if ((item.kind !== 'assistant' && item.kind !== 'tool') || !agentRow(item))
      continue;

    const at = item.at ? Date.parse(item.at) : NaN;

    // rows from before the operation come before its own, even one that still changes
    if (!(at >= activityStartedAt)) break;

    quietSince = Math.max(quietSince, at);

    if (item.kind === 'tool' && !item.done)
      doing ??= `RUNNING ${oneLine(item.title || 'Tool')}`;

    if (item.kind === 'assistant' && item.text.trim())
      message ??= {
        text: oneLine(item.text.slice(0, messageLength)).trim(),
        at,
      };
  }

  return {
    quietSince,
    doing,
    message,
    // strictly newer: Codex ends a reasoning step as it starts the message after it, and the message is what shows
    ...(reasonedAt !== undefined && reasonedAt > quietSince && { reasonedAt }),
  };
}
