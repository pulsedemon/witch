import assert from 'node:assert/strict';
import { utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import type { ClaimOwner } from '../src/core/coordination-state.js';
import { peerRequestStatus } from '../src/core/peer-requests.js';
import { CoordinationStore } from '../src/persistence/coordination.js';
import { identifyProcess } from '../src/persistence/process.js';
import { StateStore } from '../src/persistence/store.js';
import { expireAfterLock } from './fixtures/coordination.js';
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

test('batch answers validate every addressee before committing any answer', async () => {
  const [store] = await stores();
  const claimB = await claim(store!, b, 'b');
  const claimC = await claim(store!, c, 'c');
  const first = await store!.askPeer(a, claimB.id, 'first', deadline(), verify);
  const second = await store!.askPeer(
    a,
    claimB.id,
    'second',
    deadline(),
    verify,
  );
  const foreign = await store!.askPeer(
    a,
    claimC.id,
    'foreign',
    deadline(),
    verify,
  );
  await assert.rejects(
    store!.answerPeers(
      'b',
      [
        { id: first.id, message: 'first answer' },
        { id: foreign.id, message: 'wrong owner' },
      ],
      deadline(),
    ),
    /not addressed/,
  );
  assert.ok(
    (await store!.peerRequests(project, 'a')).every(
      (request) => !request.answer,
    ),
  );
  await store!.answerPeers(
    'b',
    [
      { id: second.id, message: 'second answer' },
      { id: first.id, message: 'first answer' },
    ],
    deadline(),
  );
  const stored = new Map(
    (await store!.peerRequests(project, 'a')).map((request) => [
      request.id,
      request.answer?.message,
    ]),
  );
  assert.equal(stored.get(first.id), 'first answer');
  assert.equal(stored.get(second.id), 'second answer');
  assert.equal(stored.get(foreign.id), undefined);
});

test('automatic batches preserve existing replies while validating every pending answer', async () => {
  const [store] = await stores();
  const claimB = await claim(store!, b, 'b');
  const claimC = await claim(store!, c, 'c');
  const first = await store!.askPeer(a, claimB.id, 'first', deadline(), verify);
  const second = await store!.askPeer(
    a,
    claimB.id,
    'second',
    deadline(),
    verify,
  );
  const foreign = await store!.askPeer(
    a,
    claimC.id,
    'foreign',
    deadline(),
    verify,
  );
  await store!.attemptPeerRequests(project, 'b', deadline(), verify);
  const manual = await store!.answerPeer(
    'b',
    first.id,
    'manual answer',
    deadline(),
  );
  const answers = [
    { id: first.id, message: 'automatic first' },
    { id: second.id, message: 'automatic second' },
  ];
  await assert.rejects(
    store!.answerPeers(
      'b',
      [...answers, { id: foreign.id, message: 'wrong owner' }],
      deadline(),
      true,
    ),
    /not addressed/,
  );
  assert.equal(
    (await store!.peerRequests(project, 'a')).find(
      ({ id }) => id === second.id,
    )!.answer,
    undefined,
  );
  const published = await store!.answerPeers('b', answers, deadline(), true);
  assert.deepEqual(
    published.map(({ id }) => id),
    [second.id],
  );
  const stored = new Map(
    (await store!.peerRequests(project, 'a')).map((request) => [
      request.id,
      request,
    ]),
  );
  assert.deepEqual(stored.get(first.id), manual);
  assert.equal(stored.get(second.id)!.answer?.message, 'automatic second');
  await assert.rejects(
    store!.answerPeer('b', first.id, 'replacement', deadline()),
    /already has an answer/,
  );
});

test('a repeated ask matches the asker, the claim and the text', async () => {
  const [store] = await stores();
  const claimB = await claim(store!, b, 'b');
  const claimC = await claim(store!, c, 'c');
  const ask = (sender: ClaimOwner, id: string) =>
    store!.askPeer(sender, id, 'Same?', deadline(), verify);
  const first = await ask(a, claimB.id);
  const toC = await ask(a, claimC.id);
  const fromC = await ask(c, claimB.id);
  const other = await store!.askPeer(
    a,
    claimB.id,
    'Other?',
    deadline(),
    verify,
  );
  assert.equal((await ask(a, claimB.id)).id, first.id);
  assert.equal(new Set([first.id, toC.id, fromC.id, other.id]).size, 4);
  assert.deepEqual(
    [toC, fromC].map(({ from, to }) => ({ from, to })),
    [
      { from: 'a', to: 'c' },
      { from: 'c', to: 'b' },
    ],
  );
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

test('a batch whose requests already have answers writes nothing, even past its deadline', async () => {
  const root = await scratch('witch-peer-requests-');
  const store = await CoordinationStore.open(await StateStore.open(root));
  const claimB = await claim(store!, b, 'b');
  const request = await store.askPeer(
    a,
    claimB.id,
    'first',
    deadline(),
    verify,
  );
  await store.answerPeer('b', request.id, 'manual answer', deadline());
  // backdated, so a write shows as a new mtime whatever the filesystem clock's resolution
  for (const directory of ['coordination', 'coordination/sessions'])
    await utimes(join(root, directory), 0, 0);
  const before = store.signature();
  const answers = [{ id: request.id, message: 'automatic' }];
  assert.deepEqual(await store.answerPeers('b', answers, deadline(), true), []);
  assert.equal(store.signature(), before);
  expireAfterLock();
  assert.deepEqual(await store.answerPeers('b', answers, deadline(), true), []);
});
