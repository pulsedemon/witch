import type { FileHandle } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { familiarMarker } from '../agents/familiar-report.js';
import type {
  FamiliarAction,
  FamiliarProgress,
} from '../agents/familiar-report.js';
import type { TaskStatus } from '../agents/types.js';
import { errorMessage } from '../errors.js';
import {
  callControl,
  controlWindow,
  ControlTimeoutError,
} from '../persistence/control.js';
import type { ControlBinding, ControlResult } from '../persistence/control.js';
import { elapsed } from '../ui/status/elapsed.js';
import type { PlanReview } from './plan-review.js';

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

/** waits up to `controlWindow` on one request, publishing another only after a failure that isn't a timeout, then throws the last failure. */
export async function callFamiliar(
  binding: ControlBinding,
  action: FamiliarAction,
): Promise<Exclude<ControlResult, { kind: 'error' }>> {
  const deadline = Date.now() + controlWindow;

  for (;;) {
    let outcome: ControlResult;

    try {
      outcome = await callControl(binding, action, deadline);
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

export async function saveFinalReport(
  file: FileHandle,
  progress: FamiliarProgress,
  answer: string,
): Promise<void> {
  await saveReport(
    file,
    progress.status === 'completed' ? answer : (progress.report ?? ''),
  );
}

export async function settlePlanReview(
  file: FileHandle | undefined,
  review: PlanReview,
  progress: FamiliarProgress,
  answer: string,
  stopped: () => boolean,
  reports?: FamiliarReports,
): Promise<FamiliarProgress> {
  let terminal = review.finish(progress, answer);
  let saved: string | undefined;

  const failure = (error: unknown) =>
    review.finish(
      {
        ...progress,
        status: 'failed',
        report: [terminal.reason ?? progress.report, errorMessage(error)]
          .filter(Boolean)
          .join('\n\n'),
      },
      answer,
    );

  const checkStop = () => {
    if (!stopped() || terminal.status === 'stopped') return;

    terminal = review.finish(
      { ...progress, status: 'stopped', report: 'Plan review stopped.' },
      answer,
    );
  };

  const checkDraft = async () => {
    if (terminal.status !== 'completed') return;

    const reason = await review.draftError();

    if (reason)
      terminal = review.finish(
        { ...progress, status: 'failed', report: reason },
        '',
      );
  };

  const save = async () => {
    if (!file) return;

    const report = terminal.report ?? '';
    await saveReport(file, report);
    saved = report;
  };

  try {
    if (terminal.status === 'completed') {
      // show draft validation while the wrapper is still checking the receipt.
      await reports?.finish({
        ...progress,
        status: 'running',
        activity: 'Checking plan review receipt',
      });

      await checkDraft();
    }

    checkStop();
    await save();
    await checkDraft();
    checkStop();

    if (saved !== terminal.report) await save();
  } catch (error) {
    terminal = failure(error);
  }

  try {
    const completed = terminal.status === 'completed';
    await reports?.finish(terminal);

    if (completed) {
      await checkDraft();
      checkStop();

      if (terminal.status !== 'completed') await reports?.finish(terminal);
    }
  } catch (error) {
    terminal = failure(error);
    checkStop();
  }

  if (saved !== terminal.report) await save();

  return terminal;
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
  planReview = false,
) {
  const marker = familiarMarker({
    version: 1,
    conversation: binding.conversation,
    activation: binding.activation,
    run,
  });

  const deadline = Date.now() + controlWindow;

  for (;;) {
    if (stopped()) throw new Error('Familiar stopped before launch.');

    if (Date.now() >= deadline)
      throw new Error('Familiar registration timed out.');

    process.stdout.write(marker);

    const outcome = await callControl(
      binding,
      {
        kind: 'familiar-register',
        run,
        name,
        runtime,
        ...(planReview && { planReview: true as const }),
      },
      deadline,
    );

    if (outcome.kind === 'error') throw new Error(outcome.message);

    if (outcome.kind === 'familiar-registered') {
      if (stopped()) throw new Error('Familiar stopped before launch.');

      return outcome.reviewScope;
    }

    if (outcome.kind !== 'familiar-pending')
      throw new Error(
        `Unexpected familiar registration reply: ${outcome.kind}`,
      );

    await delay(100);
  }
}

const suspendedGapMs = 30_000;

/**
 * totals the wall-clock time this process didn't run, such as the Mac sleeping under a closed lid, which no
 * sleep assertion prevents. the returned function ends the watch and words the total for the report.
 */
export function watchSuspension(): () => string | undefined {
  const started = Date.now();
  let last = started;
  let suspended = 0;

  const measure = () => {
    const now = Date.now();

    if (now - last > suspendedGapMs) suspended += now - last;

    last = now;
  };

  const timer = setInterval(measure, 2000);
  timer.unref();

  return () => {
    clearInterval(timer);
    measure();

    return suspended
      ? `This run was suspended for ${elapsed(suspended)} of its ${elapsed(Date.now() - started)}, as when the Mac sleeps, so its elapsed time overstates its work.`
      : undefined;
  };
}
