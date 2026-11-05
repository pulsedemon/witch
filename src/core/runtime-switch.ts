import type { AgentSession, TurnResult } from '../agents/types.js';
import type { Memory } from '../memory/memory.js';
import type { SessionCoordination } from './coordination.js';
import { handoff } from './handoff.js';
import { modelEffort, type ModelSelection } from './models.js';
import { comparable, resolve } from './routing.js';
import type { Snapshot } from './snapshot.js';
import type { ConversationRecord } from './state.js';
import {
  creditCapacity,
  current,
  describeReading,
  headroom,
  type AccountUsage,
} from './usage.js';

export interface SwitchHost {
  conversation(): ConversationRecord;
  snapshot(): Snapshot;
  memory(): Memory;
  coordination(): SessionCoordination | undefined;
  usage(): AccountUsage;
  cancelled(): boolean;
  closed(): boolean;
  session(): AgentSession | undefined;
  send(
    prompt: string,
    kind: 'turn' | 'handoff',
    images?: readonly string[],
  ): Promise<TurnResult>;
  connect(selection: ModelSelection): Promise<AgentSession>;
  disconnect(): Promise<void>;
  save(): Promise<void>;
  publish(update: Partial<Snapshot>): void;
  notice(text: string): void;
  /** runs the operation in the `switching` phase, reporting what it throws. */
  operate(operation: () => Promise<void>): Promise<void>;
  /** sets whether a failed turn holds the queue for the composer. */
  failed(failed: boolean): void;
}

type Destination =
  { selection: ModelSelection; notice: string } | { reason: string };

/** moves the conversation between runtimes: a `/model` handoff, or a continuation after the runtime runs out of usage. */
export class RuntimeSwitch {
  /** a model selection is in flight, so a stop closes the session it would leave half changed. */
  selecting = false;
  /** a switch activated in this drain step, so another exhaustion stops instead of switching back. */
  private hopped = false;
  /** the failed turn left memory pending, so resolving it runs the switch. */
  private pending = false;
  /** when each runtime last ran out in this process; only evidence observed later shows it has recovered. */
  private readonly exhaustedAt = new Map<string, number>();
  private continuation?: TurnResult;
  private stopping?: PromiseWithResolvers<void>;

  constructor(private readonly host: SwitchHost) {}

  /** a new drain step may switch again. */
  beginStep(): void {
    this.hopped = false;
  }

  /** ends the forced usage refresh at once; the probe finishes under its own timeout. */
  stop(): void {
    this.stopping?.resolve();
  }

  async applyModel(session: AgentSession, selection: ModelSelection) {
    const { agent, id } = selection;
    this.selecting = true;
    try {
      await session.checkModel?.(id);
      await session.selectModel(
        id,
        modelEffort(selection, this.host.snapshot().models),
      );
    } finally {
      this.selecting = false;
    }
    return {
      ...this.host.conversation().sessions[agent]!,
      model: session.info.model,
      requestedModel: id,
      effort: session.info.effort,
    };
  }

  /** an automatic switch passes the notice it posts once activated, and never asks the exhausted source to summarize. */
  handoff(selection: ModelSelection, notice?: string): Promise<void> {
    const host = this.host;
    this.continuation = undefined;
    return handoff(
      {
        ...host,
        send: async (prompt, kind, images) => {
          const result = await host.send(prompt, kind, images);
          // a `/model` summary can exhaust its source too, and returning there needs later evidence
          if (result.status === 'failed' && result.exhausted)
            this.exhaustedAt.set(host.conversation().agent, Date.now());
          if (kind === 'turn') this.continuation = result;
          return result;
        },
        select: (session, choice) => this.applyModel(session, choice),
        // a failed summary must not hold prompts sent during the handoff from the destination
        activated: () => {
          host.failed(false);
          // the destination never asked the source's questions; a failed switch keeps them
          host.publish({
            requests: host
              .snapshot()
              .requests.filter((request) => !request.replyAsPrompt),
          });
          if (notice === undefined) return;
          this.hopped = true;
          host.notice(notice);
        },
      },
      selection,
      { summarize: notice === undefined },
    );
  }

  /** after an ordinary turn, or the compaction before it, fails exhausted; true when the conversation continues on another runtime. */
  continueAfterExhaustion(): Promise<boolean> {
    this.exhaustedAt.set(this.host.conversation().agent, Date.now());
    return this.attempt();
  }

  /** runs a switch the memory decision held once `recovering` succeeds and leaves the conversation idle. */
  async recovered(recovering: Promise<void>): Promise<void> {
    let succeeded = false;
    try {
      await recovering;
      succeeded = true;
    } finally {
      const pending = this.pending && this.host.snapshot().phase === 'idle';
      if (pending) this.pending = false;
      // the switch's own operation clears the stop, so one pressed while recovery applied is read here
      if (pending && succeeded && !this.host.cancelled()) {
        this.hopped = false;
        await this.attempt();
      }
    }
  }

