import { boundCommandTitle, toolTitle } from '../tool-title.js';
import type { CommandPrefixes, ToolTitle } from '../tool-title.js';

/** Witch's names for the Claude tools that run a spell or start a familiar. */
const claudeNames = new Map([
  ['Skill', 'Spell'],
  ['Agent', 'Familiar'],
]);

/** a Claude tool's title under Witch's name for it, where it has one. */
export function claudeTitle(
  name: string,
  input: unknown,
  cwd: string,
  prefixes?: CommandPrefixes,
): ToolTitle {
  if (
    name === 'Bash' &&
    input &&
    typeof input === 'object' &&
    'command' in input &&
    typeof input.command === 'string'
  ) {
    const bound = boundCommandTitle(input.command, prefixes);

    if (bound)
      return {
        ...bound,
        expandedTitle: `Bash  $ ${input.command}`,
        command: true,
      };
  }

  if (name === 'Bash') return { ...toolTitle(name, input, cwd), command: true };

  const witch = claudeNames.get(name);

  if (!witch) return toolTitle(name, input, cwd);

  return {
    ...toolTitle(witch, input, cwd),
    expandedTitle: toolTitle(`${witch} (${name})`, input, cwd).title,
  };
}
