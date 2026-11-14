import type { Coordinator } from '../../core/coordinator.js';
import { modelTarget } from '../../core/runtime/models.js';
import type { Picker } from './choices.js';
import { tokenCount } from '../status/status-rows.js';

interface ModelChoiceHost {
  coordinator: Coordinator;
  picker: Picker;
  /** returns to the transcript, scrolled to its end when the choice hands off to another runtime. */
  toChat(handoff: boolean): void;
}

/** `live` is the picker path's batch check; that path also asks for effort and, on a same-runtime change, the context window. */
export function chooseModel(
  { coordinator, picker, toChat }: ModelChoiceHost,
  id: string,
  effort?: string,
  live?: () => boolean,
): Promise<boolean | void> {
  const { agents, conversation, models } = coordinator.snapshot;
  const active = conversation!.agent;

  const selection = modelTarget(
    id,
    active,
    agents.map((agent) => agent.id),
    coordinator.snapshot,
  );

  const model = models.find(
    (model) => model.id === selection.id && model.agent === selection.agent,
  );

  const efforts = model?.efforts ?? [];

  const select = async (effort?: string) => {
    const windows = model?.contextWindows;

    if (live && windows && windows.default !== windows.maximum) {
      const choices = [
        {
          id: 'default',
          label: `Default (${tokenCount.format(windows.default)})`,
        },
        {
          id: 'maximum',
          label: `Maximum (${tokenCount.format(windows.maximum)})`,
        },
      ];

      if (conversation!.sessions[selection.agent]?.contextWindow === 'maximum')
        choices.reverse();

      return picker(
        `Context window for ${selection.id}`,
        choices,
        async (id) => {
          toChat(selection.agent !== active);

          await coordinator.selectModel({
            ...selection,
            effort,
            contextWindow: id === 'maximum' ? 'maximum' : 'default',
          });
        },
      );
    }

    toChat(selection.agent !== active);

    await coordinator.selectModel({ ...selection, effort });

    // a handoff can run a continuation before it resolves, so a window choice there would come too late
    if (!live || selection.agent !== active) return;

    if (!live()) return false;

    const { longContext, contextWindow = 0 } = coordinator.snapshot.usage;

    if (!longContext) return;

    return picker(
      `Context window for ${selection.id}`,
      [
        { id: longContext, label: '1M' },
        // an empty id would match the empty query and sort first
        { id: 'keep', label: `Keep ${tokenCount.format(contextWindow)}` },
      ],
      (id) =>
        id === longContext
          ? coordinator.selectModel({ agent: selection.agent, id })
          : true,
    );
  };

  if (live && efforts.length)
    return picker(
      `Reasoning for ${selection.id}`,
      [
        {
          id: '',
          label:
            selection.agent === active
              ? 'Keep current effort'
              : `Use ${agents.find((agent) => agent.id === selection.agent)!.label}'s current/default effort`,
        },
        ...efforts.map((effort) => ({ id: effort, label: effort })),
      ],
      (effort) => select(effort || undefined),
    );

  return select(effort);
}
