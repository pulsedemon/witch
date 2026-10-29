import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '../agents/types.js';
import type { Snapshot } from './coordinator.js';
import { updateFamiliar } from './familiars.js';
import type { DisplayUpdate } from './state.js';

type BackgroundState = Pick<Snapshot, 'subagents' | 'backgroundCommands'>;
type BackgroundEvent = Extract<AgentEvent, { type: 'subagent' | 'command' }>;

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
        ...update.notices.map((text): DisplayUpdate => ({
          id: randomUUID(),
          kind: 'notice',
          text,
          cwd,
        })),
        ...update.rows.map(({ id, title, text }) =>
          taskRow(cwd, id, title, text),
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
      taskRow(cwd, randomUUID(), [
        `Brew ${running ? 'started' : command.status}`,
        command.description,
      ]),
    ],
  };
}

function taskRow(
  cwd: string,
  id: string,
  title: string[],
  text = '',
): DisplayUpdate {
  return {
    id,
    kind: 'tool',
    title: title.filter(Boolean).join('  '),
    text,
    done: true,
    cwd,
  };
}
