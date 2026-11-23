import { randomUUID } from 'node:crypto';
import type { Subagent } from '../agents/types.js';
import type { TimedSubagent } from './snapshot.js';

export function familiarIdentity(subagent: Subagent): string {
  return [subagent.runtime, subagent.model].filter(Boolean).join(' · ');
}

/**
 * late native identity updates retitle the existing rows without losing the report, and a report or status that
 * changes after the end replaces the end row's text. every report repeats the familiar's notices, so only those past
 * the previous count are new.
 */
export function updateFamiliar(
  previous: TimedSubagent | undefined,
  subagent: Subagent,
):
  | {
      entry: TimedSubagent;
      rows: {
        id: string;
        title: string[];
        text?: string;
        failed?: boolean;
        replace?: boolean;
      }[];
      notices: string[];
    }
  | undefined {
  if (!previous && subagent.status !== 'running') return;

  const running = subagent.status === 'running';

  const started =
    running &&
    (previous?.status !== 'running' || previous.run !== subagent.run);

  const ended = !running && previous?.status === 'running';

  const amended =
    !running &&
    !ended &&
    (subagent.status !== previous!.status ||
      subagent.report !== previous!.report);

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
      ...(rows.end && (ended || amended || renamed)
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
              text: ended || amended ? (subagent.report ?? '') : '',
              failed: subagent.status === 'failed',
              replace: amended,
            },
          ]
        : []),
    ],
    notices: (subagent.notices ?? [])
      .slice(previous?.notices?.length ?? 0)
      .map((text) => `Familiar ${subagent.name}: ${text}`),
  };
}
