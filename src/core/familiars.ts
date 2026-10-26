import { randomUUID } from 'node:crypto';
import type { BackgroundCommand, Subagent } from '../agents/types.js';
import type { TimedSubagent } from './snapshot.js';

export function familiarIdentity(subagent: Subagent): string {
  return [subagent.runtime, subagent.model].filter(Boolean).join(' · ');
}

/** late native identity updates retitle the existing rows without losing the report. */
export function updateFamiliar(
  previous: TimedSubagent | undefined,
  subagent: Subagent,
):
  | {
      entry: TimedSubagent;
      rows: { id: string; title: string[]; text?: string }[];
    }
  | undefined {
  if (!previous && subagent.status !== 'running') return;
  const running = subagent.status === 'running';
  const started =
    running &&
    (previous?.status !== 'running' || previous.run !== subagent.run);
  const ended = !running && previous?.status === 'running';
  const rows = started
    ? { start: randomUUID() }
    : { ...previous!.rows, ...(ended ? { end: randomUUID() } : {}) };
  const renamed =
    !started &&
    (subagent.name !== previous!.name ||
      subagent.kind !== previous!.kind ||
      familiarIdentity(subagent) !== familiarIdentity(previous!));
  return {
    entry: {
      ...subagent,
      startedAt: started ? Date.now() : previous!.startedAt,
      rows,
    },
    rows: [
      ...(started || renamed
        ? [
            {
              id: rows.start,
              title: [
                'Familiar started',
                subagent.name,
                subagent.kind,
                familiarIdentity(subagent),
              ],
            },
          ]
        : []),
      ...(rows.end && (ended || renamed)
        ? [
            {
              id: rows.end,
              title: [
                `Familiar ${subagent.status}`,
                subagent.name,
                familiarIdentity(subagent),
                subagent.tools
                  ? `${subagent.tools} tool${subagent.tools === 1 ? '' : 's'}`
                  : '',
              ],
              text: ended ? (subagent.report ?? '') : '',
            },
          ]
        : []),
    ],
  };
}

/** a familiar's command leaves the brew list, which tracks only running native background commands. */
export function updateBrew(
  commands: readonly BackgroundCommand[],
  command: BackgroundCommand,
): { commands: BackgroundCommand[]; rows: { title: string[] }[] } | undefined {
  const listed = commands.some(({ id }) => id === command.id);
  const without = commands.filter(({ id }) => id !== command.id);
  if (command.familiar)
    return listed
      ? {
          commands: without,
          rows: [{ title: ['Brew became familiar', command.description] }],
        }
      : undefined;
  const running = command.status === 'running';
  if (running === listed) return;
  return {
    commands: running ? [...commands, command] : without,
    rows: [
      {
        title: [
          `Brew ${running ? 'started' : command.status}`,
          command.description,
        ],
      },
    ],
  };
}
