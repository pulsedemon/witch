import type { AgentSession, TurnResult } from '../agents/types.js';
import type { ModelSelection } from './models.js';
import type { Snapshot } from './snapshot.js';
import { contextStart } from './state.js';
import type { ConversationRecord, DisplayItem } from './state.js';

type SessionReference = ConversationRecord['sessions'][string];

/** the coordinator's parts a handoff drives. */
export interface HandoffHost {
  conversation: ConversationRecord;
  items: readonly DisplayItem[];
  performTurn(prompt: string, kind: 'turn' | 'handoff'): Promise<TurnResult>;
  save(): Promise<void>;
  cancelled(): boolean;
  /** connects the destination runtime. */
  connect(): Promise<AgentSession>;
  /** selects the model on the connected session, returning its session reference. */
  applyModel(session: AgentSession): Promise<SessionReference>;
  publish(
    update: Partial<Pick<Snapshot, 'conversation' | 'native' | 'usage'>>,
  ): void;
  session(): AgentSession | undefined;
  disconnect(): Promise<void>;
  /** reactivates coordination for the conversation unless Witch is closing. */
  reactivate(): Promise<void>;
}

/** moves the conversation to another runtime with a summary of the work so far, restoring the old runtime if it can't. */
export async function runHandoff(
  selection: ModelSelection,
  host: HandoffHost,
): Promise<void> {
  const { agent } = selection;
  const { conversation } = host;
  const { agent: from, handoff: previousHandoff } = conversation;
  const outcome = conversation.lastTurn?.status;
  const unfinished = outcome === 'interrupted' || outcome === 'failed';
  const previous = conversation.sessions[agent];
  /** publishes the conversation and the live session, with its usage after a failed handoff. */
  const published = (failed: boolean) =>
    host.publish({
      conversation,
      native: host.session()?.info,
      ...(failed ? { usage: host.session()?.usage ?? {} } : {}),
    });
  let activated = false;
  try {
    let summary = '';
    if (
      host.items
        .slice(contextStart(host.items))
        .some((item) => item.kind === 'user')
    ) {
      const result = await host.performTurn(
        'Produce a concise handoff summary: objective, constraints, verified decisions, changed files, completed checks, and remaining work. Only summarize. Do not run tools or change files.',
        'handoff',
      );
      if (result.status !== 'completed')
        throw new Error(result.error ?? 'Handoff was interrupted');
      summary = result.text;
    }
    conversation.handoff = { from, to: agent, summary, activated: false };
    await host.save();
    if (host.cancelled()) throw new Error('Handoff was interrupted');
    const selected = await host.applyModel(await host.connect());
    if (host.cancelled()) throw new Error('Handoff was interrupted');
    conversation.agent = agent;
    conversation.sessions[agent] = selected;
    conversation.handoff.activated = true;
    await host.save();
    activated = true;
    published(false);
    if (summary && unfinished)
      await host.performTurn(
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
    published(true);
    if (!activated) await host.reactivate();
    throw error;
  }
}
