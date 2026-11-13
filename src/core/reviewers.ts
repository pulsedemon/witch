import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  FamiliarAction,
  FamiliarOutcome,
} from '../agents/familiar-report.js';
import { FamiliarRun } from '../agents/familiar-requests.js';
import {
  beforeDeadline,
  graceDeadline,
  NativeStop,
  NativeStopTimeout,
  signalGroup,
  stopDeadline,
} from '../agents/shutdown.js';
import { errorMessage } from '../errors.js';
import type { AgentEvent, TaskStatus } from '../agents/types.js';

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
      if (expected.run === action.run) return { kind: 'familiar-registered' };
      if (expected.run)
        throw new Error('This reviewer has already registered.');
      expected.run = action.run;
      this.runs.set(
        action.run,
        new FamiliarRun(action, (event) => {
          if (event.type === 'subagent') this.publish(event);
        }),
      );
      return { kind: 'familiar-registered' };
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
    const groups: number[] = [];
    const diagnostics = reviewers.map(() => '');
    // kept apart from stderr, which can still arrive after the exit
    const killed: (NodeJS.Signals | null)[] = reviewers.map(() => null);
    const exits = reviewers.map(
      ({ command }, index) =>
        new Promise<number | null>((resolve) => {
          const child = spawn('/bin/sh', ['-c', command], {
            cwd,
            detached: true,
            stdio: ['ignore', 'ignore', 'pipe'],
          });
          if (child.pid) groups.push(child.pid);
          child.stderr.setEncoding('utf8');
          child.stderr.on('data', (chunk: string) => {
            diagnostics[index] = (diagnostics[index] + chunk).slice(-2000);
          });
          child.once('error', (error) => {
            diagnostics[index] = error.message;
            resolve(null);
          });
          child.once('exit', (code, ended) => {
            killed[index] = ended;
            resolve(code);
          });
        }),
    );
    let stopping: Promise<void> | undefined;
    // a stop that misses its deadline ends the run even while a command still hasn't exited
    const missed = Promise.withResolvers<never>();
    const abort = () => {
      stopping ??= stopGroups(
        groups,
        signal.reason instanceof NativeStop
          ? stopDeadline(signal.reason.options.deadline)
          : stopDeadline(),
      );
      stopping.catch(missed.reject);
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
      // a wrapper killed outright leaves its native CLI in the group. after an abort the stop owns escalation, since a
      // shell that forked its command exits on SIGTERM while the command still has its grace period
      if (!stopping) {
        for (const group of groups) signalGroup(group, 'SIGKILL');
        const deadline = stopDeadline();
        await beforeDeadline(gone(groups, deadline, signal), deadline);
      }
      if (stopping) await stopping;
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

/** stops the groups the way `terminateChild` stops a native child, rejecting when one outlives the deadline. */
async function stopGroups(groups: readonly number[], deadline: number) {
  for (const group of groups) signalGroup(group, 'SIGTERM');
  try {
    await beforeDeadline(gone(groups, deadline), graceDeadline(deadline));
    return;
  } catch (error) {
    if (!(error instanceof NativeStopTimeout)) throw error;
  }
  for (const group of groups) signalGroup(group, 'SIGKILL');
  await beforeDeadline(gone(groups, deadline), deadline);
}

/** resolves once no group has a member or an abort's stop takes over the wait, rejecting when one still has a member at the deadline. */
async function gone(
  groups: readonly number[],
  deadline: number,
  signal?: AbortSignal,
): Promise<void> {
  while (!signal?.aborted && groups.some((group) => signalGroup(group, 0))) {
    if (performance.now() >= deadline) throw new NativeStopTimeout();
    await delay(25);
  }
}
