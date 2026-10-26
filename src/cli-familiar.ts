import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ClaudeReview } from './agents/claude-review.js';
import { familiarMarker } from './agents/familiar-report.js';
import type { FamiliarProgress } from './agents/familiar-report.js';
import { errorMessage } from './agents/stderr.js';
import { callControl } from './persistence/control.js';
import type { ControlBinding } from './persistence/control.js';

/** the wrapper owns the stream protocol; native model, settings and permissions remain caller arguments. */
export function claudeArguments(args: readonly string[]): string[] {
  const conflicting = new Set([
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
        `Claude familiar mode cannot include ${arg}; it supplies its own print/stream protocol.`,
      );
  }
  return ['--print', '--verbose', '--output-format', 'stream-json', ...args];
}

/** one in-flight snapshot preserves ordering while tool bursts replace only unsent progress. */
class FamiliarReports {
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
      const sequence = this.sequence++;
      const deadline = Date.now() + 10_000;
      for (;;) {
        const outcome = await callControl(
          this.binding,
          {
            kind: 'familiar-update',
            run: this.run,
            sequence,
            progress,
          },
          Math.min(deadline, Date.now() + 1500),
        ).catch(async (error: unknown) => {
          if (Date.now() >= deadline) throw error;
          await delay(100);
          return undefined;
        });
        if (!outcome) continue;
        if (outcome.kind === 'error') throw new Error(outcome.message);
        if (outcome.kind !== 'familiar-updated')
          throw new Error(`Unexpected familiar reply: ${outcome.kind}`);
        break;
      }
    }
  }
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
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
      return;
    child.kill(signal);
    escalation ??= setTimeout(() => {
      if (child?.pid && child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
    }, 2000);
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
    const marker = familiarMarker({
      version: 1,
      conversation: binding.conversation,
      activation: binding.activation,
      run,
    });
    const deadline = Date.now() + 10_000;
    for (;;) {
      if (stopped)
        throw new Error(`Claude review stopped before launch (${stopped}).`);
      if (Date.now() >= deadline)
        throw new Error('Claude familiar registration timed out.');
      process.stdout.write(marker);
      const outcome = await callControl(
        binding,
        { kind: 'familiar-register', run, name },
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
    if (stopped)
      throw new Error(`Claude review stopped before launch (${stopped}).`);
    const reports = new FamiliarReports(binding, run, (error) => {
      review.failed(error.message);
      terminate('SIGTERM');
    });
    const review = new ClaudeReview(process.cwd(), (progress) =>
      reports.push(progress),
    );
    child = spawn('claude', argv, {
      stdio: ['inherit', 'pipe', 'pipe'],
      detached: false,
    });
    child.stderr!.pipe(process.stderr, { end: false });
    let pending = '';
    const line = (text: string) => {
      if (!text.trim()) return;
      try {
        review.message(JSON.parse(text));
      } catch (error) {
        review.failed(`Invalid Claude review JSON: ${errorMessage(error)}`);
      }
    };
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      const lines = chunk.split('\n');
      lines[0] = pending + lines[0];
      pending = lines.pop()!;
      for (const text of lines) line(text);
    });
    child.stdout!.on('end', () => {
      if (pending) {
        line(pending);
        pending = '';
      }
    });
    child.once('error', (error) =>
      review.failed(`Claude could not start: ${error.message}`),
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
    let terminal = review.closed(
      code,
      stopped ?? (reports.error ? null : signal),
    );
    const save = async () => {
      const bytes = Buffer.from(terminal.report ?? '');
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
    };
    await save();
    try {
      await reports.finish(terminal);
    } catch (error) {
      review.failed(errorMessage(error));
      terminal = review.closed(code, stopped ?? null);
      await save();
    }
    process.stdout.write(`${terminal.report ?? ''}\n\nSaved review: ${path}\n`);
    return terminal.status === 'completed'
      ? 0
      : terminal.status === 'stopped'
        ? 130
        : 1;
  } catch (error) {
    const message = errorMessage(error);
    await file.writeFile(message);
    process.stderr.write(`witch: ${message}\nSaved review: ${path}\n`);
    return stopped ? 130 : 1;
  } finally {
    clearTimeout(escalation);
    clearTimeout(drain);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', stop);
    await file.close();
  }
}
