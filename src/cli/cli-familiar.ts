import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { ClaudeTask } from '../agents/claude/task.js';
import { nativeLaunch } from '../agents/native-launch.js';
import { running, terminateGraceMs } from '../agents/shutdown.js';
import { errorMessage } from '../errors.js';
import { readLines } from '../agents/stderr.js';
import {
  exitCode,
  FamiliarReports,
  registerFamiliar,
  saveReport,
  watchSuspension,
} from './familiar-run.js';
import type { ControlBinding } from '../persistence/control.js';

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

export async function runClaudeFamiliar(
  binding: ControlBinding,
  name: string,
  reportFile: string,
  args: readonly string[],
): Promise<number> {
  const argv = claudeArguments(args);
  const file = await open(reportFile, 'wx', 0o600);
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
  const suspension = watchSuspension();

  try {
    await registerFamiliar(binding, run, name, 'claude', () => !!stopped);

    const reports = new FamiliarReports(binding, run, (error) => {
      task.failed(error.message);
      terminate('SIGTERM');
    });

    const task = new ClaudeTask(process.cwd(), (progress) =>
      reports.push(progress),
    );

    child = nativeLaunch('claude', undefined, (executable) =>
      spawn(executable, argv, {
        stdio: ['inherit', 'pipe', 'pipe'],
        detached: false,
      }),
    );

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
    const suspended = suspension();

    const closed = (signal: NodeJS.Signals | null) => {
      const terminal = task.closed(code, signal);

      return suspended
        ? {
            ...terminal,
            report: [terminal.report, suspended].filter(Boolean).join('\n\n'),
          }
        : terminal;
    };

    let terminal = closed(stopped ?? (reports.error ? null : signal));

    const save = () =>
      saveReport(
        file,
        terminal.status === 'completed' ? task.answer : (terminal.report ?? ''),
      );

    await save();

    try {
      await reports.finish(terminal);
    } catch (error) {
      task.failed(errorMessage(error));
      terminal = closed(stopped ?? null);
      await save();
    }

    process.stdout.write(
      `${terminal.report ?? ''}\n\nSaved report: ${reportFile}\n`,
    );

    return exitCode(terminal.status);
  } catch (error) {
    const message = errorMessage(error);
    await file.writeFile(message);
    process.stderr.write(`witch: ${message}\nSaved report: ${reportFile}\n`);

    return stopped ? 130 : 1;
  } finally {
    clearTimeout(escalation);
    clearTimeout(drain);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', stop);
    await file.close();
  }
}
