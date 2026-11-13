import { z } from 'zod';
import { work } from './routing.js';
import type { Snapshot } from './snapshot.js';
import {
  agentWorking,
  conversationSchema,
  phaseSchema,
  processIdentity,
  type Phase,
} from './state.js';

export const claimInputSchema = z.object({
  reference: z.string(),
  aliases: z.array(z.string()).optional(),
  summary: z.string().trim().min(1),
});

const claimOwnerSchema = z.object({
  conversation: z.string(),
  project: z.string(),
});

const selectionScopeSchema = z.object({
  owner: claimOwnerSchema,
  activation: z.string().uuid(),
  turn: z.string().uuid(),
});

export const selectionTicketSchema = selectionScopeSchema.extend({
  id: z.string().uuid(),
});

export const selectionStateSchema = z.object({
  ticket: selectionTicketSchema,
  position: z.number().int().positive(),
});

const transferRequestSchema = z.object({
  to: claimOwnerSchema,
  activation: z.string().uuid(),
  process: processIdentity,
  expires: z.number(),
  refusal: z.string().optional(),
});

export const taskClaimSchema = z.object({
  id: z.string().uuid(),
  owner: claimOwnerSchema,
  references: z.array(z.string()).min(1),
  assigned: z.array(z.string()).optional(),
  summary: z.string(),
  createdAt: z.number(),
  process: processIdentity.optional(),
  suggestion: z
    .object({
      selection: z.string().uuid(),
    })
    .optional(),
  transfer: transferRequestSchema.optional(),
  // older owners must ignore automatic requests rather than treat them as a user's transfer.
  automaticTransfer: transferRequestSchema.optional(),
  movedFrom: claimOwnerSchema.optional(),
});

const choiceSchema = z.object({
  runtime: z.string().min(1),
  model: z.string().min(1),
});

export const coordinationActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('peers') }),
  z.object({ kind: z.literal('claim'), input: claimInputSchema }),
  z.object({ kind: z.literal('release'), claim: z.string().uuid() }),
  z.object({
    kind: z.literal('take'),
    input: claimInputSchema.pick({ reference: true }),
  }),
  z.object({ kind: z.literal('select-next'), turn: z.string().uuid() }),
  z.object({
    kind: z.literal('selection-status'),
    selection: z.string().uuid(),
  }),
  z.object({
    kind: z.literal('recommend'),
    selection: z.string().uuid(),
    input: claimInputSchema,
  }),
  z.object({
    kind: z.literal('cancel-selection'),
    selection: z.string().uuid(),
  }),
  z.object({
    kind: z.literal('ask'),
    claim: z.string().uuid(),
    message: z.string().trim().min(1),
  }),
  z.object({
    kind: z.literal('answer'),
    request: z.string().uuid(),
    message: z.string().trim().min(1),
  }),
  z.object({ kind: z.literal('peer-request'), request: z.string().uuid() }),
  z.object({
    kind: z.literal('pause'),
    to: z.array(z.string().min(1)).min(1).optional(),
  }),
  z.object({ kind: z.literal('resume'), pause: z.string().uuid() }),
  z.object({ kind: z.literal('pause-status'), pause: z.string().uuid() }),
  z.object({
    kind: z.literal('route'),
    work,
    of: choiceSchema.optional(),
    named: choiceSchema.optional(),
  }),
]);

export const conversationSummarySchema = conversationSchema.pick({
  id: true,
  title: true,
  cwd: true,
  agent: true,
});

export const sessionPresenceSchema = conversationSummarySchema.extend({
  version: z.literal(1),
  selectionQueue: z.literal(1).optional(),
  peerRequests: z.literal(1).optional(),
  pauses: z.literal(1).optional(),
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
      selection: selectionStateSchema.optional(),
    }),
  ),
  ownClaim: taskClaimSchema.optional(),
  ownSelection: selectionStateSchema.optional(),
  reservations: z.array(
    z.object({
      claim: taskClaimSchema,
      status: z.enum(['unattended', 'owner-outside-project', 'unknown']),
    }),
  ),
  unregistered: z.array(conversationSummarySchema),
  error: z.string().optional(),
});

export type ClaimInput = z.infer<typeof claimInputSchema>;
export type ClaimOwner = z.infer<typeof claimOwnerSchema>;
export type TaskClaim = z.infer<typeof taskClaimSchema>;
export type Transfer = NonNullable<TaskClaim['transfer']>;
export type TransferTarget =
  | { field: 'transfer'; reference: string }
  | { field: 'automaticTransfer'; claim: TaskClaim };
