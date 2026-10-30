import type { FamiliarAction, FamiliarOutcome } from './familiar-report.js';
import type { AgentEvent, UserResponse } from './types.js';

interface Request {
  id: string;
  response?: UserResponse;
  resolved: boolean;
}

/** a familiar's forwarded questions and approvals, shown in Witch until answered, resolved or the familiar ends. */
export class FamiliarRequests {
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
