import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexAdapter } from '../agents/codex/adapter.js';
import { nativeExecutable } from '../agents/executable.js';
import { nativeLaunch } from '../agents/native-launch.js';
import type {
  FamiliarAction,
  FamiliarProgress,
  MarkerLine,
} from '../agents/familiar-report.js';
import {
  familiarMarker,
  mergeCasts,
  scanMarkers,
} from '../agents/familiar-report.js';
import { errorMessage } from '../errors.js';
import { watchChild, withTail } from '../agents/stderr.js';
import type { AgentEvent, AgentSession, UserRequest } from '../agents/types.js';
import {
  callFamiliar,
  exitCode,
  FamiliarReports,
  registerFamiliar,
  saveFinalReport,
  saveReport,
  settlePlanReview,
  watchSuspension,
} from './familiar-run.js';
import { questionReply } from '../core/prompts.js';
import type { ControlBinding } from '../persistence/control.js';
import { elapsed } from '../ui/status/elapsed.js';
import type { PlanReview } from './plan-review.js';

/** bounds registration to the turn being sent; a running turn can stay silent for minutes. */
const startupDeadlineMs = 180_000;

/** the wrapper owns transport and input; native configuration remains Codex's. */
export function codexArguments(args: readonly string[]): string[] {
  const values = new Set([
    '-c',
    '--config',
    '--enable',
    '--disable',
    '--code-mode-host',
  ]);

  const flags = new Set(['--strict-config', '--analytics-default-enabled']);

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;

    if (flags.has(arg)) continue;

    if (!values.has(arg.split('=')[0]!))
      throw new Error(
        `Codex familiar mode cannot include ${arg}; use native app-server configuration options.`,
      );

    if (!arg.includes('=') && !args[++index])
      throw new Error(`Codex option ${arg} requires a value.`);
  }

  return ['app-server', '--stdio', ...args];
}