export type TransferField = TransferTarget['field'];
export type SelectionScope = z.infer<typeof selectionScopeSchema>;
export type SelectionTicket = z.infer<typeof selectionTicketSchema>;
export type SelectionState = z.infer<typeof selectionStateSchema>;
export type CoordinationAction = z.infer<typeof coordinationActionSchema>;
export type RouteAction = Extract<CoordinationAction, { kind: 'route' }>;
export type SessionPresence = z.infer<typeof sessionPresenceSchema>;
export type CoordinationSnapshot = z.infer<typeof coordinationSnapshotSchema>;

export const emptySnapshot: CoordinationSnapshot = {
  peers: [],
  reservations: [],
  unregistered: [],
};

export function selectionStates(tickets: SelectionTicket[]): SelectionState[] {
  const positions = new Map<string, number>();
  return tickets.map((ticket) => {
    const position = (positions.get(ticket.owner.project) ?? 0) + 1;
    positions.set(ticket.owner.project, position);
    return { ticket, position };
  });
}

export function taskActivity(
  snapshot?: Pick<Snapshot, 'subagents' | 'backgroundCommands'>,
): Pick<SessionPresence, 'familiars' | 'brews'> & { running: boolean } {
  let familiars = 0;
  for (const { status } of snapshot?.subagents ?? [])
    if (status === 'running') familiars++;
  const brews = snapshot?.backgroundCommands.length ?? 0;
  return { familiars, brews, running: familiars > 0 || brews > 0 };
}

export function checkTaskRelease(
  snapshot: Snapshot | undefined,
  human: boolean,
): void {
  if (
    human &&
    (snapshot?.phase !== 'idle' || snapshot.nativeRunning || snapshot.recovery)
  )
    throw new Error(
      'Wait for idle and resolve memory recovery before releasing the task.',
    );
  if (taskActivity(snapshot).running)
    throw new Error(
      'Stop the running familiars and brews before releasing the task.',
    );
}

/** names unregistered sessions where a refusal asks the user to restart or close them. */
export function unregisteredList(
  entries: readonly z.infer<typeof conversationSummarySchema>[],
): string {
  return entries
    .map((entry) => `${entry.title} (${entry.id}, ${entry.cwd})`)
    .join('; ');
}

export function sessionList(presences: readonly SessionPresence[]): string {
  return presences
    .map((presence) => `${presence.title} (${presence.id})`)
    .join('; ');
}

export function presenceStatus(presence: SessionPresence): string {
  if (presence.requests) return 'waiting';
  return idleStatus(presence.phase, !!(presence.familiars || presence.brews));
}

/** a session's place in the task-selection queue, as the peer lists show it. */
export function selectionStatus({ position }: SelectionState): string {
  return position === 1 ? 'choosing' : `queued #${position}`;
}

/** the session's status for display; an idle session whose native agent works on its own is running. */
export function sessionStatus(
  snapshot: Pick<
    Snapshot,
    'phase' | 'nativeRunning' | 'subagents' | 'backgroundCommands'
  >,
): string {
  if (snapshot.phase === 'idle' && snapshot.nativeRunning) return 'running';
  return idleStatus(snapshot.phase, taskActivity(snapshot).running);
}

/** whether a Witch operation, a familiar, a brew or the native agent on its own is running. */
export function sessionWorking(
  snapshot: Pick<
    Snapshot,
    'phase' | 'nativeRunning' | 'subagents' | 'backgroundCommands'
  >,
): boolean {
  return (
    agentWorking(snapshot.phase) ||
    taskActivity(snapshot).running ||
    !!snapshot.nativeRunning
  );
}

/** whether Witch itself is at work: `sessionWorking`, or merge cleanup or closing, which start no agent jobs. */
export function witchWorking(
  snapshot: Pick<
    Snapshot,
    'phase' | 'nativeRunning' | 'subagents' | 'backgroundCommands'
  >,
): boolean {
  return (
    sessionWorking(snapshot) ||
    snapshot.phase === 'cleaning' ||
    snapshot.phase === 'closing'
  );
}

/** an idle session runs in the background while its familiars or brews do. */
function idleStatus(phase: Phase, background: boolean): string {
  return phase === 'idle' && background ? 'background' : phase;
}

/** named tasks belong to a project; GitHub issue and pr routes share one number. */
export function taskReference(reference: string, project: string): string {
  const value = reference.trim();
  if (value.startsWith('task:')) {
    const name = value.slice(5).trim().replace(/\s+/g, ' ').toLowerCase();
    if (name) return `task:${project}:${name}`;
  } else {
    try {
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
    } catch (error) {
      if (!(error instanceof TypeError || error instanceof URIError))
        throw error;
    }
  }
  throw new Error('Use a full GitHub issue or pr URL, or task:<name>.');
}

/** the parts of a `github:owner/repo#n` reference, which `taskReference` writes. */
export function githubReference(
  reference: string,
): { repository: string; number: string } | undefined {
  const match = /^github:([^#]+)#(\d+)$/.exec(reference);
  return match ? { repository: match[1]!, number: match[2]! } : undefined;
}
