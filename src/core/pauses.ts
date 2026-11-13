import { z } from 'zod';
import { sessionList, unregisteredList } from './coordination-state.js';
import type {
  ClaimOwner,
  CoordinationAction,
  SessionPresence,
} from './coordination-state.js';
import type { Discovery } from './discovery.js';

const pauseRecipientSchema = z.object({
  conversation: z.string(),
  project: z.string(),
  /** when the recipient's Witch had stopped its work. */
  confirmedAt: z.string().optional(),
  resumedAt: z.string().optional(),
  resumedBy: z.enum(['issuer', 'user']).optional(),
});

export const pauseSchema = z.object({
  id: z.string().uuid(),
  from: z.string(),
  project: z.string(),
  issuedAt: z.string(),
  /** the issuer's turn and `--to` list, so a retried `--pause` in that turn returns this record. */
  turn: z.string().optional(),
  requested: z.array(z.string()).optional(),
  recipients: z.array(pauseRecipientSchema).min(1),
});

export const pauseStatusSchema = z.enum(['pending', 'paused', 'resumed']);

export type Pause = z.infer<typeof pauseSchema>;
export type PauseRecipient = z.infer<typeof pauseRecipientSchema>;
type PauseStatus = z.infer<typeof pauseStatusSchema>;
export type PauseAction = Extract<
  CoordinationAction,
  { kind: 'pause' | 'resume' | 'pause-status' }
>;

export function isPauseAction(
  action: CoordinationAction,
): action is PauseAction {
  return (
    action.kind === 'pause' ||
    action.kind === 'resume' ||
    action.kind === 'pause-status'
  );
}

function recipientStatus(recipient: PauseRecipient): PauseStatus {
  if (recipient.resumedAt) return 'resumed';
  return recipient.confirmedAt ? 'paused' : 'pending';
}

export function pauseStatuses(pause: Pause): Record<string, PauseStatus> {
  return Object.fromEntries(
    pause.recipients.map((recipient) => [
      recipient.conversation,
      recipientStatus(recipient),
    ]),
  );
}

export function entry(
  pause: Pause,
  conversation: string,
): PauseRecipient | undefined {
  return pause.recipients.find(
    (recipient) => recipient.conversation === conversation,
  );
}

/** the pauses that still hold the conversation. */
export function holding(
  pauses: readonly Pause[],
  conversation: string,
): Pause[] {
  return pauses.filter((pause) => {
    const recipient = entry(pause, conversation);
    return recipient !== undefined && !recipient.resumedAt;
  });
}

export function sameRequest(
  pause: Pause,
  from: string,
  turn: string | undefined,
  requested: readonly string[] | undefined,
): boolean {
  return (
    turn !== undefined &&
    pause.from === from &&
    pause.turn === turn &&
    JSON.stringify(pause.requested ?? []) === JSON.stringify(requested ?? [])
  );
}

export function pauseNotices(
  pauses: readonly Pause[],
  conversation: string,
): { id: string; text: string }[] {
  return pauses.flatMap((pause) => {
    const recipient = entry(pause, conversation);
    if (!recipient) return [];
    if (!recipient.resumedAt)
      return [
        {
          id: `pause/${pause.id}`,
          text: `Session ${pause.from} paused this conversation (pause ${pause.id}). Your next prompt resumes it.`,
        },
      ];
    return recipient.resumedBy === 'issuer'
      ? [
          {
            id: `pause-lifted/${pause.id}`,
            text: `Session ${pause.from} lifted pause ${pause.id}.`,
          },
        ]
      : [];
  });
}

/** default recipients are the issuer's live project peers; `--to` names live sessions in any project. */
export function pauseRecipients(
  to: readonly string[] | undefined,
  issuer: ClaimOwner,
  discovery: Pick<Discovery, 'live' | 'unregistered'>,
): SessionPresence[] {
  let recipients: SessionPresence[];
  if (to) {
    const ids = [...new Set(to)].filter((id) => id !== issuer.conversation);
    const missing = ids.filter((id) => !discovery.live.has(id));
    if (missing.length)
      throw new Error(
        `These are not live Witch sessions: ${missing.join(', ')}. Query --peers --json for session ids.`,
      );
    recipients = ids.map((id) => discovery.live.get(id)!);
  } else {
    const unregistered = discovery.unregistered.get(issuer.project) ?? [];
    if (unregistered.length)
      throw new Error(
        `Restart or close these unregistered Witch sessions before pausing: ${unregisteredList(unregistered)}`,
      );
    recipients = [...discovery.live.values()].filter(
      (presence) =>
        presence.project === issuer.project &&
        presence.id !== issuer.conversation,
    );
  }
  if (!recipients.length) throw new Error('No other live session to pause.');
  const older = recipients.filter((presence) => !presence.pauses);
  if (older.length)
    throw new Error(
      `These Witch sessions cannot be paused until their user restarts them onto a current build: ${sessionList(older)}`,
    );
  return recipients;
}