export async function runCodexFamiliar(
  binding: ControlBinding,
  name: string,
  reportFile: string,
  args: readonly string[],
  lean: boolean,
  review?: PlanReview,
): Promise<number> {
  const argv = codexArguments(
    lean ? ['-c', 'skills.include_instructions=false', ...args] : args,
  );

  let file = review ? undefined : await open(reportFile, 'wx', 0o600);
  const run = randomUUID();
  const abort = new AbortController();
  let session: AgentSession | undefined;
  let closing: Promise<void> | undefined;
  let stopped = false;
  let ending = false;
  let failure: string | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let startup: ReturnType<typeof setTimeout> | undefined;
  let waiting = review ? 'the plan draft and brief' : 'the prompt on stdin';
  let stalled = false;

  let childExit:
    | { code: number | null; signal: NodeJS.Signals | null; tail: string }
    | undefined;

  let progress: FamiliarProgress = { status: 'running', tools: 0 };
  const tools = new Set<string>();
  const prompts: string[] = [];

  const requests = new Map<
    string,
    { input: UserRequest; resolved: boolean; work: Promise<void> }
  >();

  const close = () => {
    process.stdin.destroy();

    if (session) {
      closing ??= session.close();

      void closing.catch((error: unknown) => {
        failure ??= errorMessage(error);
      });
    } else abort.abort();
  };

  const fail = (error: unknown) => {
    failure ??= errorMessage(error);
    close();
  };

  const stop = () => {
    stopped = true;
    close();
  };

  const reports = new FamiliarReports(binding, run, fail);

  const request = (input: UserRequest) => {
    if (requests.has(input.id)) return;

    const pending = { input, resolved: false, work: Promise.resolve() };
    requests.set(input.id, pending);

    pending.work = (async () => {
      let action: FamiliarAction = {
        kind: 'familiar-request',
        run,
        request: input,
      };

      while (!pending.resolved && !ending && !stopped && !failure) {
        const outcome = await callFamiliar(binding, action);

        if (pending.resolved || ending) return;

        if (outcome.kind === 'familiar-response') {
          if (input.replyAsPrompt) {
            if (outcome.response.decision === 'accept' && input.questions) {
              const prompt = questionReply(input.questions, outcome.response);

              if (!(await session!.steer(prompt))) prompts.push(prompt);
            } else if (outcome.response.decision === 'cancel') stop();

            await callFamiliar(binding, {
              kind: 'familiar-request-resolved',
              run,
              id: input.id,
            });

            pending.resolved = true;
          } else session!.respond(input.id, outcome.response);

          return;
        }

        if (outcome.kind !== 'familiar-request-pending')
          throw new Error(`Unexpected familiar request reply: ${outcome.kind}`);

        action = { kind: 'familiar-request-poll', run, id: input.id };
        await delay(100);
      }
    })().catch((error: unknown) => {
      if (!pending.resolved && !ending && !stopped) fail(error);
    });
  };

  const commandOutput = new Map<string, MarkerLine>();

  // nested wrappers register with the owning host, which sees only this wrapper's stdout.
  const forwardMarkers = (event: Extract<AgentEvent, { type: 'tool' }>) => {
    if (event.done) {
      commandOutput.delete(event.id);

      return;
    }

    if (event.command && !event.append) {
      commandOutput.set(event.id, { partial: '', discarding: false });

      return;
    }

    const output = event.append && commandOutput.get(event.id);

    if (!output) return;

    scanMarkers(output, event.text, binding, (marker) =>
      process.stdout.write(familiarMarker(marker)),
    );
  };

  const receive = (event: AgentEvent) => {
    if (ending) return;

    if (event.type === 'tool') forwardMarkers(event);

    if (event.type === 'info')
      progress = { ...progress, model: event.info.model };
    else if (event.type === 'tool' && !event.done && !event.append) {
      tools.add(event.id);
      progress = { ...progress, tools: tools.size, activity: event.title };
    } else if (event.type === 'notice' && event.protocolError && review) {
      fail(new Error(event.text));

      return;
    } else if (event.type === 'notice' && event.transient)
      progress = {
        ...progress,
        notices: [...(progress.notices ?? []), event.text],
      };
    else if (event.type === 'spell' || event.type === 'subagent') {
      const spells = mergeCasts(
        progress.spells,
        event.type === 'spell' ? [event.cast] : (event.subagent.spells ?? []),
      );

      if (!spells) return;

      progress = { ...progress, spells };
    } else if (event.type === 'request') {
      if (review) fail(new Error('A plan reviewer cannot request input.'));
      else request(event.request);

      return;
    } else if (event.type === 'request-resolved') {
      const pending = requests.get(event.id);

      if (pending && !pending.resolved) {
        pending.resolved = true;

        pending.work = pending.work
          .then(async () => {
            await callFamiliar(binding, {
              kind: 'familiar-request-resolved',
              run,
              id: event.id,
            });
          })
          .catch((error: unknown) => {
            if (!ending) fail(error);
          });
      }

      return;
    } else return;

    reports.push(progress);
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  let report = '';
  /** the last turn's final message: a follow-up turn only carries the reply to the familiar's own question. */
  let answer = '';
  let answerModel: string | undefined;
  let status: FamiliarProgress['status'] = 'failed';
  let exhausted = false;
  let registered = false;
  const save = () => saveReport(file!, report);
  const suspension = watchSuspension();

  try {
    const scope = await registerFamiliar(
      binding,
      run,
      name,
      'codex',
      () => stopped,
      !!review,
    );

    registered = true;

    const attempt = review
      ? await review.openReport(reportFile, scope)
      : undefined;

    if (attempt) file = attempt.file;

    startup = setTimeout(() => {
      if (failure || stopped) return;

      stalled = true;

      fail(
        new Error(
          `Codex familiar did not send its turn within ${elapsed(startupDeadlineMs)}; waiting for ${waiting}`,
        ),
      );
    }, startupDeadlineMs);

    reports.push(progress);
    heartbeat = setInterval(() => reports.push(progress), 2000);
    const prepared = await attempt?.prepare();
    let prompt = prepared?.prompt ?? '';

    if (!review) {
      process.stdin.setEncoding('utf8');

      for await (const chunk of process.stdin) prompt += chunk as string;
    }

    waiting = 'Codex to start';
    const codex = nativeExecutable('codex');

    if (!codex) throw new Error('Native executable not found: codex');

    const adapter = new CodexAdapter((executable, cwd, signal) => {
      const child = nativeLaunch(executable, (command) =>
        spawn(command, argv, {
          cwd,
          signal,
          stdio: 'pipe',
          detached: false,
        }),
      );

      // the app-server's log lines stay out of the calling agent's output; failures carry their tail
      const output = watchChild(child);

      child.once('close', (code, signal) => {
        childExit = { code, signal, tail: output.tail() };

        if (
          !closing &&
          [...requests.values()].some(
            (pending) => pending.input.replyAsPrompt && !pending.resolved,
          )
        )
          fail(
            new Error(
              withTail(
                'Codex exited while awaiting a question response',
                childExit.tail,
              ),
            ),
          );
      });

      return child;
    });

    session = await adapter.connect({
      executable: codex,
      cwd: prepared?.cwd ?? process.cwd(),
      memoryDirectories: [],
      withoutMcp: lean,
      ...(review && { planReview: true }),
      signal: abort.signal,
      onEvent: receive,
      onProcess: async () => {},
    });

    if (stopped || failure)
      throw new Error(failure ?? 'Codex familiar stopped before its turn.');

    waiting = 'the spell listing';
    // only to recognize the spells it casts, so a failed listing costs only that
    await session.skills().catch(() => {});
    clearTimeout(startup);

    for (;;) {
      const result = await session.send(prompt);
      report = [report, result.text, result.error].filter(Boolean).join('\n\n');
      status = result.status === 'interrupted' ? 'stopped' : result.status;
      exhausted = !!result.exhausted;

      if (review) {
        answer = result.reviewAnswer?.text ?? '';
        answerModel = result.reviewAnswer?.model;

        if (status === 'completed' && !answer)
          failure ??= 'Codex completed without a final answer.';

        break;
      }

      answer = result.final ?? '';
      // a checkpoint: the familiar can still await a question's reply or run another turn
      await save();

      if (result.status !== 'completed') break;

      while (!prompts.length && !stopped && !failure) {
        const pending = [...requests.values()].filter(
          (request) => request.input.replyAsPrompt && !request.resolved,
        );

        if (!pending.length) break;

        await Promise.race(pending.map((request) => request.work));
      }

      if (stopped || failure || !prompts.length) break;

      prompt = prompts.splice(0).join('\n');
    }
  } catch (error) {
    failure ??= errorMessage(error);
  } finally {
    clearTimeout(startup);
    close();

    await closing?.catch((error: unknown) => {
      failure ??= errorMessage(error);
    });

    ending = true;
    clearInterval(heartbeat);

    for (const pending of requests.values()) pending.resolved = true;

    await Promise.all([...requests.values()].map((pending) => pending.work));

    if (!review) {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  }

  try {
    // the stall fails before cleanup, and only cleanup's close captures the app-server's stderr
    if (stalled && failure) failure = withTail(failure, childExit?.tail ?? '');

    if (stopped) status = 'stopped';
    else if (failure) status = 'failed';
    else if (status === 'completed' && childExit?.code !== 0) {
      status = 'failed';

      failure = withTail(
        `Codex exited (${childExit?.signal ?? childExit?.code ?? 'unknown'})`,
        childExit?.tail ?? '',
      );
    }

    report = [
      report,
      failure,
      stopped && 'Codex familiar stopped.',
      suspension(),
    ]
      .filter(Boolean)
      .join('\n\n');

    const terminal: FamiliarProgress = {
      ...progress,
      status,
      report,
      ...(review && answer && { model: answerModel }),
      // codex names no limit, so routing holds the whole runtime
      ...(exhausted && status === 'failed' && { exhausted: {} }),
    };

    const reporting = registered ? reports : undefined;

    const result = review
      ? await settlePlanReview(
          file,
          review,
          terminal,
          answer,
          () => stopped,
          reporting,
        )
      : await reportOrdinaryResult(
          file!,
          terminal,
          answer,
          () => stopped,
          reporting,
        );

    if (file)
      process.stdout.write(
        `${result.report ?? ''}\n\nSaved report: ${reportFile}\n`,
      );
    else process.stderr.write(`${result.report ?? ''}\n`);

    return exitCode(result.status);
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await file?.close();
  }
}

async function reportOrdinaryResult(
  file: FileHandle,
  result: FamiliarProgress,
  answer: string,
  stopped: () => boolean,
  reports?: FamiliarReports,
) {
  await saveFinalReport(file, result, answer);

  try {
    await reports?.finish(result);

    return result;
  } catch (error) {
    const failed: FamiliarProgress = {
      ...result,
      status: stopped() ? 'stopped' : 'failed',
      report: [result.report, errorMessage(error)].filter(Boolean).join('\n\n'),
    };

    await saveFinalReport(file, failed, answer);

    return failed;
  }
}
