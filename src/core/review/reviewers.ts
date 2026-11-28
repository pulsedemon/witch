import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  FamiliarAction,
  FamiliarOutcome,
} from '../../agents/familiar-report.js';
import { FamiliarRun } from '../../agents/familiar-requests.js';
import {
  beforeDeadline,
  graceDeadline,
  NativeStop,
  NativeStopTimeout,
  signalGroup,
  stopDeadline,
} from '../../agents/shutdown.js';
import { errorMessage } from '../../errors.js';
import type { AgentEvent, TaskStatus } from '../../agents/types.js';

export interface Reviewer {
  name: string;
  /** the familiar wrapper's shell command, which reads its brief on stdin. */
  command: string;
  reportFile: string;
}

export interface ReviewerResult {
  /** the command's exit code; null when it was signalled or never ran. */
  code: number | null;
  /** the end of the command's stderr, why it couldn't start, the signal that killed it, and why its report couldn't be read. */
  diagnostics?: string;
  /** the familiar's last status, absent when it never registered. */
  status?: TaskStatus;
  model?: string;
  report: string;
}

/**
 * familiars Witch launches itself, outside any native session. the familiar mailbox asks `report` before the live
 * session, so a registration whose name Witch expects is admitted here instead of needing a native command's marker.
 */
export class Reviewers {
  /** reviewer names awaiting or holding a registration, with the run that registered. */
  private readonly expected = new Map<string, { run?: string }>();
  private readonly runs = new Map<string, FamiliarRun>();

  constructor(
    private readonly publish: (
      event: Extract<AgentEvent, { type: 'subagent' }>,
    ) => void,
  ) {}

  /** whether a familiar entry belongs to a Witch-launched reviewer, so native session shutdown leaves it alone. */
  readonly owns = (id: string): boolean =>
    [...this.runs.values()].some(({ subagent }) => subagent.id === id);

  /** the reply to a familiar action this registry owns, or undefined for one the live session should handle. */
  report(action: FamiliarAction): FamiliarOutcome | undefined {
    if (action.kind === 'familiar-register') {
      const expected = this.expected.get(action.name);

      if (!expected) return;

      if (expected.run === action.run)
        return { kind: 'familiar-registered', readOnlyReview: true };

      if (expected.run)
        throw new Error('This reviewer has already registered.');

      expected.run = action.run;

      this.runs.set(
        action.run,
        new FamiliarRun(action, (event) => {
          if (event.type === 'subagent') this.publish(event);
        }),
      );

      return { kind: 'familiar-registered', readOnlyReview: true };
    }

    const run = this.runs.get(action.run);

    if (!run) return;

    if (action.kind !== 'familiar-update')
      throw new Error(
        'A reviewer Witch launched runs read-only and cannot ask for anything.',
      );

    return run.report(action);
  }

