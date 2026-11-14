import type { FamiliarAction, FamiliarOutcome } from './familiar-report.js';
import type { AgentEvent, Subagent, UserResponse } from './types.js';

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
  private ended = false;

  constructor(
    action: Extract<FamiliarAction, { kind: 'familiar-register' }>,
    private readonly emit: (event: AgentEvent) => void,
    parent?: string,
  ) {
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
      this.checkRunning();

      return this.requests.report(action);
    }

    // the wrapper retries an update under its sequence, so an older or repeated one changes nothing
    if (action.sequence <= this.sequence) return { kind: 'familiar-updated' };

    this.checkRunning();

    this.sequence = action.sequence;
    this.subagent = { ...this.subagent, ...action.progress };

    if (this.subagent.status !== 'running') this.requests.resolveAll();

    this.emit({ type: 'subagent', subagent: this.subagent });

    return { kind: 'familiar-updated' };
  }

  /** ends the run with the command that carried it, marking a familiar that never reported its own end. */
  end(status: 'stopped' | 'failed'): void {
    this.ended = true;

    this.requests.resolveAll();

    if (this.subagent.status !== 'running') return;

    this.subagent = { ...this.subagent, status };

    this.emit({ type: 'subagent', subagent: this.subagent });
  }

  private checkRunning(): void {
    if (this.ended || this.subagent.status !== 'running')
      throw new Error('The familiar run has already ended.');
  }
}
