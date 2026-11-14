import { errorMessage } from '../errors.js';

import type { AgentSession, TurnResult } from '../agents/types.js';

import type { Phase } from './state.js';

interface Request {
  conversation?: string;
  finished: PromiseWithResolvers<boolean>;
  cancelled: boolean;
}

interface Owner {
  state(): {
    conversation?: string;
    phase: Phase;
    closed: boolean;
    halted: boolean;
    replied: boolean;
    parent?: Promise<unknown>;
    draining?: Promise<void>;
    session?: AgentSession;
  };

  idle(): Promise<boolean>;

  changed(): void;

  failed(): void;

  notice(text: string): void;

  report(error: unknown): void;

  exhaustion(): Promise<void> | undefined;
}

/** compacts the session's history, interrupted when cancelled meanwhile; a session with none completes without compacting. */
export async function compactSession(
  connect: () => Promise<AgentSession>,
  cancelled: () => boolean,
  notice: (text: string) => void,
): Promise<TurnResult> {
  const interrupted: TurnResult = { status: 'interrupted', text: '' };

  let result = interrupted;

  try {
    const session = await connect();

    if (!cancelled() && !session.closed)
      if (session.info.hasHistory) result = await session.compact();
      else {
        notice('No conversation history to compact');

        result = { status: 'completed', text: '' };
      }
  } catch (error) {
    result = { status: 'failed', text: '', error: errorMessage(error) };
  }

  // a snapshot listener can cancel from inside the notice
  return cancelled() ? interrupted : result;
}

/** a manual request blocks delivery until native completion and the next command's admission window. */
export class Compaction {
  private request?: Request;
  private running?: Promise<boolean>;
  busy?: Promise<TurnResult>;
  failure?: TurnResult;

  constructor(private readonly owner: Owner) {}

  get pending(): boolean {
    return !!this.request;
  }

  beginActivity(): void {
    this.busy = undefined;

    this.failure = undefined;
  }

  cancel(): void {
    if (!this.request) return;

    this.request.cancelled = true;

    this.owner.failed();

    if (this.busy) this.failure = { status: 'interrupted', text: '' };
  }

  start(): Promise<boolean> {
    if (this.request) return this.request.finished.promise;

    const state = this.owner.state();

    if (state.closed) return Promise.resolve(false);

    if (state.phase === 'recovery')
      return Promise.reject(
        new Error('Resolve pending memory before running another task'),
      );

    if (state.phase === 'error') return Promise.resolve(false);

    const request: Request = {
      conversation: state.conversation,
      finished: Promise.withResolvers<boolean>(),
      cancelled: false,
    };

    this.request = request;

    this.owner.changed();

    void this.run(request, state.parent, state.draining).then(
      (success) => this.finish(request, success),
      (error: unknown) => {
        this.owner.report(error);

        this.finish(request, false);
      },
    );

    return request.finished.promise;
  }

  /** a request that joins learns only whether it completed; the caller's own handling reports a throw. */
  automatic(operation: () => Promise<TurnResult>): Promise<TurnResult> {
    const result = operation();

    const completed = result.then(
      ({ status }) => status === 'completed',
      () => false,
    );

    this.running = completed;

    return result.finally(() => {
      if (this.running === completed) this.running = undefined;
    });
  }

  private async run(
    request: Request,
    parent?: Promise<unknown>,
    draining?: Promise<void>,
  ): Promise<boolean> {
    // a synchronous snapshot listener can request compact before the pre-turn check installs its operation
    await Promise.resolve();

    const exhaustion = this.owner.exhaustion();

    await exhaustion;

    let success: boolean | undefined;

    const state = this.owner.state();

    if (this.running) success = await this.running;
    else if (!request.cancelled && state.phase === 'running') {
      const native = state.session?.compactDuringTurn?.();

      if (native) {
        this.busy = native
          .catch((error: unknown): TurnResult => ({
            status: 'failed',
            text: '',
            error: errorMessage(error),
          }))
          .then((result) => {
            if (result.status !== 'completed') {
              this.failure = result;

              this.owner.failed();

              this.owner.notice(result.error ?? 'Compaction interrupted');
            }

            return result;
          });

        success = (await this.busy).status === 'completed';

        const next = this.owner.state();

        if (!success || (next.replied && !request.cancelled && !next.halted))
          return success && !request.cancelled;
      }
    }

    await parent?.catch(() => {});

    await draining;

    const pendingExhaustion = this.owner.exhaustion();

    await pendingExhaustion;

    const next = this.owner.state();

    if (
      request.cancelled ||
      next.closed ||
      next.conversation !== request.conversation ||
      next.phase !== 'idle' ||
      ((parent || exhaustion || pendingExhaustion) && next.halted)
    )
      return false;

    if (success === undefined) success = await this.owner.idle();

    const settled = this.owner.state();

    return (
      success &&
      !request.cancelled &&
      !settled.closed &&
      settled.phase === 'idle' &&
      !settled.halted
    );
  }

  private finish(request: Request, success: boolean): void {
    if (this.request !== request) return;

    this.request = undefined;

    if (!success) this.owner.failed();

    request.finished.resolve(success);

    this.owner.changed();
  }
}
