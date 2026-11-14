import type { TurnResult } from '../agents/types.js';
import type { ConversationStore } from '../persistence/store.js';
import type { Attachments } from './attachments.js';
import type { Compaction } from './compaction.js';
import type { SessionCoordination } from './coordination.js';
import type { ConversationPauses } from './conversation-pauses.js';
import type { CopilotReviewController } from './copilot-review-controller.js';
import type { PullRequestRepair } from './pr-repair.js';
import { shellCommand, skillCall, ranCommand } from './prompts.js';
import {
  joining,
  nextTurn,
  steerInOrder,
  waitsBehind,
  recordQueue,
  without,
  type Pending,
} from './queue.js';
import type { RuntimeSwitch } from './runtime-switch.js';
import type { SessionLink } from './session-link.js';
import type { Snapshot } from './snapshot.js';
import type { ConversationRecord } from './state.js';
import type { TurnRunner } from './turn-runner.js';

interface DeliveryHost {
  snapshot(): Snapshot;

  record(): ConversationRecord | undefined;

  current(): ConversationRecord;

  files(): ConversationStore | undefined;

  task(): Promise<unknown> | undefined;

  opening(): boolean;

  closed(): boolean;

  cancelled(): boolean;

  replied(): boolean;

  halted(): boolean;

  publish(update: Partial<Snapshot>): void;

  persist(operation: Promise<void>): void;

  save(): Promise<void>;

  userRow(text: string, images?: string[]): void;

  report(error: unknown): void;

  operate(operation: () => Promise<void>): Promise<void>;
}

export class PromptDelivery {
  /** prompts taken from the queue's head whose user row isn't saved yet. */
  private taken: Pending[] = [];
  /** prompts `send` is admitting, which neither steered nor queued yet. */
  private arriving: Pending[] = [];
  /** a queue saved before a restart or crash waits for the user, not for delivery. */
  private restoredQueue = false;
  private draining?: PromiseWithResolvers<void>;
  private readonly deliveryHolds = new Set<{ compacting?: () => boolean }>();
  private admissions = 0;
  private admitting: Promise<unknown> = Promise.resolve();
  /** a stop holds automatic turns until the user's next send or another conversation. */
  automaticHeld = false;

  constructor(
    private readonly host: DeliveryHost,
    private readonly attachments: Attachments,
    private readonly link: SessionLink,
    private readonly turns: TurnRunner,
    private readonly runtimes: RuntimeSwitch,
    private readonly compaction: Compaction,
    private readonly pauses: ConversationPauses,
    private readonly copilot: CopilotReviewController,
    private readonly repair: PullRequestRepair,
    private readonly coordination?: SessionCoordination,
  ) {}

  get admitted(): Promise<unknown> {
    return this.admitting;
  }

  get drained(): Promise<void> | undefined {
    return this.draining?.promise;
  }

  get commandsPending(): boolean {
    return this.deliveryHolds.size > 0;
  }

  get compactionOnly(): boolean {
    return [...this.deliveryHolds].every(({ compacting }) => compacting?.());
  }

  restore(queue: readonly string[]): void {
    this.restoredQueue = queue.length > 0;
  }

  /** steers the turn in flight, or queues the prompt for a later turn; a queued turn that never reaches the agent leaves its prompts queued. */
  async send(
    prompt: string,
    { composer = false }: { composer?: boolean } = {},
  ): Promise<void> {
    if (!prompt.trim()) return;

    // only a restart leaves the error phase, so nothing would run what waits
    if (this.host.snapshot().phase === 'error')
      throw new Error(this.host.snapshot().error);

    if (this.host.opening())
      throw new Error('Wait for the next conversation to open');

    // one sent during an operation runs after it only as drainAfter would, even when its steer is refused once it has ended
    const during = this.host.snapshot().phase !== 'idle';
    this.automaticHeld = false;

    this.copilot.resume();

    this.repair.resume();

    // counted before the pause releases, so the automatic work its release wakes can't run ahead of this prompt
    this.admissions++;

    this.pauses.resumeForPrompt();

    const arriving = { prompt };

    this.arriving.push(arriving);

    const record = this.host.record();

    // the composer clears once this returns, so the prompt leaves the draft in the same save
    if (composer && record) delete record.draft;

    this.saveQueue();

    // a steer can wait on the agent, so each prompt steers or queues only after those sent before it
    const admitted = this.admitting
      .then(async () => {
        const steered =
          !waitsBehind(
            this.host.snapshot().queue,
            this.host.snapshot().skills,
          ) && (await this.steer(prompt));

        this.arriving = without(this.arriving, [arriving]);

        if (steered) this.saveQueue();
        else
          this.host.publish({ queue: [...this.host.snapshot().queue, prompt] });

        return steered;
      })
      .finally(() => {
        this.admissions--;

        // a failed admission loses its prompt here as it does live
        if (this.arriving.includes(arriving)) {
          this.arriving = without(this.arriving, [arriving]);

          this.saveQueue();
        }
      });

    this.admitting = admitted.catch(() => {});
    const steered = await admitted;
    this.restoredQueue = false;

    if (!steered && !(during && this.host.halted())) await this.drain();
  }

