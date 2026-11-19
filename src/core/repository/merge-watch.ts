import type { Coordinator } from '../coordinator.js';
import { changed } from './checkout-git.js';
import type { MergeCleanup } from './merged.js';
import type { PullRequest, Repository, RepositoryWatch } from './repository.js';

const changedState =
  "the checkout isn't in the state the cleanup needs, so it waits for a repository update";

/** what the watch holds for one merged pull request at one head commit. */
interface Merge {
  settled?: boolean;
  /** its cleanup runs now, or waits for a repository change or its retry timer */
  waiting?: boolean;
  timer?: NodeJS.Timeout;
  /** an attempt is in flight; `waiting` alone doesn't say so, since a repository publish clears it mid-attempt */
  running?: boolean;
  /** why this merge is held and for whom. `due` once it has been held 15 s */
  held?: {
    reason: string;
    owner: string;
    due?: boolean;
    timer: NodeJS.Timeout;
  };
  /** consecutive deferred attempts that gave a reason, whatever the reasons */
  deferrals?: number;
  /** reasons already posted */
  told?: Set<string>;
  /** cleanup progress retained across retry or interruption */
  continuation?: {
    request: PullRequest;
    progress: MergeCleanup;
    owner?: string;
  };
}

/**
 * cleans up a merged branch while its checkout is clean and the conversation is idle without errors or queued prompts:
 * the checked-out branch's own pull request, and those the repository watch follows for branches the checkout left,
 * each with its own wait, retry and progress. a cleanup that found the checkout changed waits for a repository change,
 * other deferred cleanups retry after five seconds or a repository change. interrupted and retryable work keeps its
 * progress across checkout changes; completed work, ordinary failures and interrupted work whose progress couldn't be
 * confirmed aren't retried or followed. a merge held back for 15 s, or deferred three times running, says why in the
 * transcript, once per reason.
 */
