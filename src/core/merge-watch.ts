import type { Coordinator } from './coordinator.js';
import { changed } from './merged.js';
import type { MergeCleanup } from './merged.js';
import type { PullRequest, RepositoryWatch } from './repository.js';

/**
 * cleans up a merged branch while its checkout is clean and the conversation is idle without errors or queued prompts.
 * a cleanup that found the checkout changed waits for a repository change, other deferred cleanups retry after five
 * seconds or a repository change. interrupted work survives checkout changes; completed work, ordinary failures and
 * interrupted work whose progress couldn't be confirmed aren't retried.
 */
export function watchMerges(
  repository: Pick<RepositoryWatch, 'snapshot' | 'subscribe'>,
  coordinator: Pick<Coordinator, 'snapshot' | 'subscribe' | 'cleanUpMerge'>,
  install?: string,
): () => void {
  const settled = new Set<string>();
  let attempted: string | undefined;
  let pending: NodeJS.Immediate | undefined;
  let retryTimer: NodeJS.Timeout | undefined;
  let stopped = false;

  let continuation:
    | { request: PullRequest; progress: MergeCleanup; owner?: string }
    | undefined;

  const check = () => {
    pending = undefined;
    const status = repository.snapshot;
    const owner = coordinator.snapshot.conversation?.id;

    if (continuation && continuation.owner !== owner) continuation = undefined;

    const pullRequest = continuation?.request ?? status?.pullRequest;
    const { phase, error, queue } = coordinator.snapshot;

    if (
      pullRequest?.state !== 'MERGED' ||
      (!continuation && status!.branch !== pullRequest.branch) ||
      (status && changed(status)) ||
      phase !== 'idle' ||
      error ||
      queue.length ||
      settled.has(pullRequest.commit) ||
      attempted === pullRequest.commit
    )
      return;

    clearTimeout(retryTimer);

    retryTimer = undefined;
    attempted = pullRequest.commit;
    const work = continuation ?? { request: pullRequest, progress: {}, owner };

    void coordinator.cleanUpMerge(pullRequest, install, work.progress).then(
      (acted) => {
        if (acted === 'interrupted') {
          continuation = work;
          attempted = undefined;

          schedule();

          return;
        }

        // the status line's next change retries it; a timer would fetch every 5 s while the two reads disagree
        if (acted === 'changed') return;

        if (acted) {
          continuation = undefined;

          settled.add(pullRequest.commit);
        } else if (!stopped) {
          retryTimer = setTimeout(retry, 5000);

          retryTimer.unref();
        }
      },
      // a failed cleanup shows its error; operate can't refuse, since the phase was checked this tick
      () => {
        continuation = undefined;

        settled.add(pullRequest.commit);
      },
    );
  };

  // after the publish that called it: a turn's end settles its queue and error after publishing idle
  const schedule = () => {
    if (!stopped) pending ??= setImmediate(check);
  };

  const retry = () => {
    clearTimeout(retryTimer);

    retryTimer = undefined;
    attempted = undefined;

    schedule();
  };

  const stops = [repository.subscribe(retry), coordinator.subscribe(schedule)];

  schedule();

  return () => {
    stopped = true;

    clearImmediate(pending);

    clearTimeout(retryTimer);

    stops.forEach((stop) => stop());
  };
}
