import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentEvent, SessionInfo, TurnResult } from '../agents/types.js';
import { copilotReviewStateSchema } from './review/copilot-reviews.js';
import { pullRequestSchema } from './repository/repository.js';

const session = z.object({
  id: z.string(),
  model: z.string(),
  requestedModel: z.string().optional(),
  hasHistory: z.boolean(),
  effort: z.string().optional(),
  deliveredRevision: z.string().optional(),
  deliveredInstructionsRevision: z.string().optional(),
  deliveredProject: z.string().optional(),
  deliveredMerges: z.array(z.string()).optional(),
  deliveredAnswers: z.array(z.string()).optional(),
});

export const conversationSchema = z.object({
  id: z.string(),
  title: z.string(),
  cwd: z.string(),
  agent: z.string(),
  sessions: z.record(z.string(), session),
  createdAt: z.string(),
  handoff: z
    .object({
      from: z.string(),
      to: z.string(),
      summary: z.string().optional(),
      activated: z.boolean(),
    })
    .optional(),
});

export const processIdentity = z.object({
  pid: z.number(),
  started: z.string(),
});

export const phaseSchema = z.enum([
  'starting',
  'idle',
  'running',
  'compacting',
  'switching',
  'recovery',
  'editing',
  'cleaning',
  'updating',
  'closing',
  'error',
]);

export type Phase = z.infer<typeof phaseSchema>;

export function agentWorking(phase: Phase): boolean {
  return [
    'starting',
    'running',
    'switching',
    'compacting',
    'updating',
  ].includes(phase);
}

export const conversationRecordSchema = conversationSchema.extend({
  copilotReviews: z
    .union([
      z.array(copilotReviewStateSchema),
      copilotReviewStateSchema.transform((state) => [state]),
    ])
    .optional(),
  // each pull request head and base an automatic conflict repair was started for, so none is repaired twice
  conflictRepairs: z
    .array(pullRequestSchema.pick({ url: true, commit: true, base: true }))
    .optional(),
  // each pull request head and failed check an automatic check repair was started for
  checkRepairs: z
    .array(
      pullRequestSchema
        .pick({ url: true, commit: true })
        .extend({ check: z.string() }),
    )
    .optional(),
  lastTurn: z
    .object({
      id: z.string(),
      status: z.enum(['completed', 'interrupted', 'failed']),
      // the saved images its prompt and accepted steers sent, which a handoff's continuation sends again
      images: z.array(z.string()).optional(),
    })
    .optional(),
  // sent prompts the transcript doesn't show yet, oldest first, which come back queued after a restart or crash
  queue: z.array(z.string()).optional(),
  // the composer's text, which comes back with the conversation
  draft: z.string().optional(),
  process: processIdentity.optional(),
  usageProcess: processIdentity.optional(),
  answerProcess: processIdentity.optional(),
  // the shell of a running `!` command Witch runs for Claude
  shell: processIdentity.optional(),
  // the newest ledger move's time when the conversation was created or a repair last set `cwd`; moves recorded up to it
  // belong to other directories
  cwdSince: z.string().optional(),
  // set by a move repair before it rewrites history: the directory the rows named, and `history.jsonl`'s inode, which
  // the rewrite replaces. a crash can stop the repair before its last write clears it
  historyMove: z.object({ from: z.string(), inode: z.number() }).optional(),
  activity: z
    .object({
      id: z.string(),
      agent: z.string(),
      kind: z.enum(['turn', 'handoff', 'memory-edit']),
      baseRevision: z.string(),
      startedAt: z.string(),
    })
    .optional(),
});

const hunk = z.object({
  oldStart: z.number(),
  newStart: z.number(),
  lines: z.array(z.string()),
});

const fileDiff = z.object({
  path: z.string(),
  kind: z.enum(['add', 'delete', 'update']),
  movePath: z.string().optional(),
  hunks: z.array(hunk),
  unshown: z
    .union([
      z.object({ added: z.number(), removed: z.number() }),
      z.literal('binary'),
    ])
    .optional(),
});

