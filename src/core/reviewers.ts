import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  FamiliarAction,
  FamiliarOutcome,
} from '../agents/familiar-report.js';
import {
  beforeDeadline,
  killWaitMs,
  NativeStop,
  NativeStopTimeout,
  stopDeadline,
  terminateGraceMs,
} from '../agents/shutdown.js';
import type { AgentEvent, Subagent, TaskStatus } from '../agents/types.js';

export interface Reviewer {
  name: string;
  runtime: string;
  /** the familiar wrapper's shell command, which reads its brief on stdin. */
  command: string;
  reportFile: string;
}

export interface ReviewerResult {
  name: string;
  /** the command's exit code; null when it was signalled or never ran. */
  code: number | null;
  /** the familiar's last status, absent when it never registered. */
  status?: TaskStatus;
  model?: string;
  report: string;
}

interface Run {
  subagent: Subagent;
  sequence: number;
}

/**
 * familiars Witch launches itself, outside any native session. the familiar mailbox asks `report` before the live
 * session, so a registration whose name Witch expects is admitted here instead of needing a native command's marker.
 */
export class Reviewers {
  /** reviewer names awaiting or holding a registration, with the run that registered. */
  private readonly expected = new Map<string, { run?: string }>();
  private readonly runs = new Map<string, Run>();

  constructor(
    private readonly publish: (
      event: Extract<AgentEvent, { type: 'subagent' }>,
    ) => void,
  ) {}

  /** whether a familiar entry belongs to a Witch-launched reviewer, so native session shutdown leaves it alone. */
  owns(id: string): boolean {
    return [...this.runs.values()].some(({ subagent }) => subagent.id === id);
  }

  /** the reply to a familiar action this registry owns, or undefined for one the live session should handle. */
  report(action: FamiliarAction): FamiliarOutcome | undefined {
    if (action.kind === 'familiar-register') {
      const expected = this.expected.get(action.name);
      if (!expected) return;
      if (expected.run === action.run) return { kind: 'familiar-registered' };
      if (expected.run)
        throw new Error('This reviewer has already registered.');
      expected.run = action.run;
      const subagent: Subagent = {
        id: `${action.runtime}-familiar/${action.run}`,
        run: action.run,
        name: action.name,
        kind: '',
        runtime: action.runtime,
        status: 'running',
        tools: 0,
      };
      this.runs.set(action.run, { subagent, sequence: -1 });
      this.publish({ type: 'subagent', subagent });
      return { kind: 'familiar-registered' };
    }
    const run = this.runs.get(action.run);
    if (!run) return;
    if (action.kind !== 'familiar-update')
      throw new Error(
        'A reviewer Witch launched runs read-only and cannot ask for anything.',
      );
    // the wrapper retries an update under its sequence, so an older or repeated one changes nothing
    if (action.sequence <= run.sequence) return { kind: 'familiar-updated' };
    if (run.subagent.status !== 'running')
      throw new Error('The familiar run has already ended.');
    run.sequence = action.sequence;
    run.subagent = { ...run.subagent, ...action.progress };
    this.publish({ type: 'subagent', subagent: run.subagent });
    return { kind: 'familiar-updated' };
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
      return reviewers.map(({ name }) => ({ name, code: null, report: '' }));
    for (const { name } of reviewers) this.expected.set(name, {});
    const groups: number[] = [];
    const exits = reviewers.map(
      ({ command }) =>
        new Promise<number | null>((resolve) => {
          const child = spawn('/bin/sh', ['-c', command], {
            cwd,
            detached: true,
            stdio: 'ignore',
          });
          if (child.pid) groups.push(child.pid);
          child.once('error', () => resolve(null));
          child.once('exit', (code) => resolve(code));
        }),
    );
    let stopping: Promise<void> | undefined;
    const abort = () => {
      stopping ??= stopGroups(
        groups,
        signal.reason instanceof NativeStop
          ? stopDeadline(signal.reason.options.deadline)
          : stopDeadline(),
      );
      // awaited below once the commands exit; this keeps an early failure from going unhandled meanwhile
      stopping.catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const codes = await Promise.all(exits);
      // a wrapper killed outright leaves its native CLI in the group
      for (const group of groups) signalGroup(group, 'SIGKILL');
      if (stopping) await stopping;
      else {
        const deadline = stopDeadline();
        await beforeDeadline(gone(groups, deadline), deadline);
      }
      return await Promise.all(
        reviewers.map(async ({ name, reportFile }, index) => {
          const run = this.runs.get(this.expected.get(name)?.run ?? '');
          if (run?.subagent.status === 'running') {
            run.subagent = {
              ...run.subagent,
              status: signal.aborted ? 'stopped' : 'failed',
            };
            this.publish({ type: 'subagent', subagent: run.subagent });
          }
          return {
            name,
            code: codes[index]!,
            ...(run
              ? {
                  status: run.subagent.status,
                  ...(run.subagent.model ? { model: run.subagent.model } : {}),
                }
              : {}),
            report: await readFile(reportFile, 'utf8').catch(() => ''),
          };
        }),
      );
    } finally {
      signal.removeEventListener('abort', abort);
      for (const { name } of reviewers) {
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
    await beforeDeadline(
      gone(groups, deadline),
      Math.min(deadline - killWaitMs, performance.now() + terminateGraceMs),
    );
    return;
  } catch (error) {
    if (!(error instanceof NativeStopTimeout)) throw error;
  }
  for (const group of groups) signalGroup(group, 'SIGKILL');
  await beforeDeadline(gone(groups, deadline), deadline);
}

function signalGroup(group: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-group, signal);
    return true;
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    // macOS can answer EPERM for a dying group that has no member left to signal
    if (code === 'ESRCH' || code === 'EPERM') return false;
    throw error;
  }
}

/** resolves once no group has a member, polling no later than the deadline. */
async function gone(
  groups: readonly number[],
  deadline: number,
): Promise<void> {
  while (
    groups.some((group) => signalGroup(group, 0)) &&
    performance.now() < deadline
  )
    await delay(25);
}
