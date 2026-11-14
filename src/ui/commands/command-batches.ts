import type { Coordinator } from '../../core/coordinator.js';
import type { WitchCommand } from './commands.js';

type Execute = (
  command: WitchCommand,
  active: () => boolean,
) => Promise<boolean>;

interface Batch {
  commands: readonly WitchCommand[];
  next: number;
  release(): void;
  execute: Execute;
}

/** command batches keep their prompt holds while waiting behind an earlier picker or native operation. */
export class CommandBatches {
  private batches: Batch[] = [];
  private running = false;
  private closed = false;

  constructor(
    private readonly coordinator: Pick<
      Coordinator,
      'holdPromptDelivery' | 'notice' | 'report'
    >,
  ) {}

  get pending(): boolean {
    return this.batches.length > 0;
  }

  submit(commands: readonly WitchCommand[], execute: Execute): void {
    if (this.closed) return;

    const batch: Batch = {
      commands,
      next: 0,
      release: this.coordinator.holdPromptDelivery(() =>
        commands.slice(batch.next).every(({ name }) => name === 'compact'),
      ),
      execute,
    };

    this.batches.push(batch);

    if (!this.running) void this.drain();
  }

  cancel(notice = true): void {
    const batches = this.batches;
    this.batches = [];

    const commands = batches.flatMap((batch) =>
      batch.commands.slice(batch.next),
    );

    if (notice && commands.length)
      this.coordinator.notice(
        `Commands canceled. Retry explicitly: ${commands.map(({ name, argument }) => `/${name}${argument ? ` ${argument}` : ''}`).join('; ')}`,
        undefined,
        false,
      );

    for (const batch of batches) batch.release();
  }

  close(): void {
    this.closed = true;

    this.cancel(false);
  }

  private async drain(): Promise<void> {
    this.running = true;

    try {
      while (this.batches.length) {
        const batch = this.batches[0]!;
        const active = () => this.batches[0] === batch;
        let success = false;

        try {
          success = await batch.execute(batch.commands[batch.next]!, active);
        } catch (error) {
          this.coordinator.report(error);
        }

        if (!active()) continue;

        if (!success) {
          this.cancel();

          continue;
        }

        batch.next++;

        if (batch.next === batch.commands.length) {
          this.batches.shift();

          batch.release();
        }
      }
    } finally {
      this.running = false;
    }
  }
}
