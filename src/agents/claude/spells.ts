import { z } from 'zod';
import type { SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import type { Cast, Skill } from '../types.js';

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

// these native controls can diverge from Witch's history, settings, titles or compaction policy
export const textCommands = new Set([
  'clear',
  'config',
  'effort',
  'fast',
  'rename',
]);

/**
 * one entry per name, a built-in's own row for a name it shadows, since `/name` runs the built-in.
 * `bundled` names the built-ins the connect-time reload marks, then the skills the latest turn's init lists.
 */
export function skillsOf(
  commands: SlashCommand[],
  bundled: ReadonlySet<string>,
): Skill[] {
  const builtins = new Map(
    commands
      .filter((command) => command.builtin)
      .map((command) => [command.name, command]),
  );

  const listed = new Map<string, Skill>();

  for (const command of commands) {
    const builtin = builtins.has(command.name);

    const { name, description, argumentHint, aliases } =
      builtins.get(command.name) ?? command;

    if (listed.has(name)) continue;

    listed.set(name, {
      name,
      description,
      ...(argumentHint ? { argumentHint } : {}),
      ...(builtin ? { builtin: true as const } : {}),
      ...(builtin && bundled.has(name) ? { bundled: true as const } : {}),
      ...(builtin && aliases?.length ? { aliases } : {}),
      ...(builtin && textCommands.has(name)
        ? { sendAsText: true as const }
        : {}),
    });
  }

  return [...listed.values()];
}
