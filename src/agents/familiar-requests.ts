import type {
  FamiliarAction,
  FamiliarOutcome,
  FamiliarProgress,
} from './familiar-report.js';
import { readCompletedReceipt } from '../core/review/review.js';
import { terminateGraceMs } from './shutdown.js';
import type { AgentEvent, Subagent, UserResponse } from './types.js';

/** how long a wrapper stopping with its command may still send progress; past it a refusal makes a survivor stop itself. */
const lateProgressMs = 5 * terminateGraceMs;

interface Request {
  id: string;
  response?: UserResponse;
  resolved: boolean;
}

/** a familiar's forwarded questions and approvals, shown in Witch until answered, resolved or the familiar ends. */
class FamiliarRequests {
  /** keyed by the familiar's own request ID. */
  private readonly requests = new Map<string, Request>();

  constructor(
    private readonly run: string,
    private readonly emit: (event: AgentEvent) => void,
  ) {}

  report(
    action: Extract<
      FamiliarAction,
      {
        kind:
          | 'familiar-request'
          | 'familiar-request-poll'
          | 'familiar-request-resolved';
      }
    >,
  ): FamiliarOutcome {
    const id =
      action.kind === 'familiar-request' ? action.request.id : action.id;

    let request = this.requests.get(id);

    if (action.kind === 'familiar-request-resolved') {
      if (request) this.resolve(request);

      return { kind: 'familiar-updated' };
    }

    if (!request && action.kind === 'familiar-request') {
      request = { id: `familiar/${this.run}/${id}`, resolved: false };
      this.requests.set(id, request);

      this.emit({
        type: 'request',
        request: {
          ...action.request,
          id: request.id,
          replyAsPrompt: false,
          survivesTurn: true,
        },
      });
    }

    if (!request || request.resolved)
      throw new Error('The familiar request is not pending.');

    return request.response
      ? { kind: 'familiar-response', response: request.response }
      : { kind: 'familiar-request-pending' };
  }

  /** true when `id` names one of this familiar's pending requests. */
  respond(id: string, response: UserResponse): boolean {
    for (const request of this.requests.values())
      if (request.id === id && !request.resolved) {
        request.response ??= response;

        return true;
      }

    return false;
  }

  resolveAll(): void {
    for (const request of this.requests.values()) this.resolve(request);
  }

  private resolve(request: Request): void {
    if (request.resolved) return;

    request.resolved = true;
    this.emit({ type: 'request-resolved', id: request.id });
  }
}

/** a registered familiar's subagent row, update sequence and forwarded requests. */
export class FamiliarRun {
  subagent: Subagent;
  readonly requests: FamiliarRequests;
  private sequence = -1;
  /** when the carrying command ended. */
  private endedAt?: number;
  /** whether the terminal report has been published. */
  private reported = false;
  readonly planReview: boolean;
  /** a plan review can be acknowledged before the carrying command's exit confirms it. */
  private completion?: FamiliarProgress;

  constructor(
    action: Extract<FamiliarAction, { kind: 'familiar-register' }>,
    private readonly emit: (event: AgentEvent) => void,
    parent?: string,
  ) {
    this.planReview = action.planReview === true;

    this.subagent = {
      id: `${action.runtime}-familiar/${action.run}`,
      run: action.run,
      name: action.name,
      kind: '',
      runtime: action.runtime,
      status: 'running',
      tools: 0,
      ...(parent ? { parent } : {}),
    };

    this.requests = new FamiliarRequests(action.run, emit);
    emit({ type: 'subagent', subagent: this.subagent });
  }

  report(
    action: Exclude<FamiliarAction, { kind: 'familiar-register' }>,
  ): FamiliarOutcome {
    if (action.kind !== 'familiar-update') {
      // resolving is idempotent, so the wrapper's cleanup after its command ended isn't refused
      if (action.kind !== 'familiar-request-resolved') this.checkRunning();

      return this.requests.report(action);
    }

    // the wrapper retries an update under its sequence, so an older or repeated one changes nothing
    if (action.sequence <= this.sequence) return { kind: 'familiar-updated' };

    // progress sent before the wrapper saw its command end can't revive the row
    const late =
      this.endedAt !== undefined && action.progress.status === 'running';

    const stagesCompletion =
      this.planReview && action.progress.status === 'completed';

    if (
      this.reported ||
      (stagesCompletion && this.endedAt !== undefined) ||
      (late && performance.now() - this.endedAt! > lateProgressMs)
    )
      throw new Error('The familiar run has already ended.');

    if (stagesCompletion) {
      const receipt = readCompletedReceipt(action.progress.report);

      if (
        !receipt ||
        receipt.runtime !== this.subagent.runtime ||
        receipt.model !== action.progress.model
      )
        throw new Error('The plan review did not supply a completed receipt.');
    }

    this.sequence = action.sequence;

    if (late) return { kind: 'familiar-updated' };

    if (stagesCompletion) {
      this.completion = action.progress;

      return { kind: 'familiar-updated' };
    }

    this.completion = undefined;
    this.subagent = { ...this.subagent, ...action.progress };

    if (this.subagent.status !== 'running') {
      this.reported = true;
      this.requests.resolveAll();
    }

    this.emit({ type: 'subagent', subagent: this.subagent });

    return { kind: 'familiar-updated' };
  }

  /** a successful command exit confirms a staged plan review. an ordinary terminal report can still arrive after its command ends. */
  end(status: 'completed' | 'stopped' | 'failed'): void {
    this.endedAt ??= performance.now();
    this.requests.resolveAll();

    if (this.subagent.status !== 'running') return;

    const completed = status === 'completed' && this.completion;
    this.completion = undefined;

    if (completed) this.reported = true;

    this.subagent = completed
      ? { ...this.subagent, ...completed }
      : {
          ...this.subagent,
          status: status === 'stopped' ? 'stopped' : 'failed',
        };

    this.emit({ type: 'subagent', subagent: this.subagent });
  }

  private checkRunning(): void {
    if (this.endedAt !== undefined || this.subagent.status !== 'running')
      throw new Error('The familiar run has already ended.');
  }
}
