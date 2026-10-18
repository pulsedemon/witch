import { z } from 'zod';

const session = z.object({
  id: z.string(),
  model: z.string(),
  requestedModel: z.string().optional(),
  hasHistory: z.boolean(),
  effort: z.string().optional(),
  deliveredRevision: z.string().optional(),
  deliveredProject: z.string().optional(),
});

const conversationSchema = z.object({
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

const processIdentity = z.object({ pid: z.number(), started: z.string() });

export const conversationRecordSchema = conversationSchema.extend({
  process: processIdentity.optional(),
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

export const displayUpdateSchema = z.object({
  id: z.string(),
  kind: z.enum(['user', 'assistant', 'tool', 'notice']),
  text: z.string(),
  cwd: z.string(),
  title: z.string().optional(),
  done: z.boolean().optional(),
  replace: z.boolean().optional(),
  images: z.array(z.string()).optional(),
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

function merge(
  previous: DisplayItem | undefined,
  { replace, ...update }: DisplayUpdate,
): DisplayItem {
  if (!previous) return update;
  return {
    ...previous,
    ...update,
    title: update.title || previous.title,
    cwd: replace ? update.cwd : previous.cwd,
    text: replace ? update.text : previous.text + update.text,
  };
}

export function applyDisplayUpdate(
  items: readonly DisplayItem[],
  update: DisplayUpdate,
): DisplayItem[] {
  const index = items.findIndex((item) => item.id === update.id);
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