export const displayUpdateSchema = z.object({
  id: z.string(),
  kind: z.enum(['user', 'assistant', 'tool', 'notice']),
  text: z.string(),
  cwd: z.string(),
  title: z.string().optional(),
  // the file path a tool's title shows, so its row links the path whole
  path: z.string().optional(),
  // the complete label, including the native name or original command, shown on expansion
  expandedTitle: z.string().optional(),
  singleLine: z.literal(true).optional(),
  done: z.boolean().optional(),
  replace: z.boolean().optional(),
  images: z.array(z.string()).optional(),
  diff: z.array(fileDiff).optional(),
  // a command the user ran with `!`
  shell: z.boolean().optional(),
  // a tool call that failed or was declined
  failed: z.literal(true).optional(),
  // a notice in the warning color, such as a route usage moved
  warning: z.literal(true).optional(),
  contextCleared: z.literal(true).optional(),
  // a spell cast, animated while new
  cast: z.literal(true).optional(),
  // a prompt the agent never read, which the queue sends again
  unread: z.literal(true).optional(),
  // when Witch received the update; history from before it was recorded has none
  at: z.string().optional(),
});

export type Conversation = z.infer<typeof conversationSchema>;

export type ConversationRecord = z.infer<typeof conversationRecordSchema>;

export type ProcessIdentity = z.infer<typeof processIdentity>;

export type DisplayUpdate = z.infer<typeof displayUpdateSchema>;

export type DisplayItem = Omit<DisplayUpdate, 'replace'>;

/** the newest unmarked user row of each prompt the agent never read: those `result` left unread, and the turn's own `shown` prompt when its input went unwritten. */
export function unreadRows(
  items: readonly DisplayItem[],
  shown: readonly string[],
  { inputUnsent, unread = [] }: Pick<TurnResult, 'inputUnsent' | 'unread'>,
): DisplayItem[] {
  const rows: DisplayItem[] = [];

  for (const prompt of [...(inputUnsent ? shown : []), ...unread]) {
    const row = items.findLast(
      (item) =>
        item.kind === 'user' &&
        // a steered spell goes without the leading whitespace its row keeps
        (item.text === prompt || item.text.trimStart() === prompt) &&
        !item.unread &&
        !rows.includes(item),
    );

    if (row) rows.push(row);
  }

  return rows;
}

export function contextStart(items: readonly DisplayItem[]): number {
  return items.findLastIndex((item) => item.contextCleared) + 1;
}

export function clearConversationContext(
  record: ConversationRecord,
  info?: SessionInfo,
): void {
  const previous = record.sessions[record.agent];
  const model = info?.model || previous?.model || '';

  record.sessions = {
    [record.agent]: {
      id: '',
      model,
      requestedModel: previous?.requestedModel ?? (model || undefined),
      effort: previous?.effort ?? info?.effort ?? info?.nativeEffort,
      hasHistory: false,
    },
  };

  delete record.handoff;

  delete record.lastTurn;
}

interface TextAppend {
  stream: object;
  sequence: number;
  text: string;
  previous?: TextAppend;
}

// retain deltas across batched renders without retaining earlier cumulative text snapshots.
const appends = new WeakMap<DisplayItem, TextAppend>();

export function appendedDisplayText(
  previous: DisplayItem,
  current: DisplayItem,
): string | undefined {
  const before = appends.get(previous);
  let after = appends.get(current);

  if (
    !before ||
    !after ||
    before.stream !== after.stream ||
    before.sequence > after.sequence
  )
    return undefined;

  const chunks: string[] = [];

  while (after.sequence > before.sequence) {
    chunks.push(after.text);

    after = after.previous!;
  }

  return after === before ? chunks.reverse().join('') : undefined;
}

export function recordSession(
  conversation: Conversation,
  agent: string,
  info: SessionInfo,
): void {
  const previous = conversation.sessions[agent];

  conversation.sessions[agent] = {
    ...previous,
    id: info.id,
    model: info.model,
    hasHistory: info.hasHistory,
  };

  if (previous?.id !== info.id) clearDelivery(conversation.sessions[agent]!);
}

type NativeSession = z.infer<typeof session>;

