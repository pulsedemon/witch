import { randomUUID } from 'node:crypto';
import { errorMessage } from '../../errors.js';
import { bashRecord, runShell, shellFailed } from '../user-shell.js';
import type { SessionOptions, TurnResult } from '../types.js';

export class ClaudeShell {
  private command?: { controller: AbortController; finished: Promise<void> };
  /** commands' records for the next prompt, where Claude Code merges its own `!` records. */
  private records: string[] = [];

  constructor(
    private readonly options: Pick<
      SessionOptions,
      'cwd' | 'mark' | 'onEvent' | 'onShell'
    >,
  ) {}

  get running(): boolean {
    return this.command !== undefined;
  }

  get finished(): Promise<void> | undefined {
    return this.command?.finished;
  }

  abort(): void {
    this.command?.controller.abort();
  }

  take(): string[] {
    const records = this.records;
    this.records = [];

    return records;
  }

  get unread(): boolean {
    return this.records.length > 0;
  }

  async run(command: string): Promise<TurnResult> {
    const abort = new AbortController();
    const finished = Promise.withResolvers<void>();
    this.command = { controller: abort, finished: finished.promise };

    try {
      const id = randomUUID();

      const row = (text: string, done = false, failed = false) =>
        this.options.onEvent({
          type: 'tool',
          id,
          title: '',
          text,
          done,
          append: true,
          ...(failed ? { failed: true } : {}),
        });

      this.options.onEvent({
        type: 'tool',
        id,
        title: command,
        text: '',
        done: false,
        shell: true,
      });

      let started: Promise<void> | undefined;
      let failed = true;

      try {
        const run = await runShell(command, {
          cwd: this.options.cwd,
          env: this.options.mark?.environment,
          signal: abort.signal,
          onOutput: (text) => row(text),
          onSpawn: (pid) => {
            started = this.options.onShell?.(pid);
            // awaited once the command ends, which can be long after a failed report
            started?.catch(() => {});
          },
        });

        this.records.push(bashRecord(command, run));
        failed = shellFailed(run);

        return {
          status: run.interrupted ? 'interrupted' : 'completed',
          text: '',
        };
      } catch (error) {
        return { status: 'failed', text: '', error: errorMessage(error) };
      } finally {
        row('', true, failed);

        if (started) {
          await started;
          await this.options.onShell?.(undefined);
        }
      }
    } finally {
      this.command = undefined;
      finished.resolve();
    }
  }
}
