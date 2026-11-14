import { randomUUID } from 'node:crypto';
import type { CanUseTool, OnElicitation } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { proposedDiff } from './diff.js';
import type { SessionOptions, UserRequest, UserResponse } from '../types.js';

const questions = z.object({
  questions: z.array(
    z.object({
      question: z.string(),
      multiSelect: z.boolean().optional(),
      options: z.array(z.object({ label: z.string() })).optional(),
    }),
  ),
});

export async function toolRequest(
  toolName: string,
  input: Record<string, unknown>,
  toolUseID: string,
  cwd: string,
  signal: AbortSignal,
): Promise<UserRequest> {
  const request: UserRequest = {
    id: toolUseID,
    kind: 'approval',
    title: toolName,
    detail: JSON.stringify(input, null, 2),
  };

  if (toolName === 'AskUserQuestion') {
    request.kind = 'question';

    request.questions = questions.parse(input).questions.map((question) => ({
      id: question.question,
      title: question.question,
      options: question.options?.map((option) => option.label) ?? [],
      multiple: question.multiSelect,
    }));
  }

  if (toolName === 'Edit' || toolName === 'Write') {
    const diff = await proposedDiff(toolName, input, cwd, signal);

    if (diff) request.diff = diff;
  }

  return request;
}

export class ClaudeRequests {
  private readonly requests = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<UserResponse>>
  >();

  constructor(
    private readonly options: Pick<
      SessionOptions,
      'cwd' | 'answer' | 'onEvent'
    >,
    private readonly closed: () => boolean,
  ) {}

  respond(id: string, response: UserResponse): void {
    this.requests.get(id)?.resolve(response);
  }

  cancel(): void {
    for (const request of this.requests.values())
      request.resolve({ decision: 'cancel' });
  }

  readonly canUseTool: CanUseTool = async (toolName, input, context) => {
    // the batch file is Witch-owned input outside Claude's working directories
    if (
      toolName === 'Read' &&
      this.options.answer &&
      input.file_path === this.options.answer.requestFile
    )
      return { behavior: 'allow', updatedInput: input };

    if (this.options.answer)
      return {
        behavior: 'deny',
        message: 'Peer answers cannot request approval.',
      };

    const request = await toolRequest(
      toolName,
      input,
      context.toolUseID,
      this.options.cwd,
      context.signal,
    );

    if (context.signal.aborted || this.closed())
      return {
        behavior: 'deny',
        message: 'Request cancelled',
        interrupt: true,
      };

    const response = await this.ask(request, context.signal);

    if (response.decision !== 'accept')
      return {
        behavior: 'deny',
        message: 'User declined the request',
        interrupt: response.decision === 'cancel',
      };

    return {
      behavior: 'allow',
      updatedInput:
        toolName === 'AskUserQuestion'
          ? {
              ...input,
              answers: Object.fromEntries(
                Object.entries(response.answers ?? {}).map(([id, answers]) => [
                  id,
                  answers.join(', '),
                ]),
              ),
            }
          : input,
    };
  };

  readonly onElicitation: OnElicitation = async (request, context) => {
    if (this.options.answer) return { action: 'decline' };

    const response = await this.ask(
      {
        id: randomUUID(),
        kind: 'elicitation',
        title: request.message,
        detail: request.serverName,
        url: request.url,
        schema: request.requestedSchema,
      },
      context.signal,
    );

    const content = response.content
      ? z
          .record(
            z.string(),
            z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
          )
          .parse(response.content)
      : undefined;

    return { action: response.decision, ...(content ? { content } : {}) };
  };

  private async ask(
    request: UserRequest,
    signal?: AbortSignal,
  ): Promise<UserResponse> {
    const response = Promise.withResolvers<UserResponse>();

    this.requests.set(request.id, response);

    const cancel = () => response.resolve({ decision: 'cancel' });

    signal?.addEventListener('abort', cancel, { once: true });

    if (signal?.aborted) cancel();
    else this.options.onEvent({ type: 'request', request });

    try {
      return await response.promise;
    } finally {
      signal?.removeEventListener('abort', cancel);

      this.requests.delete(request.id);

      this.options.onEvent({ type: 'request-resolved', id: request.id });
    }
  }
}
