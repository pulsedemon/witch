import { z } from 'zod';
import type { ControlBinding } from '../persistence/control.js';
import { checkDeadline } from '../persistence/coordination.js';
import { FamiliarRun } from './familiar-requests.js';
import type { Cast, UserResponse } from './types.js';
import {
  taskStatuses,
  userRequestSchema,
  userResponseSchema,
} from './types.js';

const familiarProgressSchema = z.object({
  status: z.enum(taskStatuses),
  model: z.string().min(1).optional(),
  activity: z.string().optional(),
  tools: z.number().int().nonnegative().optional(),
  report: z.string().optional(),
  /** the transient notices its native session posted, oldest first. */
  notices: z.array(z.string()).optional(),
  spells: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
});

export type FamiliarProgress = z.infer<typeof familiarProgressSchema>;

/** a familiar's spells with the new casts added; undefined when none is new. */
export function mergeCasts(
  spells: readonly Cast[] | undefined,
  casts: readonly Cast[],
): Cast[] | undefined {
  const known = new Set(spells?.map(({ id }) => id));
  const added = casts.filter(({ id }) => !known.has(id));

  return added.length ? [...(spells ?? []), ...added] : undefined;
}

export const familiarActionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('familiar-register'),
    run: z.string().uuid(),
    name: z.string().trim().min(1),
    /** the wrapper's runtime, since either runtime's session can launch either wrapper. */
    runtime: z.enum(['claude', 'codex']),
  }),
  z.object({
    kind: z.literal('familiar-update'),
    run: z.string().uuid(),
    sequence: z.number().int().nonnegative(),
    progress: familiarProgressSchema,
  }),
  z.object({
    kind: z.literal('familiar-request'),
    run: z.string().uuid(),
    request: userRequestSchema,
  }),
  z.object({
    kind: z.literal('familiar-request-poll'),
    run: z.string().uuid(),
    id: z.string(),
  }),
  z.object({
    kind: z.literal('familiar-request-resolved'),
    run: z.string().uuid(),
    id: z.string(),
  }),
]);

export type FamiliarAction = z.infer<typeof familiarActionSchema>;

export const familiarOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.enum([
      'familiar-registered',
      'familiar-pending',
      'familiar-updated',
      'familiar-request-pending',
    ]),
  }),
  z.object({
    kind: z.literal('familiar-response'),
    response: userResponseSchema,
  }),
]);

export type FamiliarOutcome = z.infer<typeof familiarOutcomeSchema>;

export function isFamiliarAction(action: {
  kind: string;
}): action is FamiliarAction {
  return action.kind.startsWith('familiar-');
}

const familiarMarkerSchema = z.object({
  version: z.literal(1),
  conversation: z.string().min(1),
  activation: z.string().uuid(),
  run: z.string().uuid(),
});

export type FamiliarMarker = z.infer<typeof familiarMarkerSchema>;

const familiarMarkerPrefix = 'WITCH_FAMILIAR ';

export function familiarMarker(marker: FamiliarMarker): string {
  return `${familiarMarkerPrefix}${JSON.stringify(marker)}\n`;
}

function readFamiliarMarker(line: string): FamiliarMarker | undefined {
  if (!line.startsWith(familiarMarkerPrefix)) return;

  try {
    return familiarMarkerSchema.safeParse(
      JSON.parse(line.slice(familiarMarkerPrefix.length)),
    ).data;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
}

/** the line's marker when it was written for `binding`'s conversation and activation. */
export function boundMarker(
  line: string,
  binding: Pick<ControlBinding, 'conversation' | 'activation'>,
): FamiliarMarker | undefined {
  const marker = readFamiliarMarker(line);

  return marker?.conversation === binding.conversation &&
    marker.activation === binding.activation
    ? marker
    : undefined;
}

export interface MarkerLine {
  partial: string;
  discarding: boolean;
}

export function scanMarkers(
  line: MarkerLine,
  delta: string,
  binding: Pick<ControlBinding, 'conversation' | 'activation'>,
  found: (marker: FamiliarMarker) => void,
): void {
  for (const part of delta.split(/(?<=\n)/)) {
    const ends = part.endsWith('\n');

    if (!line.discarding) {
      line.partial += part;

      if (line.partial.length > 4096) {
        line.partial = '';
        line.discarding = true;
      } else if (ends) {
        const marker = boundMarker(line.partial.trimEnd(), binding);

        if (marker) found(marker);
      }
    }

    if (ends) {
      line.partial = '';
      line.discarding = false;
    }
  }
}

export function checkReporting(deadline: number, available: boolean): void {
  checkDeadline(deadline);

  if (!available) throw new Error('Familiar reporting is unavailable.');
}

/** a familiar run a command's output named; one command can start several. */
export interface FamiliarSlot {
  run: string;
  familiar?: FamiliarRun;
}

export function addFamiliar(
  slots: FamiliarSlot[],
  marker: FamiliarMarker,
): void {
  if (!slots.some(({ run }) => run === marker.run))
    slots.push({ run: marker.run });
}

export function admitted(slots: readonly FamiliarSlot[]): FamiliarRun[] {
  return slots.flatMap(({ familiar }) => (familiar ? [familiar] : []));
}

/** the command and slot whose marker names the action's run; undefined only for a registration whose marker hasn't appeared yet. */
export function findFamiliar<T extends { familiars: FamiliarSlot[] }>(
  entries: Iterable<T>,
  action: FamiliarAction,
): { entry: T; slot: FamiliarSlot } | undefined {
  const matches = [...entries].flatMap((entry) =>
    entry.familiars
      .filter(({ run }) => run === action.run)
      .map((slot) => ({ entry, slot })),
  );

  if (matches.length > 1)
    throw new Error('This familiar run belongs to more than one command.');

  if (!matches[0] && action.kind !== 'familiar-register')
    throw new Error(
      'The familiar run is not registered in this native session.',
    );

  return matches[0];
}

/**
 * registers or reports to a command's familiar run. `create` returns the run, or an outcome while the command can't take one
 * yet; `registered` follows a new run.
 */
export function admitFamiliar(
  slot: FamiliarSlot,
  done: boolean,
  action: FamiliarAction,
  create: (
    action: Extract<FamiliarAction, { kind: 'familiar-register' }>,
  ) => FamiliarRun | FamiliarOutcome,
  registered: (run: FamiliarRun) => void,
): FamiliarOutcome {
  if (action.kind === 'familiar-register') {
    if (done) throw new Error('The familiar command has already ended.');

    if (slot.familiar) {
      if (slot.familiar.subagent.name !== action.name)
        throw new Error('The familiar name changed.');

      return { kind: 'familiar-registered' };
    }

    const created = create(action);

    if (!(created instanceof FamiliarRun)) return created;

    slot.familiar = created;
    registered(created);

    return { kind: 'familiar-registered' };
  }

  if (!slot.familiar) throw new Error('The familiar run has not registered.');

  return slot.familiar.report(action);
}

export function respondFamiliar(
  entries: Iterable<{ familiars: FamiliarSlot[] }>,
  id: string,
  response: UserResponse,
): boolean {
  return [...entries].some((entry) =>
    admitted(entry.familiars).some((run) => run.requests.respond(id, response)),
  );
}
