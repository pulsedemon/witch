import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentEvent, SessionInfo } from '../agents/types.js';

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
  'closing',
  'error',
]);

export type Phase = z.infer<typeof phaseSchema>;

export function agentWorking(phase: Phase): boolean {
  return ['starting', 'running', 'switching', 'compacting'].includes(phase);
}

export const conversationRecordSchema = conversationSchema.extend({
  lastTurn: z
    .object({
      id: z.string(),
      status: z.enum(['completed', 'interrupted', 'failed']),
    })
    .optional(),
  process: processIdentity.optional(),
  usageProcess: processIdentity.optional(),
  // the shell of a running `!` command Witch runs for Claude
  shell: processIdentity.optional(),
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
  // when Witch received the update; history from before it was recorded has none
  at: z.string().optional(),
});

export type Conversation = z.infer<typeof conversationSchema>;
export type ConversationRecord = z.infer<typeof conversationRecordSchema>;
export type ProcessIdentity = z.infer<typeof processIdentity>;
export type DisplayUpdate = z.infer<typeof displayUpdateSchema>;
export type DisplayItem = Omit<DisplayUpdate, 'replace'>;

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
    // a replacement session has seen neither the memory snapshot nor the fixed instructions
    deliveredRevision:
      previous?.id === info.id ? previous.deliveredRevision : undefined,
    deliveredInstructionsRevision:
      previous?.id === info.id
        ? previous.deliveredInstructionsRevision
        : undefined,
  };
  if (previous?.id !== info.id)
    delete conversation.sessions[agent]!.deliveredMerges;
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