export function watchMerges(
  repository: Pick<RepositoryWatch, 'snapshot' | 'subscribe' | 'unfollow'>,
  coordinator: Pick<
    Coordinator,
    'snapshot' | 'subscribe' | 'cleanUpMerge' | 'notice'
  >,
  install?: string,
): () => void {
  const merges = new Map<string, Merge>();
  let pending: NodeJS.Immediate | undefined;
  let stopped = false;
  const key = ({ url, commit }: PullRequest) => `${url}\n${commit}`;

  /** a notice can't be saved before a conversation opens or while its files open or close. */
  const unsaveable = () => {
    const { conversation, phase } = coordinator.snapshot;

    return !conversation || phase === 'starting' || phase === 'closing';
  };

  /** what keeps a merged pull request's cleanup from starting now, or nothing. */
  const gate = (status: Repository | undefined) => {
    const { phase, error, queue } = coordinator.snapshot;

    // the notice ends every reason with its own period
    if (error)
      return `an error is showing: ${error.trim().replace(/\s+/g, ' ').replace(/\.$/, '')}`;

    if (phase !== 'idle') return `the conversation's phase is ${phase}`;

    if (queue.length) return 'a prompt is queued';

    if (status && changed(status))
      return 'the checkout has uncommitted changes';

    return undefined;
  };

  const tell = (merge: Merge, { number }: PullRequest, reason: string) => {
    if (stopped || unsaveable() || merge.told?.has(reason)) return;

    (merge.told ??= new Set()).add(reason);

    coordinator.notice(
      `#${number} merged, but its cleanup is waiting: ${reason}.`,
    );
  };

  const release = (merge: Merge) => {
    clearTimeout(merge.held?.timer);
    merge.held = undefined;
  };

  /** one continuous hold keeps its 15 s across changing reasons. check posts, against the state it reads then. */
  const hold = (merge: Merge, reason: string) => {
    const owner = coordinator.snapshot.conversation?.id;

    if (stopped || !owner) return;

    if (merge.held) {
      merge.held.reason = reason;

      return;
    }

    const held: NonNullable<Merge['held']> = {
      reason,
      owner,
      timer: setTimeout(() => {
        held.due = true;
        schedule();
      }, 15_000),
    };

    held.timer.unref();
    merge.held = held;
  };

  const check = () => {
    pending = undefined;
    const status = repository.snapshot;
    const owner = coordinator.snapshot.conversation?.id;
    const candidates = new Map<string, PullRequest>();

    const add = (pullRequest: PullRequest) => {
      if (!candidates.has(key(pullRequest)))
        candidates.set(key(pullRequest), pullRequest);
    };

    for (const merge of merges.values()) {
      if (merge.continuation && merge.continuation.owner !== owner)
        merge.continuation = undefined;

      if (merge.continuation) add(merge.continuation.request);
    }

    if (status?.pullRequest && status.branch === status.pullRequest.branch)
      add(status.pullRequest);

    for (const followed of status?.followed ?? [])
      // the watch follows a merged pull request again after its own cleanup's switch
      if (merges.get(key(followed))?.settled) repository.unfollow(followed.url);
      else add(followed);

    const due = (candidate: PullRequest) =>
      candidate.state === 'MERGED' && !merges.get(key(candidate))?.settled;

    const reason = gate(status);

    for (const [id, merge] of merges) {
      if (!merge.held) continue;

      const candidate = candidates.get(id);

      if (!candidate || !due(candidate)) release(merge);
      else if (merge.held.owner !== owner) {
        // a wait that outlives a conversation switch restarts its 15 s for the one now open. a reason already said isn't repeated
        const kept = merge.held.reason;
        release(merge);
        hold(merge, kept);
      }
    }

    for (const candidate of candidates.values()) {
      if (!due(candidate)) continue;

      let merge = merges.get(key(candidate));

      if (merge?.waiting || merge?.running) continue;

      if (reason && !unsaveable()) {
        if (!merge) merges.set(key(candidate), (merge = {}));

        hold(merge, reason);
      } else if (merge) release(merge);
    }

    for (const [id, merge] of merges)
      if (merge.held?.due) tell(merge, candidates.get(id)!, merge.held.reason);

    if (reason) return;

    const pullRequest = [...candidates.values()].find((candidate) => {
      const merge = merges.get(key(candidate));

      return candidate.state === 'MERGED' && !merge?.settled && !merge?.waiting;
    });

    if (!pullRequest) return;

    const merge = merges.get(key(pullRequest)) ?? {};
    merges.set(key(pullRequest), merge);
    clearTimeout(merge.timer);
    merge.timer = undefined;
    merge.waiting = true;
    merge.running = true;

    const work = merge.continuation ?? {
      request: pullRequest,
      progress: {},
      owner,
    };

    const ended = () => {
      merge.running = false;
      merge.deferrals = undefined;
      release(merge);
    };

    const settle = () => {
      ended();
      merge.continuation = undefined;
      merge.settled = true;
      repository.unfollow(pullRequest.url);
    };

    /** a deferred attempt says why from the third in a row on. */
    const deferred = (why: string | undefined) => {
      merge.running = false;

      if (!why) return;

      merge.deferrals = (merge.deferrals ?? 0) + 1;

      if (merge.deferrals >= 3) tell(merge, pullRequest, why);
    };

    void coordinator.cleanUpMerge(pullRequest, install, work.progress).then(
      (acted) => {
        if (acted === 'interrupted') {
          ended();
          merge.continuation = work;
          merge.waiting = false;
        } else if (acted === 'retry') {
          merge.continuation = work;
          deferred(work.progress.deferred);
        } else if (acted === true) settle();
        else if (acted === 'changed') {
          deferred(changedState);
          hold(merge, changedState);
        } else deferred(work.progress.deferred);

        if ((acted === false || acted === 'retry') && !stopped) {
          // only for a deferred cleanup. a changed checkout waits for the status line's next change, since a timer would
          // fetch every 5 s while the two reads disagree
          merge.timer = setTimeout(() => {
            merge.timer = undefined;
            merge.waiting = false;
            schedule();
          }, 5000);

          merge.timer.unref();
        }

        // another pull request may be due, and a repository change during the run already ended this one's wait
        schedule();
      },
      // a failed cleanup shows its error; operate can't refuse, since the phase was checked this tick
      () => {
        settle();
        schedule();
      },
    );
  };

  // after the publish that called it: a turn's end settles its queue and error after publishing idle
  const schedule = () => {
    if (!stopped) pending ??= setImmediate(check);
  };

  const retry = () => {
    for (const merge of merges.values()) {
      // ends a wait for this update. a gate's hold keeps its timer, so updates during one long turn don't postpone it
      if (merge.waiting && !merge.running) release(merge);

      clearTimeout(merge.timer);
      merge.timer = undefined;
      merge.waiting = false;
    }

    schedule();
  };

  const stops = [repository.subscribe(retry), coordinator.subscribe(schedule)];
  schedule();

  return () => {
    stopped = true;
    clearImmediate(pending);

    for (const { timer, held } of merges.values()) {
      clearTimeout(timer);
      clearTimeout(held?.timer);
    }

    stops.forEach((stop) => stop());
  };
}
