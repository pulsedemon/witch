import type { Skill } from '../../agents/types.js';
import { skillNamed } from '../../core/prompts.js';

const catalog = [
  { id: 'new', label: 'New conversation', takesArguments: true, leading: true },
  { id: 'sessions', label: 'Saved conversations' },
  { id: 'peers', label: 'Other sessions in this repository' },
  {
    id: 'task',
    label: 'Current task, /task release or /task take <reference>',
    takesArguments: true,
  },
  { id: 'model', label: 'Choose model and reasoning', takesArguments: true },
  {
    id: 'delegation',
    label: 'Where delegated work goes, and when usage shifts it',
    takesArguments: true,
  },
  {
    id: 'review',
    label: 'Review files in rounds Witch runs',
    takesArguments: true,
  },
  { id: 'compact', label: 'Compact the conversation' },
  { id: 'clear', label: 'Clear agent context', leading: true },
  { id: 'memory', label: 'Browse shared memory' },
  { id: 'jobs', label: 'Running jobs' },
  { id: 'help', label: 'Keyboard help' },
  {
    id: 'restart',
    label: 'Restart Witch in this conversation',
    leading: true,
  },
  { id: 'exit', label: 'Exit', aliases: ['quit'], leading: true },
] as const;

export type CommandName = (typeof catalog)[number]['id'];

export interface WitchCommand {
  name: CommandName;
  argument: string;
}

export const commands: readonly {
  id: CommandName;
  label: string;
  aliases?: readonly string[];
  takesArguments?: boolean;
  /** runs only in a message that starts with a Witch command, since a mention in prose would end or reset the session */
  leading?: true;
}[] = catalog;

const names = new Map(
  commands.flatMap((command) =>
    [command.id, ...(command.aliases ?? [])].map((name) => [name, command]),
  ),
);

/** native-leading input keeps its original boundary; backticks protect literal command names elsewhere. */
export function parseCommands(
  text: string,
  skills: readonly Skill[],
): WitchCommand[] | undefined {
  if (text.trimStart().startsWith('!')) return;

  const leadingName = /^\/(\S+)/.exec(text.trimStart())?.[1];

  if (leadingName && !names.has(leadingName) && skillNamed(leadingName, skills))
    return;

  const found: {
    command: (typeof commands)[number];
    start: number;
    end: number;
  }[] = [];

  let ticks = 0;

  for (const match of text.matchAll(/`+|\/[^\s`]+/g)) {
    const token = match[0],
      start = match.index;

    if (token.startsWith('`')) {
      if (!ticks) ticks = token.length;
      else if (token.length === ticks || (ticks >= 3 && token.length >= ticks))
        ticks = 0;

      continue;
    }

    if (
      ticks ||
      (start && !/\s/.test(text[start - 1]!)) ||
      (start + token.length < text.length &&
        !/\s/.test(text[start + token.length]!))
    )
      continue;

    const command = names.get(token.slice(1));

    if (command) found.push({ command, start, end: start + token.length });
  }

  if (!found.length) return;

  const leading = found[0]!.start === text.length - text.trimStart().length;

  const run = found.flatMap(({ command, end }, index) =>
    leading || !command.leading
      ? [
          {
            name: command.id,
            // a dropped command still ends the argument before it
            argument: command.takesArguments
              ? text.slice(end, found[index + 1]?.start).trim()
              : '',
          },
        ]
      : [],
  );

  return run.length ? run : undefined;
}

/** recovered text must not turn separate native input or a command draft into an executable Witch batch. */
export function safeQueueMerge(
  queue: readonly string[],
  draft: string,
  skills: readonly Skill[],
): boolean {
  return (
    !parseCommands(draft, skills) &&
    !parseCommands([...queue, ...(draft ? [draft] : [])].join('\n'), skills)
  );
}

export const claimedCommands = new Set(names.keys());
