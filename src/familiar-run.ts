import type { FileHandle } from 'node:fs/promises';

import { setTimeout as delay } from 'node:timers/promises';

import { familiarMarker } from './agents/familiar-report.js';

import type {
  FamiliarAction,
  FamiliarProgress,
} from './agents/familiar-report.js';

import type { TaskStatus } from './agents/types.js';

import { errorMessage } from './errors.js';

import { callControl, ControlTimeoutError } from './persistence/control.js';

import type { ControlBinding, ControlResult } from './persistence/control.js';

/** one in-flight snapshot preserves ordering while tool bursts replace only unsent progress. */
export class FamiliarReports {
  private sequence = 0;
  private pending?: FamiliarProgress;
  private sending?: Promise<void>;
  error?: Error;

  constructor(
    private readonly binding: ControlBinding,
    private readonly run: string,
    private readonly failed: (error: Error) => void,
  ) {}

  push(progress: FamiliarProgress): void {
    if (this.error) return;

    this.pending = progress;

    this.sending ??= this.send()
      .catch((error: unknown) => {
        this.error = new Error(
          `Familiar reporting failed: ${errorMessage(error)}`,
        );

        this.failed(this.error);
      })
      .finally(() => {
        this.sending = undefined;

        if (this.pending && !this.error) this.push(this.pending);
      });
  }

  async finish(progress: FamiliarProgress): Promise<void> {
    this.push(progress);

    while (this.sending) await this.sending;

    if (this.error) throw this.error;
  }

  private async send(): Promise<void> {
    while (this.pending) {
      const progress = this.pending;

      this.pending = undefined;

      let outcome: ControlResult;

      try {
        outcome = await callFamiliar(this.binding, {
          kind: 'familiar-update',
          run: this.run,
          sequence: this.sequence++,
          progress,
        });
      } catch (error) {
        if (
          progress.status === 'running' &&
          error instanceof ControlTimeoutError
        )
          continue;

        throw error;
      }

      if (outcome.kind !== 'familiar-updated')
        throw new Error(`Unexpected familiar reply: ${outcome.kind}`);
    }
  }
}

/** retries a familiar's control call for 10 s, each try capped at 1.5 s, then throws the last failure. */
export async function callFamiliar(
  binding: ControlBinding,
  action: FamiliarAction,
): Promise<Exclude<ControlResult, { kind: 'error' }>> {
  const deadline = Date.now() + 10_000;

  for (;;) {
    let outcome: ControlResult;

    try {
      outcome = await callControl(
        binding,
        action,
        Math.min(deadline, Date.now() + 1500),
      );
    } catch (error) {
      if (Date.now() < deadline) await delay(100);

      if (Date.now() >= deadline) throw error;

      continue;
    }

    if (outcome.kind === 'error') throw new Error(outcome.message);

    return outcome;
  }
}

/** overwrites the report file in place, so the path stays the one the caller was told. */
export async function saveReport(
  file: FileHandle,
  report: string,
): Promise<void> {
  const bytes = Buffer.from(report);

  let offset = 0;

  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(
      bytes,
      offset,
      bytes.length - offset,
      offset,
    );

    offset += bytesWritten;
  }

  await file.truncate(bytes.length);

  await file.sync();
}

export function exitCode(status: TaskStatus): number {
  return status === 'completed' ? 0 : status === 'stopped' ? 130 : 1;
}

export async function registerFamiliar(
  binding: ControlBinding,
  run: string,
  name: string,
  runtime: Extract<FamiliarAction, { kind: 'familiar-register' }>['runtime'],
  stopped: () => boolean,
): Promise<void> {
  const marker = familiarMarker({
    version: 1,
    conversation: binding.conversation,
    activation: binding.activation,
    run,
  });

  const deadline = Date.now() + 10_000;

  for (;;) {
    if (stopped()) throw new Error('Familiar stopped before launch.');

    if (Date.now() >= deadline)
      throw new Error('Familiar registration timed out.');

    process.stdout.write(marker);

    const outcome = await callControl(
      binding,
      { kind: 'familiar-register', run, name, runtime },
      deadline,
    );

    if (outcome.kind === 'error') throw new Error(outcome.message);

    if (outcome.kind === 'familiar-registered') break;

    if (outcome.kind !== 'familiar-pending')
      throw new Error(
        `Unexpected familiar registration reply: ${outcome.kind}`,
      );

    await delay(100);
  }

  if (stopped()) throw new Error('Familiar stopped before launch.');
}
