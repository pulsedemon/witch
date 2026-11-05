import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ClaudeTask } from './agents/claude-task.js';
import { familiarMarker } from './agents/familiar-report.js';
import type {
  FamiliarAction,
  FamiliarProgress,
} from './agents/familiar-report.js';
import { running, terminateGraceMs } from './agents/shutdown.js';
import { errorMessage, readLines } from './agents/stderr.js';
import type { TaskStatus } from './agents/types.js';
import { callControl, ControlTimeoutError } from './persistence/control.js';
import type { ControlBinding, ControlResult } from './persistence/control.js';

/** outranks user, project and local settings, so the routed model runs as named and an overload doesn't switch it. */
const settings = JSON.stringify({
  env: {
    CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP: '1',
    CLAUDE_CODE_NO_MODEL_FALLBACK: '1',
  },
});

/** the wrapper owns the stream protocol and model settings; the native model and permissions remain caller arguments. */
export function claudeArguments(args: readonly string[]): string[] {
  const conflicting = new Set([
    '--settings',
    '-p',
    '--print',
    '--verbose',
    '--output-format',
    '--input-format',
    '--include-partial-messages',
    '--replay-user-messages',
    '--remote-control',
    '--permission-prompt-tool',
    '--help',
    '-h',
    '--version',
    '-v',
  ]);
  for (const arg of args) {
    if (arg === '--') break;
    if (conflicting.has(arg.split('=')[0]!))
      throw new Error(
        `Claude familiar mode cannot include ${arg}; it supplies its own print/stream protocol and settings.`,
      );
  }
  return [
    '--print',
    '--verbose',
    '--output-format',
    'stream-json',
    '--settings',
    settings,
    ...args,
  ];
}

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

export async function runClaudeFamiliar(
  binding: ControlBinding,
  name: string,
  reportFile: string,
  args: readonly string[],
): Promise<number> {
  const argv = claudeArguments(args);
  const path = resolve(reportFile);
  const file = await open(path, 'wx', 0o600);
  const run = randomUUID();
  let stopped: NodeJS.Signals | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let drain: ReturnType<typeof setTimeout> | undefined;
  const terminate = (signal: NodeJS.Signals) => {
    if (!child || !running(child)) return;
    child.kill(signal);
    escalation ??= setTimeout(() => {
      if (child && running(child)) child.kill('SIGKILL');
    }, terminateGraceMs);
  };
  const interrupt = () => {
    stopped = 'SIGINT';
    terminate('SIGINT');
  };
  const stop = () => {
    stopped = 'SIGTERM';
    terminate('SIGTERM');
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', stop);
  try {
    await registerFamiliar(binding, run, name, 'claude', () => !!stopped);
    const reports = new FamiliarReports(binding, run, (error) => {
      task.failed(error.message);
      terminate('SIGTERM');
    });
    const task = new ClaudeTask(process.cwd(), (progress) =>
      reports.push(progress),
    );
    child = spawn('claude', argv, {
      stdio: ['inherit', 'pipe', 'pipe'],
      detached: false,
    });
    child.stderr!.pipe(process.stderr, { end: false });
    readLines(child.stdout!, (text) => {
      if (!text.trim()) return;
      try {
        task.message(JSON.parse(text));
      } catch (error) {
        task.failed(`Invalid Claude task JSON: ${errorMessage(error)}`);
      }
    });
    child.once('error', (error) =>
      task.failed(`Claude could not start: ${error.message}`),
    );
    child.once('exit', () => {
      clearTimeout(escalation);
      // descendants can retain output pipes after Claude exits; native command cleanup owns that group.
      drain = setTimeout(() => {
        for (const stream of [child!.stdout!, child!.stderr!]) {
          stream.push(null);
          stream.destroy();
        }
      }, 100);
    });
    const { code, signal } = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child!.once('close', (code, signal) => resolve({ code, signal }));
    });
    clearTimeout(drain);
    let terminal = task.closed(
      code,
      stopped ?? (reports.error ? null : signal),
    );
    const save = () => saveReport(file, terminal.report ?? '');
    await save();
    try {
      await reports.finish(terminal);
    } catch (error) {
      task.failed(errorMessage(error));
      terminal = task.closed(code, stopped ?? null);
      await save();
    }
    process.stdout.write(`${terminal.report ?? ''}\n\nSaved report: ${path}\n`);
    return exitCode(terminal.status);
  } catch (error) {
    const message = errorMessage(error);
    await file.writeFile(message);
    process.stderr.write(`witch: ${message}\nSaved report: ${path}\n`);
    return stopped ? 130 : 1;
  } finally {
    clearTimeout(escalation);
    clearTimeout(drain);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', stop);
    await file.close();
  }
}
