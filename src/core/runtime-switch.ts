import type { AgentSession, TurnResult } from '../agents/types.js';

import type { Memory } from '../memory/memory.js';

import type { SessionCoordination } from './coordination.js';

import { taskActivity } from './coordination-state.js';

import { handoff } from './handoff.js';

import { modelEffort, type ModelSelection } from './models.js';

import { comparable, resolve } from './routing.js';

import type { Snapshot } from './snapshot.js';

import type { ConversationRecord } from './state.js';

import {
  creditCapacity,
  currentLimits,
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

  connect(
    selection: ModelSelection,
    ready?: () => boolean,
  ): Promise<AgentSession | undefined>;

  disconnect(): Promise<void>;

  save(): Promise<void>;

  publish(update: Partial<Snapshot>): void;

  notice(text: string): void;

  /** runs the operation in the `switching` phase, reporting what it throws. */
  operate(operation: () => Promise<void>): Promise<void>;

  /** sets whether a failed turn holds the queue for the composer. */
  failed(failed: boolean): void;

  prepareBackground(): Promise<void>;

  changed(): void;

  compactionOnly(): boolean;
}

interface PendingSwitch {
  conversation: ConversationRecord;
  source: AgentSession | undefined;
  background: boolean;
  recovering: boolean;
  moving: boolean;
  waiting: boolean;
  revision: number;
  finished: PromiseWithResolvers<void>;
}

type Destination =
  { selection: ModelSelection; notice: string } | { reason: string };

/** moves the conversation between runtimes: a `/model` handoff, or a continuation after the runtime runs out of usage. */
export class RuntimeSwitch {
  /** a model selection is in flight, so a stop closes the session it would leave half changed. */
  selecting = false;
  /** a switch activated in this drain step, so another exhaustion stops instead of switching back. */
  private hopped = false;
  private pending?: PendingSwitch;
  /** when each runtime last ran out in this process; only evidence observed later shows it has recovered. */
  private readonly exhaustedAt = new Map<string, number>();
  private continuation?: TurnResult;
  private stopping?: PromiseWithResolvers<void>;
  private activityRevision = 0;

  constructor(private readonly host: SwitchHost) {}

  /** a new drain step may switch again. */
  beginStep(): void {
    this.hopped = false;
  }

  /** ends the forced usage refresh at once; the probe finishes under its own timeout. */
  stop(): void {
    this.stopping?.resolve();

    this.clearPending();
  }

  backgroundExhausted(source: AgentSession): void {
    if (this.host.session() !== source || this.host.cancelled()) return;

    if (!this.backgroundPending) this.request(true);
  }

  get backgroundPending(): boolean {
    const request = this.pending;

    if (
      request &&
      !request.moving &&
      (request.conversation !== this.host.conversation() ||
        request.source !== this.host.session())
    )
      this.clearPending();

    return this.pending?.background === true;
  }

  get backgroundSettled(): Promise<void> | undefined {
    return this.backgroundPending ? this.pending!.finished.promise : undefined;
  }

  get awaitingRecovery(): boolean {
    return this.pending?.recovering === true;
  }

  get backgroundBusy(): boolean {
    const snapshot = this.host.snapshot();

    return snapshot.nativeRunning || taskActivity(snapshot).running;
  }

  observe(update: Partial<Snapshot>): void {
    if (
      this.pending?.background &&
      (update.nativeRunning === true ||
        update.items ||
        update.subagents ||
        update.backgroundCommands)
    )
      this.activityRevision++;
  }

  private deferBackground(request: PendingSwitch): boolean {
    if (
      !request.background ||
      (!this.backgroundBusy && request.revision === this.activityRevision)
    )
      return false;

    request.waiting = true;

    return true;
  }

  acceptMemory(agent: string): boolean {
    return (
      !this.pending?.background || this.pending.source?.info.agent !== agent
    );
  }

