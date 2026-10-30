import type { CoordinationStore } from '../persistence/coordination.js';
import type { TaskClaim } from './coordination-state.js';
import { mergeEventId } from './merge-events.js';
import type { MergeEvent } from './merge-events.js';
import { answerable, answered } from './peer-requests.js';
import type { PeerRequest } from './peer-requests.js';
import type { PullRequest } from './repository.js';

export interface EventScope {
  conversation: string;
  project: string;
}

export interface EventHost {
  /** the active conversation and its project. */
  scope(): EventScope | undefined;
  claims(): readonly TaskClaim[];
  fail(
    source: 'merge-events' | 'peer-requests' | 'merge-publish',
    error: unknown,
  ): void;
  /** the named sources succeeded; `notify` when listeners should hear of it. */
  read(sources: readonly string[], notify: boolean): void;
}

export interface MergePublication {
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

/** the active conversation's merge events and peer requests, from one guarded read. */
export class ConversationEvents {
  private merges?: EventScope & { events: MergeEvent[] };
  private asks?: EventScope & { requests: PeerRequest[] };
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

  /** the conversation's own requests that have answers. */
  answered(conversation: string): PeerRequest[] {
    return answered(this.peerRequests(conversation), conversation);
  }

  answerable(conversation: string): number {
    const scope = this.scope(conversation);
    return scope
      ? answerable(
          this.peerRequests(conversation),
          conversation,
          scope.project,
          this.host.claims(),
        ).length
      : 0;
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
    ])
      .then(([events, requests]) => {
        if (!current()) return;
        const read: string[] = [];
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
        this.host.read(
          read,
          changed ||
            (requests.status === 'fulfilled' &&
              !!this.answerable(conversation)),
        );
      })
      .finally(() => {
        this.reading = undefined;
      });
    this.reading = { key, scope, promise };
    return promise;
  }
}
