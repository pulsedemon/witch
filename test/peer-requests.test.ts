import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { ClaimOwner } from '../src/core/coordination-state.js';
import { peerRequestStatus } from '../src/core/peer-requests.js';
import { CoordinationStore } from '../src/persistence/coordination.js';
import { identifyProcess } from '../src/persistence/process.js';
import { StateStore } from '../src/persistence/store.js';
import { scratch } from './fixtures/scratch.js';

const identity = (await identifyProcess(process.pid))!;
const project = 'projects/p';
const a = { conversation: 'a', project };
const b = { conversation: 'b', project };
const c = { conversation: 'c', project };
const verify = async () => {};
const deadline = () => Date.now() + 5000;

async function stores(count = 1) {
  const root = await scratch('witch-peer-requests-');
  return Promise.all(
    Array.from({ length: count }, async () =>
      CoordinationStore.open(await StateStore.open(root)),
    ),
  );
}

const claim = (store: CoordinationStore, owner: ClaimOwner, name: string) =>
  store.claim(
    owner,
    { reference: `task:${name}`, summary: name },
    identity,
    deadline(),
    verify,
  );

test('concurrent writers keep every change', async () => {
  const [one, two] = await stores(2);
  const claimB = await claim(one!, b, 'b');
  const claimC = await claim(two!, c, 'c');
  const [toB, toC, fromC] = await Promise.all([
    one!.askPeer(a, claimB.id, 'first', deadline(), verify),
    two!.askPeer(a, claimC.id, 'second', deadline(), verify),
    two!.askPeer(c, claimB.id, 'third', deadline(), verify),
  ]);
  const [attemptedB, attemptedC] = await Promise.all([
    one!.attemptPeerRequests(project, 'b', deadline(), verify),
    two!.attemptPeerRequests(project, 'c', deadline(), verify),
  ]);
  assert.deepEqual(
    attemptedB.attempted.map(({ id }) => id).sort(),
    [toB!.id, fromC!.id].sort(),
  );
  assert.deepEqual(
    attemptedC.attempted.map(({ id }) => id),
    [toC!.id],
  );
  await Promise.all([
    one!.answerPeer('b', toB!.id, 'answer one', deadline()),
    two!.answerPeer('c', toC!.id, 'answer two', deadline()),
  ]);
  const stored = new Map(
    [
      ...(await one!.peerRequests(project, 'a')),
      ...(await two!.peerRequests(project, 'c')),
    ].map((request) => [request.message, request]),
  );
  assert.equal(stored.size, 3);
  assert.equal(stored.get('first')!.answer?.message, 'answer one');
  assert.equal(stored.get('second')!.answer?.message, 'answer two');
  assert.equal(stored.get('third')!.answer, undefined);
  for (const request of stored.values()) assert.ok(request.attemptedAt);
});

test('an attempted request is not admitted again', async () => {
  const [store] = await stores();
  const owned = await claim(store!, b, 'b');
  const request = await store!.askPeer(
    a,
    owned.id,
    'question',
    deadline(),
    verify,
  );
  const first = await store!.attemptPeerRequests(
    project,
    'b',
    deadline(),
    verify,
  );
  assert.deepEqual(
    first.attempted.map(({ id }) => id),
    [request.id],
  );
  assert.deepEqual(
    (await store!.attemptPeerRequests(project, 'b', deadline(), verify))
      .attempted,
    [],
  );
  const repeated = await store!.askPeer(
    a,
    owned.id,
    ' question ',
    deadline(),
    verify,
  );
  assert.equal(repeated.id, request.id);
  assert.equal(repeated.attemptedAt, first.attempted[0]!.attemptedAt);
  assert.deepEqual(
    (await store!.attemptPeerRequests(project, 'b', deadline(), verify))
      .attempted,
    [],
  );
});

test('answers are single and addressed', async () => {
  const [store] = await stores();
  const owned = await claim(store!, b, 'b');
  const request = await store!.askPeer(
    a,
    owned.id,
    'question',
    deadline(),
    verify,
  );
  await assert.rejects(store!.answerPeer('a', request.id, 'mine', deadline()), {
    message: `Peer request ${request.id} is not addressed to this conversation.`,
  });
  await store!.answerPeer('b', request.id, 'first answer', deadline());
  await assert.rejects(
    store!.answerPeer('b', request.id, 'second answer', deadline()),
    { message: `Peer request ${request.id} already has an answer.` },
  );
  const [stored] = await store!.peerRequests(project, 'a');
  assert.equal(stored!.answer?.message, 'first answer');
});

test('status follows the claim id', async () => {
  const [store] = await stores();
  const owned = await claim(store!, b, 'b');
  const waiting = await store!.askPeer(
    a,
    owned.id,
    'waiting',
    deadline(),
    verify,
  );
  const taken = await store!.askPeer(c, owned.id, 'taken', deadline(), verify);
  assert.equal(peerRequestStatus(waiting, await store!.claims()), 'pending');
  await store!.attemptPeerRequests(project, 'b', deadline(), verify);
  const late = await store!.askPeer(a, owned.id, 'late', deadline(), verify);
  await store!.release(b, owned.id, deadline(), verify);
  const reclaimed = await claim(store!, b, 'b');
  assert.notEqual(reclaimed.id, owned.id);
  const claims = await store!.claims();
  const stored = new Map(
    (await store!.peerRequests(project, 'b')).map((request) => [
      request.id,
      request,
    ]),
  );
  assert.equal(
    peerRequestStatus(stored.get(late.id)!, claims),
    'undeliverable',
  );
  assert.equal(peerRequestStatus(stored.get(taken.id)!, claims), 'attempted');
  assert.equal(
    (await store!.askPeer(a, owned.id, 'late', deadline(), verify)).id,
    late.id,
  );
  await assert.rejects(
    store!.askPeer(a, owned.id, 'another', deadline(), verify),
    {
      message: `No session claims ${owned.id}. Query --peers --json for claim ids.`,
    },
  );
  await assert.rejects(
    store!.askPeer(b, reclaimed.id, 'self', deadline(), verify),
    { message: 'This conversation owns that claim.' },
  );
});

test('requests are isolated by project and party', async () => {
  const [store] = await stores();
  const owned = await claim(store!, b, 'b');
  const request = await store!.askPeer(
    a,
    owned.id,
    'question',
    deadline(),
    verify,
  );
  assert.deepEqual(
    (await store!.peerRequests(project, 'a')).map(({ id }) => id),
    [request.id],
  );
  assert.deepEqual(
    (await store!.peerRequests(project, 'b')).map(({ id }) => id),
    [request.id],
  );
  assert.deepEqual(await store!.peerRequests(project, 'c'), []);
  assert.deepEqual(await store!.peerRequests('projects/q', 'a'), []);
  assert.deepEqual(
    (await store!.attemptPeerRequests('projects/q', 'b', deadline(), verify))
      .attempted,
    [],
  );
});
