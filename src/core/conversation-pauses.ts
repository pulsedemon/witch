import { errorMessage } from '../errors.js';

import type { SessionCoordination } from './coordination.js';

import { entry, holding } from './pauses.js';

interface PauseHost {
  conversation(): string | undefined;

  coordination(): SessionCoordination | undefined;

  closed(): boolean;

  nativeRunning(): boolean | undefined;

  task(): Promise<unknown> | undefined;

  draining(): Promise<void> | undefined;

  holdDelivery(): () => void;

  /** leaves the user's own Escape hold in place. */
  stop(): Promise<void>;

  changed(): void;

  notice(text: string): void;
}

interface PauseVisit {
  conversation: string;
  applied: Set<string>;
  confirming: Set<string>;
  release: () => void;
  /** a stop is in flight; confirmation waits for it. */
  stopping: boolean;
  /** a pause arrived during that stop, so another pass follows it. */
  again: boolean;
  retry?: ReturnType<typeof setTimeout>;
}

export class ConversationPauses {
  private paused?: PauseVisit;
  /** `conversation/pause` pairs the user lifted with a prompt, which hold no more even before the store records it. */
  private readonly userResumed = new Set<string>();
  /** when the user last prompted each conversation, which resumes any pause issued before it, even one not read yet. */
  private readonly promptedAt = new Map<string, number>();

  constructor(private readonly host: PauseHost) {}

  get held(): boolean {
    return this.paused !== undefined;
  }

  resumeForPrompt(): void {
    const conversation = this.host.conversation();

    if (conversation) this.promptedAt.set(conversation, Date.now());

    const paused = this.paused;

    if (paused) {
      for (const id of paused.applied)
        this.userResumed.add(`${paused.conversation}/${id}`);

      this.releasePause();

      this.host
        .coordination()
        ?.resumePauses(paused.conversation, [...paused.applied]);
    }
  }

  close(): void {
    clearTimeout(this.paused?.retry);
  }

  /** holds the open conversation for each pause naming it, and lifts the hold once every applied pause reads resumed. */
  apply(): void {
    const conversation = this.host.conversation();

    // a visit ends when its conversation does
    if (this.paused && this.paused.conversation !== conversation)
      this.releasePause();

    const pauses =
      conversation && !this.host.closed()
        ? this.host.coordination()?.events.pauses(conversation)
        : undefined;

    if (!conversation || !pauses) return;

    const prompted = this.promptedAt.get(conversation);

    const lifted = holding(pauses, conversation).filter(
      ({ id, issuedAt }) =>
        prompted !== undefined &&
        Date.parse(issuedAt) <= prompted &&
        !this.userResumed.has(`${conversation}/${id}`),
    );

    if (lifted.length) {
      for (const { id } of lifted)
        this.userResumed.add(`${conversation}/${id}`);

      this.host.coordination()?.resumePauses(
        conversation,
        lifted.map(({ id }) => id),
      );
    }

    const held = holding(pauses, conversation).filter(
      ({ id }) => !this.userResumed.has(`${conversation}/${id}`),
    );

    if (!held.length) {
      this.releasePause();

      return;
    }

    const paused = (this.paused ??= {
      conversation,
      applied: new Set<string>(),
      confirming: new Set<string>(),
      release: this.host.holdDelivery(),
      stopping: false,
      again: false,
    });

    const fresh = held.filter(({ id }) => !paused.applied.has(id));

    for (const { id } of fresh) paused.applied.add(id);

    // an operation the user started while held may run, so each new pause stops it again
    if (fresh.length && paused.stopping) paused.again = true;
    else if (fresh.length) {
      paused.stopping = true;

      void this.stopForPause(paused);
    }

    this.confirm();
  }

  /** confirms once the stop succeeded and the operation it stopped has settled; a failed stop retries until the visit ends. */
  private async stopForPause(paused: PauseVisit): Promise<void> {
    const task = this.host.task();

    try {
      await this.host.stop();

      await task?.catch(() => {});
    } catch (error) {
      if (this.paused !== paused || this.host.closed()) return;

      this.host.notice(
        `Witch could not stop this conversation for its pause and will retry: ${errorMessage(error)}`,
      );

      paused.retry = setTimeout(() => void this.stopForPause(paused), 2000);

      return;
    }

    if (paused.again && this.paused === paused) {
      paused.again = false;

      return this.stopForPause(paused);
    }

    paused.stopping = false;

    this.confirm();
  }

  /** Escape can't stop a native run outside a turn, so confirmation waits for it to end. */
  confirm(): void {
    const paused = this.paused;

    if (!paused || paused.stopping || this.host.nativeRunning()) return;

    const pauses =
      this.host.coordination()?.events.pauses(paused.conversation) ?? [];

    for (const pause of pauses) {
      const recipient = entry(pause, paused.conversation);

      if (
        paused.applied.has(pause.id) &&
        !recipient?.confirmedAt &&
        !paused.confirming.has(pause.id)
      ) {
        paused.confirming.add(pause.id);

        this.host.coordination()?.confirmPause(paused.conversation, pause.id);
      }
    }
  }

  /** the hold's own wake skips a drain the pause cancelled, so this wakes after it. */
  private releasePause(): void {
    const paused = this.paused;

    if (!paused) return;

    this.paused = undefined;

    clearTimeout(paused.retry);

    paused.release();

    void (this.host.draining() ?? Promise.resolve()).then(() =>
      this.host.changed(),
    );
  }
}