  private async attempt(): Promise<boolean> {
    const host = this.host;
    const { phase, error, commandsPending } = host.snapshot();
    const { agent } = host.conversation();
    const from = this.label(agent);
    if (host.closed() || error) return false;
    if (this.hopped) {
      host.notice(
        `${from} is also out of usage. The conversation stays on ${from}.`,
      );
      return false;
    }
    if (phase === 'recovery') this.pending = true;
    if (phase !== 'idle') return false;
    if (commandsPending) {
      host.notice(
        `${from} is out of usage. Witch won't switch while commands are pending.`,
      );
      return false;
    }
    // entered before any await, so the queue is never shown idle and handed back to the composer
    await host
      .operate(async () => {
        const stopping = (this.stopping = Promise.withResolvers<void>());
        try {
          await this.move(stopping.promise);
        } finally {
          this.stopping = undefined;
          if (host.conversation().agent === agent) host.failed(true);
        }
      })
      .catch(() => {});
    return host.conversation().agent !== agent;
  }

  /** refreshes the other runtimes' usage, then hands off to the best qualifying one or posts why none can continue. */
  private async move(stopped: Promise<void>): Promise<void> {
    const host = this.host;
    const { agent, cwd } = host.conversation();
    const others = host
      .snapshot()
      .agents.filter(({ id, installed }) => installed && id !== agent)
      .map(({ id }) => id);
    await Promise.race([
      Promise.all(
        others.map((id) =>
          host
            .usage()
            .refresh(id, cwd, { force: true, after: this.exhaustedAt.get(id) }),
        ),
      ),
      stopped,
    ]);
    if (host.cancelled()) return;
    const destinations = others.map((id) => this.destination(agent, id));
    const chosen = destinations.find((choice) => 'selection' in choice);
    const from = this.label(agent);
    if (!chosen || !('selection' in chosen)) {
      const reasons = destinations.flatMap((choice) =>
        'reason' in choice ? [choice.reason] : [],
      );
      host.notice(
        `${from} is out of usage and no other runtime can continue: ${reasons.join(', ') || 'no other runtime is installed'}. The conversation stays on ${from}.`,
      );
      return;
    }
    await this.handoff(chosen.selection, chosen.notice);
    if (this.continuation?.status === 'failed' && this.continuation.exhausted) {
      const to = this.label(chosen.selection.agent);
      host.notice(
        `${to} is also out of usage. The conversation stays on ${to}.`,
      );
    }
  }

  /** `to` qualifies on room or usable credits observed after it last ran out, with a model comparable to the one `from` ran. */
  private destination(from: string, to: string): Destination {
    const { accounts, models, latest } = this.host.snapshot();
    const now = Date.now();
    const name = this.label(to);
    const account = accounts[to];
    const limits = account?.limits ?? [];
    const since = this.exhaustedAt.get(to) ?? -Infinity;
    const observed = Math.min(...limits.map(({ observedAt }) => observedAt));
    const room = headroom(limits, 100, now) && observed > since;
    const credits = creditCapacity(account, now);
    if (
      !room &&
      !(credits === 'available' && account!.creditAccess!.observedAt > since)
    ) {
      if (!limits.length && account?.funding?.kind === 'unavailable')
        return { reason: `${name} reports no usage limits` };
      if (
        !limits.length ||
        !limits.every((limit) => current(limit, now)) ||
        observed <= since
      )
        return {
          reason: this.exhaustedAt.has(to)
            ? `${name} has no reading since it ran out`
            : `${name} has no current reading`,
        };
      if (account?.funding && credits === 'unknown')
        return { reason: `${name}'s credits can't be verified` };
      return { reason: `${describeReading(name, account, now)} has no room` };
    }
    if (!models.some(({ agent }) => agent === to))
      return { reason: `${name} lists no models` };
    const model = this.host.conversation().sessions[from]?.model;
    const family = model && comparable(from, model, to);
    if (!family)
      return {
        reason: `${name} has no model comparable to ${model || 'the current one'}`,
      };
    const resolved = resolve(to, family, { models, latest });
    if ('refused' in resolved) return { reason: resolved.refused };
    return {
      selection: { agent: to, id: resolved.model },
      notice: `${this.label(from)} is out of usage. Continuing on ${name} · ${resolved.model}: ${describeReading(name, account, now)} has ${room ? 'room' : 'usable credits'}`,
    };
  }

  private label(id: string): string {
    return (
      this.host.snapshot().agents.find((agent) => agent.id === id)?.label ?? id
    );
  }
}
