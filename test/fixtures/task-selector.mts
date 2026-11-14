import { randomUUID } from 'node:crypto';
import { CoordinationStore } from '../../src/persistence/coordination.js';
import { StateStore } from '../../src/persistence/store.js';
import { identifyProcess } from '../../src/persistence/process.js';

const [root, conversation] = process.argv.slice(2);
const store = await CoordinationStore.open(await StateStore.open(root!));

const scope = {
  owner: { conversation: conversation!, project: 'project-p' },
  activation: randomUUID(),
  turn: randomUUID(),
};

const release = await store.holdActivation(scope.activation);
const identity = (await identifyProcess(process.pid))!;
let ticket: string;

// keep the activation lock reachable until the child exits.
setTimeout(() => {
  void release();

  process.exit(1);
}, 30_000);

process.on('message', (message: { kind: string; issue?: number }) => {
  void (async () => {
    const deadline = Date.now() + 5000;
    const verify = async () => {};
    let value: unknown;

    if (message.kind === 'begin') {
      const state = await store.beginSelection(scope, deadline, verify);
      ticket = state.ticket.id;
      value = state;
    } else if (message.kind === 'status') {
      value = await store.selection(scope, ticket, deadline, verify);
    } else if (message.kind === 'recommend') {
      value = await store.recommend(
        scope,
        ticket,
        {
          reference: `https://github.com/acme/queue/issues/${message.issue}`,
          summary: `Issue ${message.issue}`,
        },
        identity,
        deadline,
        verify,
      );
    } else if (message.kind === 'claim') {
      value = await store.claim(
        scope.owner,
        {
          reference: `https://github.com/acme/queue/issues/${message.issue}`,
          summary: 'Active work',
        },
        identity,
        deadline,
        verify,
      );
    }

    process.send!({ value });
  })().catch((error: unknown) => process.send!({ error: String(error) }));
});

process.send!({ ready: true });