  /** hands the queue to the composer, saving the composer's resulting text in the same save. */
  unqueue(draft: string): string[] {
    const queue = [...this.host.snapshot().queue];

    if (!queue.length) return queue;

    if (draft) this.host.record()!.draft = draft;
    else delete this.host.record()!.draft;

    this.host.publish({ queue: [] });

    if (this.restoredQueue) {
      this.restoredQueue = false;

      this.drainAfter(true);
    }

    return queue;
  }

  /** saves the composer's text with its conversation; a write for another conversation, or after it closed, is dropped. */
  draft(id: string, text: string): void {
    const record = this.host.record();

    if (record?.id !== id || this.host.files()?.closed !== false) return;

    if ((record.draft ?? '') === text) return;

    if (text) record.draft = text;
    else delete record.draft;

    this.host.persist(this.host.save());
  }

  holdPromptDelivery(compacting?: () => boolean): () => void {
    const hold = { compacting };

    this.deliveryHolds.add(hold);

    this.host.publish({});

    return () => {
      if (!this.deliveryHolds.delete(hold)) return;

      this.host.publish({});

      this.drainAfter(true);
    };
  }

  get deliveryHeld(): boolean {
    return (
      this.deliveryHolds.size > 0 ||
      this.compaction.pending ||
      this.restoredQueue
    );
  }

  private async steer(prompt: string): Promise<boolean> {
    if (this.runtimes.backgroundPending) return false;

    const session = this.link.session;

    if (!session || !this.steerable()) return false;

    const command = shellCommand(prompt);

    if (command !== undefined) {
      if (!this.host.replied()) return false;

      // shown first, since a command's output streams as soon as it starts
      this.host.userRow(prompt);

      return session.steer(`${prompt}\n\n${ranCommand}`, { command });
    }

    const skill = skillCall(prompt, this.host.snapshot().skills);
    const ids = this.attachments.resolve(prompt);
    let images: string[] | undefined;

    if (ids.length) {
      // a failure leaves the prompt queued, and its own turn reports it
      images = await this.attachments
        .prepare(ids, this.host.files()!)
        .catch(() => undefined);

      // the turn can settle meanwhile and let a review start, which must not take the user's prompt
      if (!images || !this.steerable() || this.link.session !== session)
        return false;
    }

    if (
      !(await (skill
        ? session.steer(prompt.trimStart(), { skill, images })
        : session.steer(prompt, { images })))
    )
      return false;

    this.host.userRow(prompt, images);

    return true;
  }

  private steerable(): boolean {
    return (
      this.host.snapshot().phase === 'running' &&
      !this.host.snapshot().answering &&
      !this.host.snapshot().reviewing &&
      !this.turns.repairing &&
      !this.runtimes.backgroundPending &&
      !this.host.cancelled() &&
      !this.deliveryHeld &&
      !this.host.halted()
    );
  }

  drainAfter(releasedHold = false): void {
    if (this.host.closed()) return;

    if (this.runtimes.backgroundPending) {
      if (!this.backgroundSwitchReady()) return;
    } else if (this.deliveryHeld || this.host.halted()) return;

    if (this.draining && !this.host.replied()) {
      if (releasedHold)
        void this.draining.promise.then(() => {
          if (!this.host.cancelled() && !this.link.session?.closed)
            this.drainAfter();
        });

      return;
    }

    if (
      !this.host.snapshot().queue.length &&
      !this.runtimes.backgroundPending &&
      !(
        this.automaticReady() &&
        (this.answerReady() || this.repair.ready() || this.copilot.ready())
      )
    )
      return;

    const draining = this.host.replied() ? this.steerQueued() : this.drain();

    draining.catch((error: unknown) => this.host.report(error));
  }

  private backgroundSwitchReady(): boolean {
    return (
      this.host.snapshot().phase === 'idle' &&
      !this.host.task() &&
      !this.admissions &&
      !this.runtimes.backgroundBusy &&
      !this.runtimes.awaitingRecovery &&
      !this.automaticHeld &&
      !this.pauses.held &&
      !this.host.opening() &&
      !this.host.closed() &&
      !this.host.snapshot().error &&
      (!this.coordination ||
        this.coordination.events.pauses(this.host.current().id) !== undefined)
    );
  }

