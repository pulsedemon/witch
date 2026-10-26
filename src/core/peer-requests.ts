import { z } from 'zod';
import type { TaskClaim } from './coordination-state.js';

export const peerRequestSchema = z.object({
  id: z.string().uuid(),
  project: z.string(),
  from: z.string(),
  to: z.string(),
  claim: z.string().uuid(),
  /** the claim's first reference, for display. */
  reference: z.string(),
  message: z.string().trim().min(1),
  askedAt: z.string(),
  /** when the owner's Witch took the request for its one answer turn. */
  attemptedAt: z.string().optional(),
  answer: z
    .object({ message: z.string().trim().min(1), answeredAt: z.string() })
    .optional(),
});

export const peerRequestStatusSchema = z.enum([
  'pending',
  'answered',
  'attempted',
  'undeliverable',
]);

export type PeerRequest = z.infer<typeof peerRequestSchema>;
export type PeerRequestStatus = z.infer<typeof peerRequestStatusSchema>;

/** an unanswered, unattempted request is undeliverable once its owner no longer holds the claim it was bound to. */
export function peerRequestStatus(
  request: PeerRequest,
  claims: readonly TaskClaim[],
): PeerRequestStatus {
  if (request.answer) return 'answered';
  if (request.attemptedAt) return 'attempted';
  return claims.some(
    ({ id, owner }) =>
      id === request.claim &&
      owner.conversation === request.to &&
      owner.project === request.project,
  )
    ? 'pending'
    : 'undeliverable';
}

export function answerable(
  requests: readonly PeerRequest[],
  conversation: string,
  project: string,
  claims: readonly TaskClaim[],
): PeerRequest[] {
  return requests.filter(
    (request) =>
      request.project === project &&
      request.to === conversation &&
      peerRequestStatus(request, claims) === 'pending',
  );
}

export function incoming(
  requests: readonly PeerRequest[],
  conversation: string,
): PeerRequest[] {
  return requests.filter(({ to }) => to === conversation);
}

export function answered(
  requests: readonly PeerRequest[],
  conversation: string,
): PeerRequest[] {
  return requests.filter(({ from, answer }) => from === conversation && answer);
}
