import type { SessionCoordination } from '../core/coordination.js';
import type { Coordinator, Snapshot } from '../core/coordinator.js';
import type { NotificationSchedule } from '../persistence/notifications.js';
import { oneLine } from './links.js';

function bounded(text: string): string {
  if (Buffer.byteLength(text) <= 240) return text;
  let bytes = 3;
  let prefix = '';
  for (const point of text) {
    bytes += Buffer.byteLength(point);
    if (bytes > 240) break;
    prefix += point;
  }
  return `${prefix}…`;
}

function waiting(snapshot: Snapshot) {
  const conversation = snapshot.conversation?.id ?? '';
  const request = snapshot.requests[0];
  if (request)
    return {
      key: `${conversation}/request/${request.id}`,
      reason: {
        approval: 'Approval required',
        question: 'Answer needed',
        elicitation: 'Input required',
      }[request.kind],
    };
  if (snapshot.phase === 'recovery' || snapshot.phase === 'error')
    return {
      key: `${conversation}/${snapshot.phase}`,
      reason:
        snapshot.phase === 'recovery'
          ? 'Memory recovery required'
          : 'Restart required',
    };
  return undefined;
}

function settled(snapshot: Snapshot): boolean {
  return (
    snapshot.phase === 'idle' &&
    !snapshot.queue.length &&
    !snapshot.requests.length &&
    !snapshot.recovery &&
    !snapshot.error
  );
}

/** cancellation writes nothing, so a failed stdout cannot force a second shutdown. */
export function watchTerminal(
  coordinator: Pick<Coordinator, 'snapshot' | 'subscribe' | 'report'>,
  coordination: Pick<SessionCoordination, 'snapshot' | 'subscribe'> | undefined,
  write: (data: string) => void,
  schedule?: NotificationSchedule,
): () => void {
  let stopped = false;
  let title = '';
  let active: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let conversationId = coordinator.snapshot.conversation?.id;
  let delivered = coordinator.snapshot.completedTurn;
  let pending: ReturnType<typeof setImmediate> | undefined;
  let disabled = false;
  let desktop:
    | {
        reason: () => string | undefined;
        timer?: ReturnType<typeof setTimeout>;
      }
    | undefined;

  const message = (reason: string) =>
    `\u001b]777;notify;Witch;${bounded(`${reason}: ${taskName()}`)}\u001b\\`;

  function cancelDesktop() {
    clearTimeout(desktop?.timer);
    desktop = undefined;
  }

  function notify(reason: () => string | undefined) {
    const current = reason();
    if (current === undefined) return;
    if (!schedule) {
      write(`${message(current)}\u0007`);
      return;
    }
    write('\u0007');
    if (disabled || desktop) return;
    const alert = {
      reason,
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
    };
    desktop = alert;
    const attempt = () => {
      void schedule
        .attempt(() => {
          if (stopped || desktop !== alert) return undefined;
          const current = reason();
          return current === undefined ? undefined : message(current);
        }, write)
        .then((retry) => {
          if (desktop !== alert) return;
          if (retry === undefined) {
            desktop = undefined;
          } else {
            alert.timer = setTimeout(attempt, retry);
            alert.timer.unref();
          }
        })
        .catch((error: unknown) => {
          if (stopped || disabled) return;
          disabled = true;
          cancelDesktop();
          coordinator.report(error);
        });
    };
    attempt();
  }

  function taskName(): string {
    const conversation = coordinator.snapshot.conversation;
    const claim = coordination?.snapshot.ownClaim;
    return (
      oneLine(
        (claim?.owner.conversation === conversation?.id
          ? claim?.summary
          : conversation?.title) ?? '',
      ).trim() || 'New conversation'
    );
  }

  function update() {
    if (stopped) return;
    const snapshot = coordinator.snapshot;
    if (snapshot.phase === 'closing') {
      stop();
      return;
    }
    if (desktop && desktop.reason() === undefined) cancelDesktop();
    const conversation = snapshot.conversation;
    if (conversation?.id !== conversationId) {
      conversationId = conversation?.id;
      delivered = snapshot.completedTurn;
      clearImmediate(pending);
      pending = undefined;
      cancelDesktop();
    }
    const status = snapshot.requests.length ? 'waiting' : snapshot.phase;
    const next = bounded(
      `Witch | ${status}${conversation ? ` | ${taskName()}` : ''}`,
    );
    if (next !== title) {
      title = next;
      write(`\u001b]2;${title}\u001b\\`);
    }
    const wait = waiting(snapshot);
    if (wait?.key !== active) {
      clearInterval(timer);
      timer = undefined;
      active = wait?.key;
      if (wait) {
        const reason = () => {
          const current = waiting(coordinator.snapshot);
          return current?.key === wait.key ? current.reason : undefined;
        };
        notify(reason);
        timer = setInterval(() => notify(reason), 15_000);
        timer.unref();
      }
    }
    const completed = snapshot.completedTurn;
    if (
      snapshot.phase === 'recovery' ||
      snapshot.phase === 'error' ||
      snapshot.error
    )
      delivered = completed;
    if (!completed || completed === delivered || !settled(snapshot)) {
      clearImmediate(pending);
      pending = undefined;
    } else if (!pending) {
      const owner = conversationId;
      pending = setImmediate(() => {
        pending = undefined;
        const current = coordinator.snapshot;
        if (
          stopped ||
          current.conversation?.id !== owner ||
          current.completedTurn !== completed ||
          !settled(current)
        )
          return;
        delivered = completed;
        notify(() => {
          const current = coordinator.snapshot;
          return current.conversation?.id === owner &&
            current.completedTurn === completed &&
            settled(current)
            ? 'Turn complete'
            : undefined;
        });
      });
      pending.unref();
    }
  }

  const unsubscribe = coordinator.subscribe(update);
  const unsubscribeCoordination = coordination?.subscribe(update);
  function stop() {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    unsubscribeCoordination?.();
    clearInterval(timer);
    clearImmediate(pending);
    cancelDesktop();
  }
  update();
  return stop;
}