  /** runs each reviewer's command in its own process group and resolves once every group is gone. */
  async run({
    cwd,
    reviewers,
    signal,
  }: {
    cwd: string;
    reviewers: readonly Reviewer[];
    signal: AbortSignal;
  }): Promise<ReviewerResult[]> {
    if (signal.aborted)
      return reviewers.map(() => ({ code: null, report: '' }));

    for (const { name } of reviewers) this.expected.set(name, {});

    const live = new Set<number>();
    const failures: unknown[] = [];
    const diagnostics = reviewers.map(() => '');
    const drained: Promise<void>[] = [];
    // a signal name, kept apart from the stream's text
    const killed: (NodeJS.Signals | null)[] = reviewers.map(() => null);
    let stopping: Promise<void> | undefined;

    /** kills what an exited wrapper left in its group, such as a native CLI whose wrapper was killed outright. */
    const cleanUp = async (group: number) => {
      // after an abort the stop owns escalation, since a shell that forked its command exits on SIGTERM while the
      // command still has its grace period
      if (stopping) return;

      try {
        signalLive(live, group, 'SIGKILL');
        const deadline = stopDeadline();
        await beforeDeadline(gone(live, [group], deadline, signal), deadline);
      } catch (error) {
        // this deadline can fire before the wait wakes to an abort, and the stop watches the group from then on
        if (stopping) return;

        live.delete(group);
        failures.push(error);
      }
    };

    const exits = reviewers.map(
      ({ command }, index) =>
        new Promise<number | null>((resolve) => {
          const child = spawn('/bin/sh', ['-c', command], {
            cwd,
            detached: true,
            stdio: ['ignore', 'ignore', 'pipe'],
          });

          if (child.pid) live.add(child.pid);

          child.stderr.setEncoding('utf8');

          drained.push(
            new Promise((drain) => child.stderr.once('close', () => drain())),
          );

          child.stderr.on('data', (chunk: string) => {
            diagnostics[index] = (diagnostics[index] + chunk).slice(-2000);
          });

          child.once('error', (error) => {
            diagnostics[index] = error.message;
            resolve(null);
          });

          child.once('exit', (code, ended) => {
            killed[index] = ended;
            // a failure here would mark the reviewers still running as failed, so the run throws it once all have exited
            void cleanUp(child.pid!).then(() => resolve(code));
          });
        }),
    );

    // a stop that misses its deadline ends the run even while a command still hasn't exited
    const missed = Promise.withResolvers<never>();
    const aborted = Promise.withResolvers<void>();

    const abort = () => {
      stopping ??= stopGroups(
        live,
        signal.reason instanceof NativeStop
          ? stopDeadline(signal.reason.options.deadline)
          : stopDeadline(),
      );

      stopping.catch(missed.reject);
      aborted.resolve();
    };

    signal.addEventListener('abort', abort, { once: true });

    /** ends a reviewer that never reported its own end, so a failed or stopped run leaves none running. */
    const finish = (name: string) => {
      const run = this.runs.get(this.expected.get(name)?.run ?? '');
      run?.end(signal.aborted ? 'stopped' : 'failed');

      return run;
    };

    try {
      const codes = await Promise.race([Promise.all(exits), missed.promise]);

      // a stop or the deadline ends this wait for output still in the pipe after the exit, since a descendant outside
      // the group can keep stderr open
      await beforeDeadline(
        Promise.race([Promise.all(drained), aborted.promise]),
        stopDeadline(),
      ).catch(() => {});

      if (stopping) await stopping;

      if (failures.length) throw failures[0];

      return await Promise.all(
        reviewers.map(async ({ name, reportFile }, index) => {
          const run = finish(name);
          let unread: string | undefined;

          const report = await readFile(reportFile, 'utf8').catch(
            (error: unknown) => {
              unread = errorMessage(error);

              return '';
            },
          );

          const diagnosis = [
            diagnostics[index]!.trim(),
            killed[index] && `killed by ${killed[index]}`,
            unread,
          ]
            .filter(Boolean)
            .join('\n');

          return {
            code: codes[index]!,
            ...(diagnosis ? { diagnostics: diagnosis } : {}),
            ...(run
              ? {
                  status: run.subagent.status,
                  ...(run.subagent.model ? { model: run.subagent.model } : {}),
                }
              : {}),
            report,
          };
        }),
      );
    } finally {
      signal.removeEventListener('abort', abort);

      for (const { name } of reviewers) {
        finish(name);
        const run = this.expected.get(name)?.run;

        if (run) this.runs.delete(run);

        this.expected.delete(name);
      }
    }
  }
}

/** signals a group Witch still watches and forgets it once it has no member, since an empty group's id can be reused. */
function signalLive(
  live: Set<number>,
  group: number,
  signal: NodeJS.Signals | 0,
): boolean {
  if (signalGroup(group, signal)) return true;

  live.delete(group);

  return false;
}

/** stops the groups the way `terminateChild` stops a native child, rejecting when one outlives the deadline. */
async function stopGroups(live: Set<number>, deadline: number) {
  for (const group of live) signalLive(live, group, 'SIGTERM');

  try {
    await beforeDeadline(gone(live, live, deadline), graceDeadline(deadline));

    return;
  } catch (error) {
    if (!(error instanceof NativeStopTimeout)) throw error;
  }

  for (const group of live) signalLive(live, group, 'SIGKILL');

  await beforeDeadline(gone(live, live, deadline), deadline);
}

/** resolves once none of `groups` is left in `live` or an abort's stop takes over the wait, rejecting when one still has a member at the deadline. */
async function gone(
  live: Set<number>,
  groups: Iterable<number>,
  deadline: number,
  signal?: AbortSignal,
): Promise<void> {
  const watched = [...groups];

  // every group is probed on each pass, so one with members doesn't hide another that emptied
  while (
    !signal?.aborted &&
    watched.filter((group) => live.has(group) && signalLive(live, group, 0))
      .length
  ) {
    if (performance.now() >= deadline) throw new NativeStopTimeout();

    await delay(25);
  }
}
