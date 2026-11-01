import type { AgentSession, TurnResult } from '../agents/types.js';
import type { Memory } from '../memory/memory.js';
import type { SessionCoordination } from './coordination.js';
import type { ModelSelection } from './models.js';
import type { Snapshot } from './snapshot.js';
import { contextStart } from './state.js';
import type { ConversationRecord, DisplayItem } from './state.js';

/** keeps a long transcript within the destination's context. */
const transcriptLimit = 60_000;

interface HandoffHost {
  conversation: ConversationRecord;
  snapshot: Snapshot;
  memory: Memory;
  coordination?: SessionCoordination;
  cancelled(): boolean;
  closed(): boolean;
  session(): AgentSession | undefined;
  send(prompt: string, kind: 'turn' | 'handoff'): Promise<TurnResult>;
  connect(selection: ModelSelection): Promise<AgentSession>;
  select(
    session: AgentSession,
    selection: ModelSelection,
  ): Promise<ConversationRecord['sessions'][string]>;
  disconnect(): Promise<void>;
  save(): Promise<void>;
  publish(update: Partial<Snapshot>): void;
  /** runs once the destination's activation is saved, before any continuation is sent. */
  activated?(): void;
}

export interface HandoffOptions {
  /** false skips asking the source, which usage exhaustion leaves unable to answer. */
  summarize?: boolean;
}

export async function handoff(
  host: HandoffHost,
  selection: ModelSelection,
  { summarize = true }: HandoffOptions = {},
): Promise<void> {
  const { agent } = selection;
  const { conversation } = host;
  const { agent: from, handoff: previousHandoff } = conversation;
  const outcome = conversation.lastTurn?.status;
  const unfinished = outcome === 'interrupted' || outcome === 'failed';
  const previous = conversation.sessions[agent];
  let activated = false;
  try {
    let summary = '';
    const { items, queue } = host.snapshot;
    const context = items.slice(contextStart(items));
    if (context.some((item) => item.kind === 'user')) {
      const result = summarize
        ? await host.send(
            'Produce a concise handoff summary: objective, constraints, verified decisions, changed files, completed checks, and remaining work. Only summarize. Do not run tools or change files.',
            'handoff',
          )
        : undefined;
      if (result?.status === 'completed') summary = result.text;
      // a remaining activity means memory is waiting on the user, which must settle before the source is left
      else if (
        !result ||
        (result.status === 'failed' && !conversation.activity)
      )
        summary = transcriptContext(context, queue);
      else throw new Error(result.error ?? 'Handoff was interrupted');
    }
    conversation.handoff = { from, to: agent, summary, activated: false };
    await host.save();
    if (host.cancelled()) throw new Error('Handoff was interrupted');
    const session = await host.connect(selection);
    const selected = await host.select(session, selection);
    if (host.cancelled()) throw new Error('Handoff was interrupted');
    conversation.agent = agent;
    conversation.sessions[agent] = selected;
    conversation.handoff.activated = true;
    await host.save();
    activated = true;
    host.publish({ conversation, native: host.session()?.info });
    host.activated?.();
    if (summary && unfinished)
      await host.send(
        'Continue the task described by the handoff context. Check the working files before relying on statements about their state.',
        'turn',
      );
    else if (!summary) delete conversation.handoff;
    await host.save();
  } catch (error) {
    if (!activated) {
      conversation.agent = from;
      if (conversation.handoff !== previousHandoff) delete conversation.handoff;
      await host.disconnect().catch(() => {});
      if (previous) conversation.sessions[agent] = previous;
      else delete conversation.sessions[agent];
    }
    await host.save();
    host.publish({
      conversation,
      native: host.session()?.info,
      usage: host.session()?.usage ?? {},
    });
    if (!activated && host.coordination) {
      const { project } = await host.memory.scopePaths(conversation.cwd);
      if (!host.closed())
        await host.coordination.activate(conversation, project);
    }
    throw error;
  }
}

/** handoff context rebuilt from the transcript when the source can't summarize. a prompt still queued is left out, since it will be delivered itself. */
export function transcriptContext(
  items: readonly DisplayItem[],
  queued: readonly string[],
): string {
  const rows = items.flatMap((item) => {
    if (item.kind === 'user')
      return queued.includes(item.text) ? [] : [`User: ${item.text}`];
    if (item.kind === 'assistant')
      return [`${item.title ?? 'Assistant'}: ${item.text}`];
    if (item.kind === 'tool')
      return [
        `Tool${item.done === false ? ' (unfinished)' : ''}: ${[item.title, item.path].filter(Boolean).join(' ')}`,
      ];
    return [];
  });
  const kept: string[] = [];
  let size = 0;
  for (let index = rows.length - 1; index >= 0; index--) {
    size += rows[index]!.length + 2;
    if (size > transcriptLimit) break;
    kept.unshift(rows[index]!);
  }
  const omitted = kept.length < rows.length ? ' Earlier rows are omitted.' : '';
  return [
    `The previous runtime could not summarize, so Witch rebuilt this from the conversation transcript.${omitted}`,
    ...kept,
  ].join('\n\n');
}
