import { z } from 'zod';
import { conversationSchema, phaseSchema, processIdentity } from './state.js';

export const claimInputSchema = z.object({
  reference: z.string(),
  aliases: z.array(z.string()).optional(),
  summary: z.string().trim().min(1),
});

export const claimOwnerSchema = z.object({
  conversation: z.string(),
  project: z.string(),
});

export const taskClaimSchema = z.object({
  id: z.string().uuid(),
  owner: claimOwnerSchema,
  references: z.array(z.string()).min(1),
  summary: z.string(),
  createdAt: z.number(),
});

export const coordinationActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('peers') }),
  z.object({ kind: z.literal('claim'), input: claimInputSchema }),
  z.object({ kind: z.literal('release'), claim: z.string().uuid() }),
]);

export const sessionPresenceSchema = conversationSchema
  .pick({ id: true, title: true, cwd: true, agent: true })
  .extend({
    version: z.literal(1),
    project: z.string(),
    activation: z.string().uuid(),
    process: processIdentity,
    phase: phaseSchema,
    requests: z.number().int().nonnegative(),
    familiars: z.number().int().nonnegative(),
    brews: z.number().int().nonnegative(),
    branch: z.string().optional(),
    openedAt: z.number(),
    updatedAt: z.number(),
  });

export const coordinationSnapshotSchema = z.object({
  peers: z.array(
    z.object({
      presence: sessionPresenceSchema,
      claim: taskClaimSchema.optional(),
    }),
  ),
  ownClaim: taskClaimSchema.optional(),
  reservations: z.array(
    z.object({
      claim: taskClaimSchema,
      status: z.enum(['unattended', 'owner-outside-project', 'unknown']),
    }),
  ),
  unregistered: z.array(
    conversationSchema.pick({ id: true, title: true, cwd: true, agent: true }),
  ),
  error: z.string().optional(),
});

export type ClaimInput = z.infer<typeof claimInputSchema>;
export type ClaimOwner = z.infer<typeof claimOwnerSchema>;
export type TaskClaim = z.infer<typeof taskClaimSchema>;
export type CoordinationAction = z.infer<typeof coordinationActionSchema>;
export type SessionPresence = z.infer<typeof sessionPresenceSchema>;
export type CoordinationSnapshot = z.infer<typeof coordinationSnapshotSchema>;

/** named tasks belong to a project; GitHub issue and pr routes share one number. */
export function taskReference(reference: string, project: string): string {
  const value = reference.trim();
  if (value.startsWith('task:')) {
    const name = value.slice(5).trim().replace(/\s+/g, ' ').toLowerCase();
    if (name) return `task:${project}:${name}`;
  } else {
    const url = new URL(value);
    const match =
      /^\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/([1-9]\d*)\/*$/.exec(
        decodeURIComponent(url.pathname),
      );
    if (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      !url.port &&
      !url.username &&
      !url.password &&
      match
    )
      return `github:${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}#${match[3]}`;
  }
  throw new Error('Use a full GitHub issue or pr URL, or task:<name>.');
}
