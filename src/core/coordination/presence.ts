import type { CoordinationStore } from '../../persistence/coordination.js';
import type { Activation } from './coordination.js';
import { taskActivity, type SessionPresence } from './coordination-state.js';
import type { Snapshot } from '../snapshot.js';
import type { ProcessIdentity } from '../state.js';

interface PresenceHost {
  readonly registry: Pick<CoordinationStore, 'publish'>;
  readonly process: ProcessIdentity;
  state(): Snapshot | undefined;

  branch(): string | undefined;

  active(): Activation | undefined;

  closed(): boolean;

  ending(): boolean;

  failed(error: unknown): void;

  written(): void;

  /** the last presence write failed. */
  failure(): boolean;
}

/** writes this session's presence record, coalescing changes and retrying a failed write. */
export class PresencePublisher {
  private scheduled?: ReturnType<typeof setTimeout>;
  private pending?: SessionPresence;
  private projected?: SessionPresence;
  private writing: Promise<void> = Promise.resolve();
  private retrying?: Promise<void>;

  constructor(private readonly host: PresenceHost) {}

  publish(active: Activation): Promise<void> {
    const presence = this.record(active);
    this.projected = presence;

    return this.write(presence);
  }

  /** writes a changed presence once, 100 ms after the first change. */
  schedule(active: Activation): void {
    const presence = this.record(active);
    const projected = this.projected;
    const keys = Object.keys(presence) as (keyof SessionPresence)[];

    if (
      projected &&
      keys.length === Object.keys(projected).length &&
      keys.every(
        (key) =>
          key === 'updatedAt' ||
          (Object.hasOwn(projected, key) && presence[key] === projected[key]),
      )
    )
      return;

    this.projected = presence;
    this.pending = presence;

    if (this.scheduled) return;

    this.scheduled = setTimeout(() => {
      this.scheduled = undefined;
      const pending = this.pending;
      this.pending = undefined;

      if (pending && active.publishing && this.host.active() === active)
        void this.write(pending);
    }, 100);

    this.scheduled.unref();
  }

  retry(): Promise<void> {
    if (this.host.closed() || !this.host.failure()) return Promise.resolve();

    const active = this.host.active();
    const writing = this.writing;

    this.retrying ??= writing
      .then(async () => {
        if (
          this.host.closed() ||
          this.host.ending() ||
          !active?.accepting ||
          !active.publishing ||
          this.host.active() !== active ||
          this.scheduled ||
          this.writing !== writing ||
          !this.host.failure()
        )
          return;

        await this.write(this.record(active));
      })
      .catch(() => {})
      .finally(() => {
        this.retrying = undefined;
      });

    return this.retrying;
  }

  cancel(): void {
    clearTimeout(this.scheduled);
    this.scheduled = undefined;
    this.pending = undefined;
  }

  /** settles once the writes already started have. */
  idle(): Promise<void> {
    return this.writing;
  }

  /** the next activation compares against nothing, so it writes in full. */
  reset(): void {
    this.projected = undefined;
  }

  private record(active: Activation): SessionPresence {
    const state = this.host.state();
    const { familiars, brews } = taskActivity(state);
    const { id, title, cwd, agent } = active.conversation;
    const branch = this.host.branch();

    return {
      id,
      title,
      cwd,
      agent,
      version: 1,
      selectionQueue: 1,
      peerRequests: 1,
      pauses: 1,
      project: active.project,
      activation: active.binding.activation,
      process: this.host.process,
      phase:
        state?.phase === 'compacting' ||
        state?.phase === 'updating' ||
        (state?.phase === 'idle' && state.nativeRunning)
          ? 'running'
          : (state?.phase ?? 'starting'),
      requests: state?.requests.length ?? 0,
      familiars,
      brews,
      ...(branch ? { branch } : {}),
      openedAt: active.openedAt,
      updatedAt: Date.now(),
    };
  }

  private write(presence: SessionPresence): Promise<void> {
    const written = this.writing.then(() =>
      this.host.registry.publish(presence),
    );

    this.writing = written.then(
      () => this.host.written(),
      (error: unknown) => this.host.failed(error),
    );

    return written;
  }
}
