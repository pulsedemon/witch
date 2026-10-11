import { z } from 'zod';

const session = z.object({
  id: z.string(),
  model: z.string(),
  requestedModel: z.string().optional(),
  hasHistory: z.boolean().default(false),
  effort: z.string().optional(),
  deliveredRevision: z.string().optional(),
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

export const appDataSchema = z.object({
  version: z.literal(1),
  activeId: z.string().optional(),
  conversations: z.array(conversationSchema),
  process: z.object({ pid: z.number(), started: z.string() }).optional(),
  activity: z
    .object({
      id: z.string(),
      conversationId: z.string(),
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
});

export type Conversation = z.infer<typeof conversationSchema>;
export type AppData = z.infer<typeof appDataSchema>;
export type DisplayUpdate = z.infer<typeof displayUpdateSchema>;
export type DisplayItem = Omit<DisplayUpdate, 'replace'>;

export function applyDisplayUpdate(
  items: readonly DisplayItem[],
  update: DisplayUpdate,
): DisplayItem[] {
  const index = items.findIndex((item) => item.id === update.id);
  if (index < 0) return [...items, { ...update }];
  const previous = items[index]!;
  const next = [...items];
  next[index] = {
    ...previous,
    ...update,
    title: update.title || previous.title,
    text: update.replace ? update.text : previous.text + update.text,
  };
  return next;
}
