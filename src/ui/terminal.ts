import type { SessionCoordination } from '../core/coordination.js';
import type { Coordinator, Snapshot } from '../core/coordinator.js';
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

/** cancellation writes nothing, so a failed stdout cannot force a second shutdown. */
export function watchTerminal(
  coordinator: Pick<Coordinator, 'snapshot' | 'subscribe'>,
  coordination: Pick<SessionCoordination, 'snapshot' | 'subscribe'> | undefined,
  write: (data: string) => void,
): () => void {
  let stopped = false;
  let title = '';
  let task = '';
  let active: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const notify = (reason: string) =>
    write(
      `\u001b]777;notify;Witch;${bounded(`${reason}: ${task}`)}\u001b\\\u0007`,
    );

  function update() {
    if (stopped) return;
    const snapshot = coordinator.snapshot;
    if (snapshot.phase === 'closing') {
      stop();
      return;
    }
    const conversation = snapshot.conversation;
    const claim = coordination?.snapshot.ownClaim;
    task =
      oneLine(
        (claim?.owner.conversation === conversation?.id
          ? claim?.summary
          : conversation?.title) ?? '',
      ).trim() || 'New conversation';
    const status = snapshot.requests.length ? 'waiting' : snapshot.phase;
    const next = bounded(
      `Witch | ${status}${conversation ? ` | ${task}` : ''}`,
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
        notify(wait.reason);
        timer = setInterval(() => notify(wait.reason), 15_000);
        timer.unref();
      }
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
  }
  update();
  return stop;
}
