import { z } from 'zod';
import { object } from './config.js';
import { fileChangeIdentity, fileChangeKey } from './items.js';
import type { RpcMessage } from './json-rpc.js';
import type { FileDiff, UserRequest } from '../types.js';

const questionList = z.array(
  z.object({
    id: z.string(),
    question: z.string(),
    isSecret: z.boolean().optional(),
    options: z.array(z.object({ label: z.string() })).nullable(),
  }),
);

/** undefined for an unsupported method; throws when the params don't parse. */
export function parseRequest(
  message: RpcMessage,
  proposals: ReadonlyMap<string, { diff: FileDiff[] }>,
): UserRequest | undefined {
  const id = String(message.id);
  const data = object.parse(message.params);

  const request = {
    id,
    title: String(
      data.reason ?? data.message ?? data.command ?? message.method,
    ),
    detail: JSON.stringify(data, null, 2),
    survivesTurn: true,
  };

  if (message.method === 'item/tool/requestUserInput')
    return {
      ...request,
      kind: 'question',
      questions: questionList.parse(data.questions).map((question) => ({
        id: question.id,
        title: question.question,
        secret: question.isSecret,
        options: question.options?.map((option) => option.label) ?? [],
      })),
    };

  if (message.method === 'mcpServer/elicitation/request')
    return {
      ...request,
      kind: 'elicitation',
      url: typeof data.url === 'string' ? data.url : undefined,
      schema: data.requestedSchema
        ? object.parse(data.requestedSchema)
        : undefined,
    };

  if (message.method === 'item/fileChange/requestApproval') {
    const identity = fileChangeIdentity.safeParse(data);

    const diff = identity.success
      ? proposals.get(
          fileChangeKey(
            identity.data.threadId,
            identity.data.turnId,
            identity.data.itemId,
          ),
        )?.diff
      : undefined;

    return { ...request, kind: 'approval', ...(diff ? { diff } : {}) };
  }

  if (
    [
      'item/commandExecution/requestApproval',
      'item/permissions/requestApproval',
    ].includes(message.method ?? '')
  )
    return { ...request, kind: 'approval' };

  return undefined;
}
