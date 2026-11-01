import type { AgentSession, TurnResult } from '../agents/types.js';
import type { Memory } from '../memory/memory.js';
import type { SessionCoordination } from './coordination.js';
import type { ModelSelection } from './models.js';
import type { Snapshot } from './snapshot.js';
import { contextStart } from './state.js';
import type { ConversationRecord } from './state.js';

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
}

export async function handoff(
  host: HandoffHost,
  selection: ModelSelection,
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
    if (
      host.snapshot.items
        .slice(contextStart(host.snapshot.items))
        .some((item) => item.kind === 'user')
    ) {
      const result = await host.send(
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
    const session = await host.connect(selection);
    const selected = await host.select(session, selection);
    if (host.cancelled()) throw new Error('Handoff was interrupted');
    conversation.agent = agent;
    conversation.sessions[agent] = selected;
    conversation.handoff.activated = true;
    await host.save();
    activated = true;
    host.publish({ conversation, native: host.session()?.info });
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
