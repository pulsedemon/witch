import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { ClaudeTask } from '../agents/claude/task.js';
import type { FamiliarProgress } from '../agents/familiar-report.js';
import { nativeExecutable } from '../agents/executable.js';
import { nativeLaunch } from '../agents/native-launch.js';
import { running, terminateGraceMs } from '../agents/shutdown.js';
import { errorMessage } from '../errors.js';
import { readLines } from '../agents/stderr.js';
import {
  exitCode,
  FamiliarReports,
  registerFamiliar,
  saveFinalReport,
  settlePlanReview,
  watchSuspension,
} from './familiar-run.js';
import type { PlanReview } from './plan-review.js';
import type { ControlBinding } from '../persistence/control.js';

/** outranks user, project and local settings, so the routed model runs as named and an overload doesn't switch it; lean also turns hooks off. */
function settings(lean: boolean) {
  return JSON.stringify({
    env: {
      CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP: '1',
      CLAUDE_CODE_NO_MODEL_FALLBACK: '1',
    },
    ...(lean && { disableAllHooks: true }),
  });
}

/** a later successful nonempty result replaces the saved answer, and native output cannot identify an acknowledgement. */
export const repeatAnswerInstruction =
  'Your last reply is saved as your final answer. If a background task notification starts a turn after you have answered, end that turn by repeating your complete answer exactly, with nothing else.';

/** the wrapper owns the stream protocol and model settings; the native model and permissions remain caller arguments. */
export function claudeArguments(
  args: readonly string[],
  lean = false,
): string[] {
  const conflicting = new Set([
    '--settings',
    // a second one replaces the wrapper's instead of adding to it
    '--append-system-prompt',
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
        `Claude familiar mode cannot include ${arg}; it supplies its own print/stream protocol, settings and appended system prompt.`,
      );
  }

  return [
    '--print',
    '--verbose',
    '--output-format',
    'stream-json',
    '--settings',
    settings(lean),
    '--append-system-prompt',
    repeatAnswerInstruction,
    ...(lean ? ['--strict-mcp-config', '--disable-slash-commands'] : []),
    ...args,
  ];
}

export async function runClaudeFamiliar(
  binding: ControlBinding,
  name: string,
  reportFile: string,
  args: readonly string[],
  lean: boolean,
  review?: PlanReview,
): Promise<number> {
  const argv = claudeArguments(args, lean);
  let file = review ? undefined : await open(reportFile, 'wx', 0o600);
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
  let registered = false;
  let activeTask: ClaudeTask | undefined;

  const reports = new FamiliarReports(binding, run, (error) => {
    activeTask?.failed(error.message);
    terminate('SIGTERM');
  });

  try {
    const scope = await registerFamiliar(
      binding,
      run,
      name,
      'claude',
      () => !!stopped,
      !!review,
    );

    registered = true;

    const attempt = review
      ? await review.openReport(reportFile, scope)
      : undefined;

    if (attempt) file = attempt.file;

    const prepared = await attempt?.prepare();

    if (stopped) throw new Error('Familiar stopped before launch.');

    const cwd = prepared?.cwd ?? process.cwd();

    const task = new ClaudeTask(
      cwd,
      (progress) => reports.push(progress),
      !!review,
    );

    activeTask = task;
    const claude = nativeExecutable('claude');

    if (!claude) throw new Error('Native executable not found: claude');

    child = nativeLaunch(claude, (executable) =>
      spawn(executable, argv, {
        cwd,
        ...(review && {
          env: { ...process.env, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' },
        }),
        stdio: [review ? 'pipe' : 'inherit', 'pipe', 'pipe'],
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

    if (review) {
      child.stdin!.on('error', (error) =>
        task.failed(`Could not send the plan draft: ${error.message}`),
      );

      child.stdin!.end(prepared!.prompt);
    }

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

    if (review) {
      const result = task.latestAnswer;
      let progress = terminal;

      if (terminal.status === 'completed') {
        const reason = task.permissionDenials.length
          ? task.permissionDenials.join('\n')
          : !result
            ? 'Claude exited before the final plan review turn returned a result.'
            : undefined;

        progress = {
          ...terminal,
          model: result?.model ?? terminal.model,
          ...(reason && { status: 'failed', report: reason }),
          exhausted: task.pendingExhaustion,
        };
      }

      terminal = await settlePlanReview(
        file,
        review,
        progress,
        result?.text ?? '',
        () => !!stopped,
        reports,
      );
    } else {
      await saveFinalReport(file!, terminal, task.answer);

      try {
        await reports.finish(terminal);
      } catch (error) {
        task.failed(errorMessage(error));
        terminal = closed(stopped ?? null);
        await saveFinalReport(file!, terminal, task.answer);
      }
    }

    process.stdout.write(
      `${terminal.report ?? ''}\n\nSaved report: ${reportFile}\n`,
    );

    return exitCode(terminal.status);
  } catch (error) {
    const message = errorMessage(error);

    const progress: FamiliarProgress = {
      status: stopped ? 'stopped' : 'failed',
      report: message,
    };

    let diagnostic = message;

    try {
      if (review) {
        const result = await settlePlanReview(
          file,
          review,
          progress,
          '',
          () => !!stopped,
          registered ? reports : undefined,
        );

        diagnostic = result.reason ?? message;
      } else await saveFinalReport(file!, progress, '');
    } finally {
      process.stderr.write(`witch: ${diagnostic}\n`);
    }

    if (file) process.stderr.write(`Saved report: ${reportFile}\n`);

    return stopped ? 130 : 1;
  } finally {
    clearTimeout(escalation);
    clearTimeout(drain);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', stop);
    await file?.close();
  }
}
