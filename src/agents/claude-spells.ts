import { z } from 'zod';
import type { Cast } from './types.js';

export const acknowledged = z.object({
  user_message_uuids: z.array(z.string()),
});
const skillUse = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.literal('Skill'),
  input: z.object({ skill: z.string() }),
});

/** the spells an assistant message casts through Claude's Skill tool. */
export function skillCasts(content: readonly unknown[]): Cast[] {
  return content.flatMap((block) => {
    const use = skillUse.safeParse(block).data;
    return use ? [{ id: use.id, name: use.input.skill }] : [];
  });
}