  async continueBackground(): Promise<boolean> {
    if (!this.backgroundPending) return false;

    const request = this.pending!;

    request.waiting = false;

    request.revision = this.activityRevision;

    try {
      await this.host.prepareBackground();
    } catch (error) {
      if (this.pending === request) this.clearPending();

      throw error;
    }

    if (this.pending !== request || this.host.cancelled()) return false;

    if (this.host.snapshot().phase === 'idle' && this.deferBackground(request))
      return false;

    return this.run(request);
  }

  private request(background: boolean): PendingSwitch {
    this.clearPending();

    const request = {
      conversation: this.host.conversation(),
      source: this.host.session(),
      background,
      recovering: false,
      moving: false,
      waiting: false,
      revision: this.activityRevision,
      finished: Promise.withResolvers<void>(),
    };

    this.pending = request;

    this.exhaustedAt.set(request.conversation.agent, Date.now());

    return request;
  }

  private clearPending(): void {
    const request = this.pending;

    this.pending = undefined;

    request?.finished.resolve();
  }

  private async run(request: PendingSwitch): Promise<boolean> {
    try {
      return await this.attempt(request);
    } finally {
      if (request.waiting && this.host.snapshot().phase === 'recovery')
        request.recovering = true;

      if (this.pending === request && !request.recovering && !request.waiting) {
        if (this.host.conversation().agent === request.source?.info.agent)
          this.host.failed(true);

        this.clearPending();
      }
    }
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
  handoff(
    selection: ModelSelection,
    notice?: string,
    continueTask?: true,
  ): Promise<void> {
    if (notice === undefined) this.clearPending();

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
      {
        summarize: notice === undefined,
        continueTask,
        ready: continueTask
          ? () => !!this.pending && !this.deferBackground(this.pending)
          : undefined,
      },
    );
  }

  /** after an ordinary turn, or the compaction before it, fails exhausted; true when the conversation continues on another runtime. */
  continueAfterExhaustion(): Promise<boolean> {
    return this.run(
      this.backgroundPending ? this.pending! : this.request(false),
    );
  }

  /** runs a switch the memory decision held once `recovering` succeeds and leaves the conversation idle. */
  async recovered(recovering: Promise<void>): Promise<void> {
    let succeeded = false;

    try {
      await recovering;

      succeeded = true;
    } finally {
      const request = this.pending;

      const pending =
        request?.recovering && this.host.snapshot().phase === 'idle';

      // the switch's own operation clears the stop, so one pressed while recovery applied is read here
      if (pending && succeeded && !this.host.cancelled()) {
        this.hopped = false;

        request.recovering = false;

        if (request.background) this.host.changed();
        else await this.run(request);
      }
    }
  }

  private async attempt(request: PendingSwitch): Promise<boolean> {
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

    if (phase === 'recovery') request.recovering = true;

    if (phase !== 'idle') return false;

    if (commandsPending && !(request.background && host.compactionOnly())) {
      host.notice(
        `${from} is out of usage. Witch won't switch while commands are pending.`,
      );

      return false;
    }

    // entered before any await, so the queue is never shown idle and handed back to the composer
    request.moving = true;

    await host
      .operate(async () => {
        const stopping = (this.stopping = Promise.withResolvers<void>());

        try {
          await this.move(stopping.promise, request);
        } finally {
          this.stopping = undefined;

          request.moving = false;

          if (!request.waiting && host.conversation().agent === agent)
            host.failed(true);
        }
      })
      .catch(() => {});

    return host.conversation().agent !== agent;
  }

  /** refreshes the other runtimes' usage, then hands off to the best qualifying one or posts why none can continue. */
  private async move(
    stopped: Promise<void>,
    request: PendingSwitch,
  ): Promise<void> {
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

    if (
      host.cancelled() ||
      this.pending !== request ||
      host.session() !== request.source
    )
      return;

    if (this.deferBackground(request)) return;

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

    await this.handoff(
      chosen.selection,
      chosen.notice,
      request.background ? true : undefined,
    );

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

      if (!currentLimits(limits, now) || observed <= since)
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
