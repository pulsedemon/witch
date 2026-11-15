import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '../../src/agents/types.js';
import { fixture, frameWriter, jsonLines } from './claude-adapter.js';
import { until } from './within.js';

export const state = (state: string) => ({
  type: 'system',
  subtype: 'session_state_changed',
  state,
});

export const lifecycle = (
  uuid: string,
  state: string,
  session_id?: string,
) => ({
  type: 'command_lifecycle',
  command_uuid: uuid,
  state,
  ...(session_id ? { session_id } : {}),
});

export const result = (text: string, uuids?: string[]) => ({
  type: 'result',
  result: text,
  ...(uuids ? { user_message_uuids: uuids } : {}),
});

export async function background(sessionState = true) {
  const events: AgentEvent[] = [];

  const f = await fixture((e) => events.push(e), 'background', {
    sessionState,
  });

  const emit = frameWriter(
    f.cwd,
    (name) =>
      events.some((e) => e.type === 'skills' && e.skills[0]?.name === name),
    f.child,
  );

  let completions = 0;

  const turn = f.session.send('initial').then((outcome) => {
    completions++;

    return outcome;
  });

  await until('initial input', () =>
    events.some((e) =>
      sessionState
        ? e.type === 'skills' && e.skills[0]?.name === 'result-1'
        : e.type === 'text' && e.text === 'Working.',
    ),
  );

  const inputs = async () =>
    (await jsonLines(join(f.cwd, 'inputs.jsonl'))) as SDKUserMessage[];

  // Claude Code's result names the input it answers; one naming none is a run Claude Code started on its own
  const initial = (await inputs())[0]!.uuid!;

  const steer = async (
    text: string,
    options?: Parameters<typeof f.session.steer>[1],
  ) => {
    assert.equal(await f.session.steer(text, options), true);
    let uuid = '';

    await until('steered input', async () => {
      uuid =
        (await inputs()).find((input) => input.message.content === text)
          ?.uuid ?? '';

      return !!uuid;
    });

    return uuid;
  };

  return {
    ...f,
    events,
    emit,
    turn,
    initial,
    steer,
    inputs,
    completions: () => completions,
  };
}
