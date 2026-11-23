import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '../agents/types.js';
import type { Snapshot } from './snapshot.js';
import { updateFamiliar } from './familiars.js';
import { castRow } from './spells.js';
import type { DisplayUpdate } from './state.js';

type BackgroundState = Pick<Snapshot, 'subagents' | 'backgroundCommands'>;

type BackgroundEvent = Extract<AgentEvent, { type: 'subagent' | 'command' }>;

/** the events that mark every running familiar and brew stopped once their session closes; `owned` familiars belong to Witch, not the session. */
export function stoppedActivity(
  state: BackgroundState,
  owned: (id: string) => boolean,
): BackgroundEvent[] {
  return [
    ...state.subagents
      .filter(({ id, status }) => status === 'running' && !owned(id))
      .map((subagent): BackgroundEvent => ({
        type: 'subagent',
        subagent: { ...subagent, status: 'stopped' },
      })),
    ...state.backgroundCommands.map((command): BackgroundEvent => ({
      type: 'command',
      command: { ...command, status: 'stopped' },
    })),
  ];
}

export function updateBackgroundActivity(
  state: BackgroundState,
  event: BackgroundEvent,
  cwd: string,
): { state: Partial<BackgroundState>; rows: DisplayUpdate[] } | undefined {
  if (event.type === 'subagent') {
    const index = state.subagents.findIndex(
      ({ id }) => id === event.subagent.id,
    );

    const update = updateFamiliar(state.subagents[index], event.subagent);

    if (!update) return;

    const subagents = [...state.subagents];
    subagents[index < 0 ? subagents.length : index] = update.entry;

    return {
      state: { subagents },
      rows: [
        ...(event.subagent.spells ?? []).map((cast) =>
          castRow(cast, cwd, event.subagent.name),
        ),
        ...update.notices.map((text): DisplayUpdate => ({
          id: randomUUID(),
          kind: 'notice',
          text,
          cwd,
        })),
        ...update.rows.map(({ id, title, text, failed, replace }) =>
          taskRow(cwd, id, title, text, failed, replace),
        ),
      ],
    };
  }

  const { command } = event;
  const listed = state.backgroundCommands.some(({ id }) => id === command.id);

  if (command.familiar) {
    if (!listed) return;

    return {
      state: {
        backgroundCommands: state.backgroundCommands.filter(
          ({ id }) => id !== command.id,
        ),
      },
      rows: [
        taskRow(cwd, randomUUID(), [
          'Brew became familiar',
          command.description,
        ]),
      ],
    };
  }

  const running = command.status === 'running';

  if (running === listed) return;

  return {
    state: {
      backgroundCommands: running
        ? [...state.backgroundCommands, command]
        : state.backgroundCommands.filter(({ id }) => id !== command.id),
    },
    rows: [
      taskRow(
        cwd,
        randomUUID(),
        [`Brew ${running ? 'started' : command.status}`, command.description],
        '',
        command.status === 'failed',
      ),
    ],
  };
}

function taskRow(
  cwd: string,
  id: string,
  title: string[],
  text = '',
  failed = false,
  replace = false,
): DisplayUpdate {
  return {
    id,
    kind: 'tool',
    title: title.filter(Boolean).join('  '),
    text,
    done: true,
    ...(failed ? { failed: true } : {}),
    ...(replace ? { replace: true } : {}),
    cwd,
  };
}
