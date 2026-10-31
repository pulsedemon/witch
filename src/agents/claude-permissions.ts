import { z } from 'zod';
import { proposedDiff } from './claude-diff.js';
import type { UserRequest } from './types.js';

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
