import type { CoordinationStore } from '../../persistence/coordination.js';
import type { TaskClaim } from './coordination-state.js';
import type { SessionCoordination } from './coordination.js';
import { mergeEventId, mergeNotices } from '../repository/merge-events.js';
import type { MergeEvent } from '../repository/merge-events.js';
import { answerable, answered, peerRequestNotices } from './peer-requests.js';
import type { PeerRequest } from './peer-requests.js';
import { pauseNotices } from './pauses.js';
import type { Pause } from './pauses.js';
import type { PullRequest } from '../repository/pull-requests.js';
import type { Snapshot } from '../snapshot.js';
import type { DisplayUpdate } from '../state.js';

interface EventScope {
  conversation: string;
  project: string;
}

type Source = 'merge-events' | 'peer-requests' | 'pauses' | 'merge-publish';

interface EventHost {
  /** the active conversation and its project. */
  scope(): EventScope | undefined;

  claims(): readonly TaskClaim[];

  fail(source: Source, error: unknown): void;

  /** the named sources succeeded; `notify` when listeners should hear of it. */
  read(sources: readonly Source[], notify: boolean): void;
}

interface MergePublication {
  closed(): boolean;

  serialize(work: () => Promise<void>): Promise<void>;

  /** the open conversations in `project`, read after `source` rereads its own project. */
  recipients(project: string, source: string): Promise<string[]>;

  refresh(): Promise<void>;
}

interface MergeObservation {
  project: string;
  source: string;
  pullRequest: PullRequest;
  recipients?: string[];
}

function same(a: EventScope | undefined, b: EventScope | undefined): boolean {
  return a?.conversation === b?.conversation && a?.project === b?.project;
}

/** the active conversation's merge events, peer requests and pauses, from one guarded read. */
export class ConversationEvents {
  private merges?: EventScope & { events: MergeEvent[] };
  private asks?: EventScope & { requests: PeerRequest[] };
  private halts?: EventScope & { pauses: Pause[] };
  private reading?: { key: object; scope: EventScope; promise: Promise<void> };
  private readonly pendingMerges = new Map<string, MergeObservation>();
  private readonly observedMerges = new Set<string>();
  private publishing?: Promise<void>;

  constructor(
    private readonly registry: CoordinationStore,
    private readonly host: EventHost,
    private readonly publication: MergePublication,
  ) {}

  /** records each merge once per process; each tick retries one not yet recorded. */
  observeMerge(project: string, source: string, pullRequest: PullRequest) {
    const id = mergeEventId(project, pullRequest);

    if (this.observedMerges.has(id)) return;

    if (!this.pendingMerges.has(id))
      this.pendingMerges.set(id, { project, source, pullRequest });

    void this.publishMerges();
  }

  publishMerges(): Promise<void> {
    if (this.publication.closed() || !this.pendingMerges.size)
      return Promise.resolve();

    this.publishing ??= this.publication
      .serialize(async () => {
        for (const [id, observation] of this.pendingMerges) {
          const { project, source, pullRequest } = observation;

          observation.recipients ??= await this.publication.recipients(
            project,
            source,
          );

          await this.registry.recordMerge(
            project,
            pullRequest,
            source,
            observation.recipients,
          );

          this.pendingMerges.delete(id);
          this.observedMerges.add(id);
        }

        this.host.read(['merge-publish'], false);
        await this.publication.refresh();
      })
      .catch((error: unknown) => this.host.fail('merge-publish', error))
      .finally(() => {
        this.publishing = undefined;
      });

    return this.publishing;
  }

  get pending(): Promise<void> | undefined {
    return this.reading?.promise;
  }

  /** the conversation's scope while it is active. */
  private scope(conversation: string): EventScope | undefined {
    const scope = this.host.scope();

    return scope?.conversation === conversation ? scope : undefined;
  }

  mergeEvents(conversation: string): readonly MergeEvent[] {
    const scope = this.scope(conversation);

    return scope && same(this.merges, scope) ? this.merges!.events : [];
  }

