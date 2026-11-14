import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { writeControl } from '../../../src/cli/cli-control.js';
import type { SessionPresence } from '../../../src/core/coordination/coordination-state.js';
import { CoordinationStore } from '../../../src/persistence/coordination.js';
import { callControl } from '../../../src/persistence/control.js';
import type { ControlOutcome } from '../../../src/persistence/control.js';
import {
  unitCoordinationFixture,
  pauseDiscovery,
} from '../../fixtures/coordination.js';
import { orderedCleanup } from '../../fixtures/cleanup.js';

type Client = Awaited<
  ReturnType<Awaited<ReturnType<typeof unitCoordinationFixture>>['start']>
>;

async function claimed(client: Client, name: string) {
  const result = await client.claim(`task:${name}`, `${name} work`);

  if (result.kind !== 'claimed') assert.fail(JSON.stringify(result));

  return result.claim;
}

async function ask(client: Client, claim: string, message: string) {
  return callControl(await client.binding(), { kind: 'ask', claim, message });
}

async function read(client: Client, request: string) {
  return callControl(await client.binding(), {
    kind: 'peer-request',
    request,
  });
}

function described(outcome: ControlOutcome): string {
  const write = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation(() => true);

  try {
    assert.equal(writeControl(outcome, false), 0);

    return String(write.mock.calls[0]![0]);
  } finally {
    write.mockRestore();
  }
}

test('asks need a live same-project owner that supports requests', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  pauseDiscovery(vi.spyOn);

  const publish = CoordinationStore.prototype.publish;

  // B's presence comes from a Witch built before peer requests
  vi.spyOn(CoordinationStore.prototype, 'publish').mockImplementation(function (
    this: CoordinationStore,
    presence: SessionPresence,
  ) {
    const older = { ...presence };

    if (presence.cwd.endsWith('/B')) delete older.peerRequests;

    return publish.call(this, older);
  });

  const { start, registry } = await unitCoordinationFixture(cleanup);

  const a = await start(),
    b = await start('B'),
    c = await start('C');

  const own = await claimed(a, 'a');
  const older = await claimed(b, 'b');
  const elsewhere = await claimed(c, 'c');
  const unknown = '00000000-0000-4000-8000-000000000000';

  for (const [claim, message] of [
    [
      unknown,
      `No session claims ${unknown}. Query --peers --json for claim ids.`,
    ],
    [own.id, 'This conversation owns that claim.'],
    [
      older.id,
      "The owner's Witch does not support peer requests yet; ask your user to restart that Witch onto a current build.",
    ],
    [
      elsewhere.id,
      `The owner of ${elsewhere.id} is not a live session in this project.`,
    ],
  ] as const) {
    const result = await ask(a, claim, 'Which port?');

    assert.equal(result.kind, 'error', JSON.stringify(result));

    if (result.kind === 'error') assert.equal(result.message, message);
  }

  const conversation = a.coordinator.snapshot.conversation!.id;

  for (const project of new Set(
    [own, elsewhere].map(({ owner }) => owner.project),
  ))
    assert.deepEqual(await registry.peerRequests(project, conversation), []);
});

test('a repeated ask returns the pending request', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  pauseDiscovery(vi.spyOn);

  const { start, registry } = await unitCoordinationFixture(cleanup);

  const a = await start(),
    b = await start('B');

  const owned = await claimed(b, 'b');
  const first = await ask(a, owned.id, 'Which port?');
  const again = await ask(a, owned.id, ' Which port? ');

  if (first.kind !== 'peer-request' || again.kind !== 'peer-request')
    assert.fail(JSON.stringify([first, again]));

  assert.equal(first.status, 'pending');

  assert.deepEqual(again, { ...first, id: again.id });

  const recipient = b.coordinator.snapshot.conversation!.id;

  await registry.attemptPeerRequests(
    owned.owner.project,
    recipient,
    Date.now() + 5000,
    async () => {},
  );

  const attempted = await ask(a, owned.id, 'Which port?');

  if (attempted.kind !== 'peer-request') assert.fail(JSON.stringify(attempted));

  assert.equal(attempted.request.id, first.request.id);

  assert.equal(attempted.status, 'attempted');

  const other = await ask(a, owned.id, 'Which branch?');

  if (other.kind !== 'peer-request') assert.fail(JSON.stringify(other));

  assert.notEqual(other.request.id, first.request.id);

  assert.equal(
    (await registry.peerRequests(owned.owner.project, recipient)).length,
    2,
  );
});

test('only the parties read a request', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  pauseDiscovery(vi.spyOn);

  const { start, registry } = await unitCoordinationFixture(cleanup);

  const a = await start(),
    b = await start('B'),
    third = await start();

  const owned = await claimed(b, 'b');
  const asked = await ask(a, owned.id, 'Which port?');

  if (asked.kind !== 'peer-request') assert.fail(JSON.stringify(asked));

  const { id } = asked.request;
  const refused = await read(third, id);

  assert.equal(refused.kind, 'error', JSON.stringify(refused));

  if (refused.kind === 'error')
    assert.equal(
      refused.message,
      `Peer request ${id} was not sent to or by this conversation.`,
    );

  const answered = await callControl(await a.binding(), {
    kind: 'answer',
    request: id,
    message: 'mine',
  });

  assert.equal(answered.kind, 'error', JSON.stringify(answered));

  await registry.attemptPeerRequests(
    owned.owner.project,
    b.coordinator.snapshot.conversation!.id,
    Date.now() + 5000,
    async () => {},
  );

  const waiting = await ask(a, owned.id, 'Which branch?');

  if (waiting.kind !== 'peer-request') assert.fail(JSON.stringify(waiting));

  const attempted = await read(b, id);

  assert.equal(
    described(attempted).split('\n')[2],
    "The owner's Witch took this request for its one answer turn; no answer is recorded yet.",
  );

  const answer = await callControl(await b.binding(), {
    kind: 'answer',
    request: id,
    message: 'Port 4000',
  });

  if (answer.kind !== 'peer-request') assert.fail(JSON.stringify(answer));

  assert.equal(answer.status, 'answered');

  assert.deepEqual(described(await read(a, id)).split('\n'), [
    `Peer request ${id} from ${asked.request.from} to ${asked.request.to} about ${asked.request.reference}: answered`,
    'Request: Which port?',
    'Answer: Port 4000',
    '',
  ]);

  assert.equal(
    (await callControl(await b.binding(), { kind: 'release', claim: owned.id }))
      .kind,
    'released',
  );

  const late = await read(a, waiting.request.id);

  if (late.kind !== 'peer-request') assert.fail(JSON.stringify(late));

  assert.equal(late.status, 'undeliverable');

  assert.equal(
    described(late).split('\n')[2],
    'The owner no longer holds that claim.',
  );
});
