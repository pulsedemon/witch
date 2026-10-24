import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { callControl } from '../../src/persistence/control.js';
import { TurnGate } from './agent.js';
import type { coordinationFixture } from './coordination.js';
import { within } from './within.js';

type Client = Awaited<
  ReturnType<Awaited<ReturnType<typeof coordinationFixture>>['start']>
>;

export async function selectionTurn(t: TestContext, client: Client) {
  const gate = new TurnGate();
  client.a.gate = gate;
  const sending = client.coordinator.send('Choose the next task');
  t.after(async () => {
    gate.open();
    await sending;
  });
  await within(gate.entered, 5000, 'selection turn');
  const context = client.a.inputs.at(-1)!.context!;
  const turn = /^Selection turn: (.+)$/m.exec(context)?.[1];
  const prefix = /^Control command: (.+)$/m.exec(context)?.[1];
  assert.ok(turn);
  assert.ok(prefix);
  const binding = await client.binding();
  return {
    turn,
    prefix,
    binding,
    sending,
    async select() {
      const result = await callControl(binding, { kind: 'select-next', turn });
      if (result.kind !== 'selection') assert.fail(JSON.stringify(result));
      return result.selection;
    },
    async recommend(selection: string, issue = 17) {
      const result = await callControl(binding, {
        kind: 'recommend',
        selection,
        input: {
          reference: `https://github.com/acme/queue/issues/${issue}`,
          summary: `Issue ${issue}`,
        },
      });
      if (result.kind !== 'claimed') assert.fail(JSON.stringify(result));
      return result.claim;
    },
    async finish() {
      gate.open();
      await sending;
    },
  };
}