  peerRequests(conversation: string): readonly PeerRequest[] {
    const scope = this.scope(conversation);

    return scope && same(this.asks, scope) ? this.asks!.requests : [];
  }

  /** the pauses the conversation issued or receives, across projects; undefined until a read for its scope lands. */
  pauses(conversation: string): readonly Pause[] | undefined {
    const scope = this.scope(conversation);

    return scope && same(this.halts, scope) ? this.halts!.pauses : undefined;
  }

  /** a new activation reads its pauses afresh, so automatic work waits for that read rather than trusting the old one. */
  forgetPauses(): void {
    this.halts = undefined;
  }

  /** the conversation's own requests that have answers. */
  answered(conversation: string): PeerRequest[] {
    return answered(this.peerRequests(conversation), conversation);
  }

  /** the ids of the requests this conversation can answer. */
  answerable(conversation: string): string[] {
    const scope = this.scope(conversation);

    return scope
      ? answerable(
          this.peerRequests(conversation),
          conversation,
          scope.project,
          this.host.claims(),
        ).map(({ id }) => id)
      : [];
  }

  /** records requests a transaction read, such as an answer turn's admission. */
  recordRequests(scope: EventScope, requests: PeerRequest[]): void {
    this.asks = { ...scope, requests };
  }

  /** answerable requests renotify, so a missed admission retries. `key` identifies the activation `current` checks. */
  refresh(
    key: object,
    scope: EventScope,
    current: () => boolean,
  ): Promise<void> {
    if (this.reading)
      return this.reading.key === key && same(this.reading.scope, scope)
        ? this.reading.promise
        : this.reading.promise.then(() =>
            current() ? this.refresh(key, scope, current) : undefined,
          );

    const { conversation, project } = scope;

    const promise = Promise.allSettled([
      this.registry.mergeEvents(project, conversation),
      this.registry.peerRequests(project, conversation),
      this.registry.pauses(conversation),
    ])
      .then(([events, requests, pauses]) => {
        if (!current()) return;

        const read: Source[] = [];
        let changed = false;

        if (events.status === 'fulfilled') {
          const merges = { ...scope, events: events.value };
          changed = JSON.stringify(merges) !== JSON.stringify(this.merges);
          this.merges = merges;
          read.push('merge-events');
        } else this.host.fail('merge-events', events.reason);

        if (requests.status === 'fulfilled') {
          const asks = { ...scope, requests: requests.value };
          changed ||= JSON.stringify(asks) !== JSON.stringify(this.asks);
          this.asks = asks;
          read.push('peer-requests');
        } else this.host.fail('peer-requests', requests.reason);

        if (pauses.status === 'fulfilled') {
          const halts = { ...scope, pauses: pauses.value };
          changed ||= JSON.stringify(halts) !== JSON.stringify(this.halts);
          this.halts = halts;
          read.push('pauses');
        } else this.host.fail('pauses', pauses.reason);

        this.host.read(
          read,
          changed ||
            (requests.status === 'fulfilled' &&
              this.answerable(conversation).length > 0),
        );
      })
      .finally(() => {
        this.reading = undefined;
      });

    this.reading = { key, scope, promise };

    return promise;
  }
}

/** shows each merge, peer request and pause notice the open conversation hasn't shown yet. */
export function watchEventNotices(
  coordination: SessionCoordination | undefined,
  snapshot: () => Pick<Snapshot, 'conversation' | 'items'>,
  show: (notice: DisplayUpdate) => void,
): void {
  coordination?.subscribe(() => {
    const { conversation, items } = snapshot();

    if (!conversation) return;

    const { events } = coordination;
    const shown = new Set(items.map(({ id }) => id));

    for (const notice of [
      ...mergeNotices(events.mergeEvents(conversation.id)),
      ...peerRequestNotices(
        events.peerRequests(conversation.id),
        conversation.id,
      ),
      ...pauseNotices(events.pauses(conversation.id) ?? [], conversation.id),
    ])
      if (!shown.has(notice.id))
        show({
          ...notice,
          kind: 'notice',
          cwd: conversation.cwd,
          replace: true,
        });
  });
}