/** adds the events a completed turn's context delivered to the native session. */
export function recordDelivery(
  reference: NativeSession,
  delivered: { merges: readonly string[]; answers: readonly string[] },
): void {
  if (delivered.merges.length)
    reference.deliveredMerges = [
      ...new Set([...(reference.deliveredMerges ?? []), ...delivered.merges]),
    ];

  if (delivered.answers.length)
    reference.deliveredAnswers = [
      ...new Set([...(reference.deliveredAnswers ?? []), ...delivered.answers]),
    ];
}

/** a native session that compacted or was replaced has seen neither the memory snapshot, the fixed instructions nor the delivered events. */
export function clearDelivery(reference: NativeSession): void {
  delete reference.deliveredRevision;

  delete reference.deliveredInstructionsRevision;

  delete reference.deliveredMerges;

  delete reference.deliveredAnswers;
}

function merge(
  previous: DisplayItem | undefined,
  { replace, ...update }: DisplayUpdate,
): DisplayItem {
  const item = previous
    ? {
        ...previous,
        ...update,
        title: update.title || previous.title,
        cwd: replace ? update.cwd : previous.cwd,
        text: replace ? update.text : previous.text + update.text,
      }
    : update;

  if (item.kind === 'tool' || item.kind === 'assistant') {
    const before = previous && !replace ? appends.get(previous) : undefined;

    appends.set(
      item,
      before && !update.text
        ? before
        : {
            stream: before?.stream ?? {},
            sequence: before ? before.sequence + 1 : 0,
            text: before ? update.text : '',
            previous: before,
          },
    );
  }

  return item;
}

/** the row an agent's text or tool event updates. */
export function agentDisplay(
  event: Extract<AgentEvent, { type: 'text' | 'tool' }>,
  id: string,
  agent: string,
  cwd: string,
): DisplayUpdate {
  return event.type === 'text'
    ? {
        id,
        kind: 'assistant',
        title: agent,
        text: event.text,
        replace: event.replace,
        cwd,
      }
    : {
        id,
        kind: 'tool',
        title: event.title,
        ...(event.path ? { path: event.path } : {}),
        ...(event.expandedTitle ? { expandedTitle: event.expandedTitle } : {}),
        ...(event.singleLine ? { singleLine: event.singleLine } : {}),
        text: event.text,
        replace: !event.append,
        done: event.done,
        cwd: event.cwd ?? cwd,
        ...(event.images ? { images: event.images } : {}),
        ...(event.diff ? { diff: event.diff } : {}),
        // an append leaves it out, and keeps the one its row has
        ...(event.shell ? { shell: true } : {}),
        ...(event.failed ? { failed: true } : {}),
      };
}

export function applyDisplayUpdate(
  items: readonly DisplayItem[],
  update: DisplayUpdate,
): DisplayItem[] {
  const index = items.findLastIndex((item) => item.id === update.id);

  if (index < 0) return [...items, merge(undefined, update)];

  const next = [...items];
  next[index] = merge(items[index], update);

  return next;
}

export function foldDisplayUpdates(
  updates: readonly DisplayUpdate[],
): DisplayItem[] {
  const items: DisplayItem[] = [];
  const indexes = new Map<string, number>();

  for (const update of updates) {
    const index = indexes.get(update.id);

    if (index === undefined) {
      indexes.set(update.id, items.length);

      items.push(merge(undefined, update));
    } else items[index] = merge(items[index], update);
  }

  return items;
}

export const untitled = 'New conversation';

/** copies the source's explicit model and effort when it ran on the same agent. */
export function createConversation(
  cwd: string,
  agent: string,
  source?: Conversation,
): Conversation {
  const stored = source?.agent === agent ? source.sessions[agent] : undefined;

  return {
    id: randomUUID(),
    title: untitled,
    cwd,
    agent,
    sessions: stored?.requestedModel
      ? {
          [agent]: {
            id: '',
            model: stored.model,
            requestedModel: stored.requestedModel,
            hasHistory: false,
            ...(stored.effort ? { effort: stored.effort } : {}),
          },
        }
      : {},
    createdAt: new Date().toISOString(),
  };
}
