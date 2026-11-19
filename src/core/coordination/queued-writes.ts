import { transactionBudget } from '../../persistence/coordination.js';
import type {
  CoordinationStore,
  QueuedWrite,
} from '../../persistence/coordination.js';

interface WriteHost {
  readonly registry: Pick<
    CoordinationStore,
    'answerPeers' | 'resumeByUser' | 'confirmPause' | 'keepQueuedWrites'
  >;
  serialize<T>(work: () => Promise<T>): Promise<T>;

  failed(error: unknown): void;

  flushed(): void;
}

/** writes that must outlast a busy ledger; ticks retry them, deactivation tries once more, and a close saves the rest for the next Witch to start. */
export class QueuedWrites {
  private queued: QueuedWrite[] = [];
  private flushing?: Promise<void>;

  constructor(private readonly host: WriteHost) {}

  push(...writes: QueuedWrite[]): void {
    this.queued.push(...writes);
  }

  queue(write: QueuedWrite): void {
    this.queued.push(write);
    void this.flush();
  }

  /** runs while closing too, without admission, so a resume or answer made just before /restart gets one last attempt. */
  flush(): Promise<void> {
    if (!this.queued.length) return Promise.resolve();

    this.flushing ??= this.host
      .serialize(async () => {
        while (this.queued.length) {
          const write = this.queued[0]!;
          const { conversation } = write;
          const deadline = Date.now() + transactionBudget;

          if (write.kind === 'answer')
            await this.host.registry.answerPeers(
              conversation,
              write.answers,
              deadline,
              true,
            );
          else if (write.kind === 'resume')
            await this.host.registry.resumeByUser(
              conversation,
              write.pauses,
              deadline,
            );
          else
            for (const pause of write.pauses)
              await this.host.registry.confirmPause(
                conversation,
                pause,
                deadline,
              );

          this.queued.shift();
        }

        this.host.flushed();
      })
      .catch((error: unknown) => this.host.failed(error))
      .finally(() => {
        this.flushing = undefined;
      });

    return this.flushing;
  }

  /** the last flush ran when the conversation deactivated, so whatever a busy ledger still holds back goes to disk. */
  async keep(): Promise<void> {
    await this.flushing;

    if (this.queued.length)
      await this.host.registry.keepQueuedWrites(this.queued.splice(0));
  }
}