  private async drain(): Promise<void> {
    if (this.draining) return;

    const draining = (this.draining = Promise.withResolvers<void>());

    this.runtimes.beginStep();

    // an admission that didn't run isn't retried in this drain until its candidate changes. repairs need no entry:
    // one that doesn't run either recorded its key or found its candidate changed
    const tried = new Set<string>();

    try {
      while (this.host.snapshot().phase === 'idle') {
        if (this.runtimes.backgroundPending) {
          if (!this.backgroundSwitchReady()) return;

          if (!(await this.runtimes.continueBackground())) return;

          if (this.host.halted()) return;

          continue;
        }

        if (this.deliveryHeld) return;

        if (!this.host.snapshot().queue.length) {
          if (!this.automaticReady()) return;

          const answers = `answer ${this.answerable().join(' ')}`;
          let ran: boolean;

          if (this.answerReady() && !tried.has(answers)) {
            tried.add(answers);

            ran = await this.runAutomatic(() => this.turns.answerPeers());
          } else if (this.repair.ready())
            ran = await this.runAutomatic(() => this.repair.run());
          else if (!tried.has('copilot') && this.copilot.ready()) {
            tried.add('copilot');

            ran = await this.runAutomatic(() => this.copilot.run());
          } else return;

          if (ran) {
            if (this.host.halted()) return;

            tried.clear();
          }

          continue;
        }

        const queue = this.host.snapshot().queue;

        const batch = nextTurn(
          queue,
          this.link.session ? this.host.snapshot().skills : undefined,
        );

        const taken = batch.map((prompt) => ({ prompt }));

        this.taken.push(...taken);

        this.host.publish({ queue: queue.slice(batch.length) });

        let delivered = false;
        let result = undefined as TurnResult | undefined;

        try {
          await this.host.operate(async () => {
            result = await this.turns.run(batch.join('\n'), 'turn', {
              delivered: () => (delivered = true),
              // the save after the row carries the queue without the batch
              showing: () => {
                this.taken = without(this.taken, taken);

                this.recordQueue();
              },
              unsent: () => this.taken.unshift(...taken),
              queued: true,
            });
          });
        } finally {
          if (!delivered) {
            this.taken = without(this.taken, taken);

            this.host.publish({
              queue: [...batch, ...this.host.snapshot().queue],
            });
          }
        }

        if (result?.status === 'failed' && !result.exhausted)
          this.runtimes.stop();

        // a pre-turn compaction that ran out left the batch requeued above, for the destination to run
        if (
          result?.status === 'failed' &&
          result.exhausted &&
          // an Escape as the turn fails stops the switch too
          !this.host.cancelled() &&
          (await this.runtimes.continueAfterExhaustion()) &&
          !this.host.halted()
        )
          continue;

        // a prompt the agent never read runs next, as an interrupt's unread steers do
        if ((!delivered && !result?.inputUnread) || this.host.halted()) return;

        tried.clear();
      }
    } finally {
      this.draining = undefined;

      draining.resolve();

      // a repair that became ready while this drain ran had its wake dropped
      if (this.repair.ready() || this.runtimes.backgroundPending)
        this.drainAfter();
    }
  }

  /** an automatic turn's admission and reconciliation run at idle, so the flag marks what the phase doesn't. */
  private runAutomatic(run: () => Promise<boolean>): Promise<boolean> {
    this.host.publish({ automatic: true });

    return run().finally(() => this.host.publish({ automatic: false }));
  }

  automaticReady(): boolean {
    const record = this.host.record();

    return (
      this.host.snapshot().phase === 'idle' &&
      !this.host.task() &&
      !this.admissions &&
      !this.deliveryHeld &&
      !this.host.halted() &&
      !this.host.opening() &&
      !this.host.closed() &&
      !this.host.snapshot().requests.length &&
      !this.automaticHeld &&
      !!record &&
      // a pause the first read missed would otherwise let automatic work through
      (!this.coordination ||
        this.coordination.events.pauses(record.id) !== undefined)
    );
  }

  private answerable(): string[] {
    return this.coordination?.events.answerable(this.host.current().id) ?? [];
  }

  answerReady(): boolean {
    return this.automaticReady() && this.answerable().length > 0;
  }

  /** the prompts queued behind a queued turn's prompt join that turn; a `!` command and what follows it wait. */
  steerQueued(): Promise<void> {
    const steering = this.admitting.then(async () => {
      if (this.deliveryHeld || this.host.halted()) return;

      const followers = joining(this.host.snapshot().queue);
      const taken = followers.map((prompt) => ({ prompt }));

      this.taken.push(...taken);

      this.host.publish({
        queue: this.host.snapshot().queue.slice(followers.length),
      });

      let next = 0;

      await steerInOrder(
        followers,
        this.host.snapshot().skills,
        async (prompt) => {
          const follower = taken[next++]!;

          if (!(await this.steer(prompt))) return false;

          this.taken = without(this.taken, [follower]);

          this.saveQueue();

          return true;
        },
        (back) => {
          this.taken = without(this.taken, taken);

          this.host.publish({
            queue: [...back, ...this.host.snapshot().queue],
          });
        },
      );
    });

    this.admitting = steering.catch(() => {});

    return steering.catch((error: unknown) => this.host.report(error));
  }

  private recordQueue(): boolean {
    return recordQueue(
      this.host.record(),
      this.taken,
      this.host.snapshot().queue,
      this.arriving,
    );
  }

  saveQueue(): void {
    if (this.recordQueue() && this.host.files()?.closed === false)
      this.host.persist(this.host.save());
  }
}
