import type { Coordinator } from './coordinator.js';
import type { Conflict, RepositoryWatch } from './repository.js';

export function conflictNotice(conflict: Conflict): string {
  const { number, url, commit, base } = conflict.pullRequest;
  return `Pull request conflict: [#${number}](${url}) at ${commit} conflicts with ${base}${conflict.baseTip ? `, observed at ${conflict.baseTip}` : ''}.`;
}

export function conflictContext(conflict: Conflict): string {
  const { number, url, commit, base } = conflict.pullRequest;
  return `Witch confirmed on GitHub that pull request #${number} (${url}) at head ${commit} conflicts with its base branch ${base}${conflict.baseTip ? `, whose tip was ${conflict.baseTip} when observed,` : ''} and hasn't confirmed a resolution since. Passing checks do not make it mergeable. This is informational, not a user request or authorization to change your task or checkout.`;
}

/**
 * the notice is unsaved, so a launch on a conflicted branch can't make its new conversation resumable. a failed status
 * read keeps the last conflict, and merges recorded before the first pull request read are already covered by it.
 */
export function watchConflicts(
  repository: Pick<
    RepositoryWatch,
    'snapshot' | 'subscribe' | 'refreshPullRequest'
  >,
  coordinator: Pick<
    Coordinator,
    'snapshot' | 'subscribe' | 'notice' | 'conflict' | 'coordination'
  >,
): () => void {
  let conflict: Conflict | undefined;
  let pending: NodeJS.Immediate | undefined;
  let stopped = false;
  const check = () => {
    pending = undefined;
    const status = repository.snapshot;
    if (status) conflict = status.conflict;
    coordinator.conflict = conflict;
    const { conversation, items } = coordinator.snapshot;
    if (!conflict || !conversation) return;
    const text = conflictNotice(conflict);
    if (!items.some((item) => item.kind === 'notice' && item.text === text))
      coordinator.notice(text, conversation.cwd, false);
  };
  const schedule = () => {
    if (!stopped) pending ??= setImmediate(check);
  };
  let seen: Set<string> | undefined;
  const coordination = coordinator.coordination;
  const merged = () => {
    const conversation = coordinator.snapshot.conversation;
    const request = repository.snapshot?.pullRequest;
    if (!coordination || !conversation || request?.state !== 'OPEN') return;
    const events = coordination.events.mergeEvents(conversation.id);
    const fresh = events.filter(({ id }) => !seen?.has(id));
    const first = !seen;
    seen ??= new Set();
    for (const { id } of fresh) seen.add(id);
    if (
      !first &&
      fresh.some(({ pullRequest }) => pullRequest.base === request.base)
    )
      repository.refreshPullRequest();
  };
  const stops = [
    repository.subscribe(schedule),
    coordinator.subscribe(schedule),
    ...(coordination ? [coordination.subscribe(merged)] : []),
  ];
  schedule();
  return () => {
    stopped = true;
    if (pending) clearImmediate(pending);
    for (const stop of stops) stop();
  };
}
