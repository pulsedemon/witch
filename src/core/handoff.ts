import type { AgentSession } from '../agents/types.js';
import type { ModelSelection } from './models.js';
import type { SwitchHost } from './runtime-switch.js';
import { contextStart } from './state.js';
import type { ConversationRecord, DisplayItem } from './state.js';

/** keeps a long transcript within the destination's context. */
const transcriptLimit = 60_000;

type HandoffHost = Pick<
  SwitchHost,
  | 'conversation'
  | 'snapshot'
  | 'memory'
  | 'coordination'
  | 'cancelled'
  | 'closed'
  | 'session'
  | 'send'
  | 'connect'
  | 'disconnect'
  | 'save'
  | 'publish'
> & {
  select(
    session: AgentSession,
    selection: ModelSelection,
  ): Promise<ConversationRecord['sessions'][string]>;
  /** runs once the destination's activation is saved, before any continuation is sent. */
  activated?(): void;
};

interface HandoffOptions {
  /** false skips asking the source, which usage exhaustion leaves unable to answer. */
  summarize?: boolean;
}

export async function handoff(
  host: HandoffHost,
  selection: ModelSelection,
  { summarize = true }: HandoffOptions = {},
): Promise<void> {
  const { agent } = selection;
  const conversation = host.conversation();
  const from = conversation.agent;
  const outcome = conversation.lastTurn?.status;
  const unfinished = outcome === 'interrupted' || outcome === 'failed';
  const previous = conversation.sessions[agent];
  let activated = false;
  // the handoff this one replaced, which the source may already have consumed while summarizing
  let replaced: ConversationRecord['handoff'];
  let overwritten = false;
  try {
    let summary = '';
    const { items } = host.snapshot();
    const context = items.slice(contextStart(items));
    if (context.some((item) => item.kind === 'user' && !item.unread)) {
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
        summary = transcriptContext(context);
      else throw new Error(result.error ?? 'Handoff was interrupted');
    }
    replaced = conversation.handoff;
    overwritten = true;
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
        // the context carries the unfinished request as text, so its images go with the continuation
        conversation.lastTurn?.images,
      );
    else if (!summary) delete conversation.handoff;
    await host.save();
  } catch (error) {
    if (!activated) {
      conversation.agent = from;
      if (overwritten) {
        if (replaced) conversation.handoff = replaced;
        else delete conversation.handoff;
      }
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
    const coordination = host.coordination();
    if (!activated && coordination) {
      const { project } = await host.memory().scopePaths(conversation.cwd);
      if (!host.closed()) await coordination.activate(conversation, project);
    }
    throw error;
  }
}

/** handoff context rebuilt from the transcript when the source can't summarize. unread prompts are left out, since the queue sends them again. */
export function transcriptContext(items: readonly DisplayItem[]): string {
  const rows = items.toReversed().flatMap((item) => {
    if (item.kind === 'user') return item.unread ? [] : [`User: ${item.text}`];
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
  for (const row of rows) {
    size += row.length + 2;
    if (size <= transcriptLimit) kept.unshift(row);
    // the newest row alone can exceed the limit, and it usually states the task
    else if (!kept.length)
      kept.push(`${row.slice(0, transcriptLimit)} [truncated]`);
    if (size >= transcriptLimit) break;
  }
  const omitted = kept.length < rows.length ? ' Earlier rows are omitted.' : '';
  return [
    `The previous runtime could not summarize, so Witch rebuilt this from the conversation transcript.${omitted}`,
    ...kept,
  ].join('\n\n');
}
