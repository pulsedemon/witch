import type { Coordinator } from '../coordinator.js';
import { changed } from './merged.js';
import type { MergeCleanup } from './merged.js';
import type { PullRequest, RepositoryWatch } from './repository.js';

/** what the watch holds for one merged pull request at one head commit. */
interface Merge {
  settled?: boolean;
  /** its cleanup runs now, or waits for a repository change or its retry timer */
  waiting?: boolean;
  timer?: NodeJS.Timeout;
  /** an interrupted cleanup, which resumes from its own progress */
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
 * other deferred cleanups retry after five seconds or a repository change. interrupted work survives checkout changes;
 * completed work, ordinary failures and interrupted work whose progress couldn't be confirmed aren't retried, and are
 * no longer followed.
 */
export function watchMerges(
  repository: Pick<RepositoryWatch, 'snapshot' | 'subscribe' | 'unfollow'>,
  coordinator: Pick<Coordinator, 'snapshot' | 'subscribe' | 'cleanUpMerge'>,
  install?: string,
): () => void {
  const merges = new Map<string, Merge>();
  let pending: NodeJS.Immediate | undefined;
  let stopped = false;
  const key = ({ url, commit }: PullRequest) => `${url}\n${commit}`;

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

    const { phase, error, queue } = coordinator.snapshot;

    if (
      (status && changed(status)) ||
      phase !== 'idle' ||
      error ||
      queue.length
    )
      return;

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

    const work = merge.continuation ?? {
      request: pullRequest,
      progress: {},
      owner,
    };

    const settle = () => {
      merge.continuation = undefined;
      merge.settled = true;
      repository.unfollow(pullRequest.url);
    };

    void coordinator.cleanUpMerge(pullRequest, install, work.progress).then(
      (acted) => {
        if (acted === 'interrupted') {
          merge.continuation = work;
          merge.waiting = false;
        } else if (acted === true) settle();
        // the status line's next change retries a changed checkout; a timer would fetch every 5 s while the two reads
        // disagree
        else if (acted === false && !stopped) {
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

    for (const { timer } of merges.values()) clearTimeout(timer);

    stops.forEach((stop) => stop());
  };
}
