import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { running } from '../agents/shutdown.js';
import { errorMessage } from '../errors.js';
import { witchWorking } from './coordination-state.js';
import type { Coordinator } from './coordinator.js';
import type { JobWatch } from './jobs.js';
import type { Conversation } from './state.js';

export interface WakeOptions {
  platform?: NodeJS.Platform;
  /** the process whose exit ends the hold. */
  pid?: number;
  launch?: (pid: number) => ChildProcess;
}

const caffeinate = (pid: number) =>
  spawn('/usr/bin/caffeinate', ['-i', '-w', String(pid)], {
    stdio: 'ignore',
    // its own session, so a hangup that reaches Witch's process group leaves the holder for `-w` to end
    detached: true,
  });

/**
 * keeps macOS from idle sleeping while Witch has started something that is still going, a job included, through one
 * `caffeinate` per instance. `-w` ends the hold with Witch's pid, however Witch dies. a hold that ends on its own is
 * not replaced: `failed` hears it then, and again when a conversation loads without its notice.
 */
export function keepAwake(
  coordinator: Pick<Coordinator, 'snapshot' | 'subscribe'>,
  jobs: Pick<JobWatch, 'live' | 'subscribe'>,
  failed: (error: Error) => void,
  {
    platform = process.platform,
    pid = process.pid,
    launch = caffeinate,
  }: WakeOptions = {},
): () => void {
  if (platform !== 'darwin') return () => {};

  let holder: ChildProcess | undefined;
  let working = false;
  let closing = false;
  let lost: Error | undefined;
  let reported: Conversation | undefined;

  const release = () => {
    const retiring = holder;

    holder = undefined;

    // a child whose spawn failed has no pid until its error arrives, so a kill before then has no valid target
    if (retiring && running(retiring)) retiring.kill();
  };

  const lose = (reason: string, options?: ErrorOptions) => {
    holder = undefined;

    lost = new Error(
      `Witch can't keep the Mac awake until it restarts: ${reason}`,
      options,
    );

    reported = coordinator.snapshot.conversation;

    failed(lost);
  };

  const hold = () => {
    let child: ChildProcess;

    try {
      child = launch(pid);
    } catch (error) {
      lose(errorMessage(error), { cause: error });

      return;
    }

    holder = child;

    child.unref();

    child.once('error', (error) => {
      if (holder === child) lose(errorMessage(error), { cause: error });
    });

    child.once('exit', (code, signal) => {
      if (holder === child)
        lose(
          signal
            ? `caffeinate was stopped by ${signal}`
            : `caffeinate exited with code ${code}`,
        );
    });
  };

  // `failed` publishes a notice, which runs this again before it returns, so every branch updates its state first
  const update = () => {
    if (lost) {
      const { conversation } = coordinator.snapshot;

      if (conversation === reported) return;

      reported = conversation;

      if (
        coordinator.snapshot.items.some(
          ({ kind, text }) => kind === 'notice' && text === lost!.message,
        )
      )
        return;

      failed(lost);

      return;
    }

    // a failure reported during close replaces the phase, and the hold lasts until the process exits
    closing ||= coordinator.snapshot.phase === 'closing';

    const next =
      closing ||
      witchWorking(coordinator.snapshot) ||
      !!coordinator.snapshot.automatic ||
      jobs.live;

    if (next === working) return;

    working = next;

    if (working) hold();
    else release();
  };

  const unsubscribe = coordinator.subscribe(update);
  const unsubscribeJobs = jobs.subscribe(update);

  update();

  return () => {
    unsubscribe();

    unsubscribeJobs();

    release();
  };
}
