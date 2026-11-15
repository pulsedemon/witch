import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { writeJson } from '../../persistence/json.js';
import type { TurnResult } from '../../agents/types.js';
import type { SessionCoordination } from './coordination.js';
import type { PeerRequest } from './peer-requests.js';

const peerAnswerSchema = z.strictObject({
  answers: z
    .array(
      z.strictObject({
        id: z.string().uuid(),
        message: z.string().trim().min(1),
      }),
    )
    .min(1),
});

export type PeerAnswer = z.infer<typeof peerAnswerSchema>['answers'][number];

export const peerAnswerOutputSchema = z.toJSONSchema(peerAnswerSchema, {
  target: 'draft-7',
});

export interface PeerAnswerBatch {
  requests: readonly PeerRequest[];
  file: string;
}

export async function preparePeerAnswers(
  requests: readonly PeerRequest[],
  directory = tmpdir(),
): Promise<PeerAnswerBatch> {
  const file = join(directory, `peer-requests-${randomUUID()}.json`);
  await writeJson(file, requests);

  return { requests, file };
}

export function parsePeerAnswers(
  text: string,
  requests: readonly PeerRequest[],
): PeerAnswer[] {
  const { answers } = peerAnswerSchema.parse(JSON.parse(text));
  const expected = new Set(requests.map(({ id }) => id));

  for (const answer of answers)
    if (!expected.delete(answer.id))
      throw new Error('Peer answers did not match the admitted requests.');

  if (expected.size)
    throw new Error('Peer answers did not cover every admitted request.');

  return answers;
}

export async function recordPeerAnswers(
  result: TurnResult,
  requests: readonly PeerRequest[],
  coordination: SessionCoordination,
): Promise<void> {
  if (result.status === 'completed')
    await coordination.answerPeers(parsePeerAnswers(result.text, requests));
}
