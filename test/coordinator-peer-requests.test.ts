import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import type { UserRequest } from '../src/agents/types.js';
import {
  answerInstruction,
  peerRequestStatus,
} from '../src/core/peer-requests.js';
import type { PeerRequest } from '../src/core/peer-requests.js';
import { untitled } from '../src/core/state.js';
import { CoordinationStore } from '../src/persistence/coordination.js';
import { callControl } from '../src/persistence/control.js';
import { identifyProcess } from '../src/persistence/process.js';
import { TurnGate } from './fixtures/agent.js';
import { coordinationFixture, git } from './fixtures/coordination.js';
import { readRecord } from './fixtures/coordinator.js';
import { until } from './fixtures/within.js';
import type { Client, Fixture } from './fixtures/coordinator-peer-requests.js';
import {
  answerTurns,
  ask,
  claimed,
  listed,
  notice,
  owners,
  refreshed,
  secret,
  settled,
  stored,
} from './fixtures/coordinator-peer-requests.js';

const prompts = (client: Client) =>
  client.a.inputs.map(({ prompt, author }) => (author ? 'answer' : prompt));

/** the request reached B, which stays held through another refresh. */
async function holds(
  f: Fixture,
  b: Client,
  request: PeerRequest,
  seen: { answering: boolean },
) {
  await refreshed(b);

  assert.ok(notice(b, `peer-request/${request.id}`));

  await refreshed(b);

  assert.equal((await stored(f, request)).attemptedAt, undefined);

  assert.equal(seen.answering, false);
}

test('answer process registration preserves the owner identity and ignores reports after close', async (t) => {
  const { f, b } = await owners(t.onTestFinished);
  const helper = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  const id = b.coordinator.snapshot.conversation!.id;
  const report = b.a.sessions[0]!.options.onAnswerProcess!;

  try {
    const before = await readRecord(f.root, id);

    assert.ok(before.process);

    assert.notEqual(helper.pid, before.process.pid);

    await report(helper.pid);

    const registered = await readRecord(f.root, id);

    assert.deepEqual(
      registered.answerProcess,
      await identifyProcess(helper.pid!),
    );

    assert.deepEqual(registered.process, before.process);

    await report(undefined);

    const cleared = await readRecord(f.root, id);

    assert.equal(cleared.answerProcess, undefined);

    assert.deepEqual(cleared.process, before.process);

    await b.coordinator.close();

    await report(helper.pid);

    assert.equal((await readRecord(f.root, id)).answerProcess, undefined);
  } finally {
    await report(undefined);

    const closed = once(helper, 'close');

    helper.kill('SIGKILL');

    await closed;
  }
});

test('idle owner answers in one attributed turn', async (t) => {
  const { f, a, b, claim } = await owners(t.onTestFinished);
  let supplied: PeerRequest[] = [];

  b.a.peerReply = (requests) => {
    supplied = requests;

    return JSON.stringify({
      answers: requests.map(({ id }) => ({
        id,
        message: `Port 4000 ${secret}`,
      })),
    });
  };

  const request = await ask(a, claim, `Which port? ${secret}`);

  await refreshed(b);

  await until('answer turn', () => answerTurns(b).length === 1 && settled(b));

  const [input] = answerTurns(b);

  assert.equal(input!.prompt, answerInstruction);

  assert.ok(
    input!.context!.includes(JSON.stringify(input!.answer!.requestFile)),
  );

  assert.equal(supplied[0]!.id, request.id);

  assert.equal(supplied[0]!.message, `Which port? ${secret}`);

  await assert.rejects(access(input!.answer!.requestFile), { code: 'ENOENT' });

  assert.equal(
    b.coordinator.snapshot.conversation!.sessions.a!.deliveredRevision,
    undefined,
  );

  assert.ok(input!.context!.includes(request.id));

  for (const absent of [
    secret,
    "To ask the owner of another session's claimed task",
    'Before starting a new task',
    'Save only new lasting',
    'Record a temporary execution hold',
    'Selection turn:',
  ])
    assert.ok(!input!.context!.includes(absent), absent);

  assert.match(input!.context!, /Read their messages from /);

  const items = b.coordinator.snapshot.items;

  assert.deepEqual(
    items.filter(({ kind }) => kind === 'user'),
    [],
  );

  assert.ok(
    items.some(
      ({ kind, text }) =>
        kind === 'notice' &&
        text === `Witch started a turn to answer peer request ${request.id}.`,
    ),
  );

  assert.equal(b.coordinator.snapshot.completedTurn, undefined);

  assert.equal(b.coordinator.snapshot.conversation!.title, untitled);

  const asker = a.coordinator.snapshot.conversation!.id;
  const owner = b.coordinator.snapshot.conversation!.id;

  assert.notEqual(asker, owner);

  assert.ok(
    notice(b, `peer-request/${request.id}`)!.text.startsWith(
      `Peer request ${request.id} from session ${asker} about task:b-work: Which port?`,
    ),
  );

  assert.equal(
    (await stored(f, request)).answer?.message,
    `Port 4000 ${secret}`,
  );

  await refreshed(a);

  assert.equal(
    notice(a, `peer-answer/${request.id}`)!.text,
    `Answer to peer request ${request.id} from session ${owner} about task:b-work: Port 4000 ${secret}`,
  );

  assert.equal(a.a.inputs.length, 0);

  await a.coordinator.send('next');

  assert.deepEqual(listed(a.a.inputs.at(-1)!.context), [request.id]);

  assert.ok(!a.a.inputs.at(-1)!.context!.includes(secret));

  await a.coordinator.send('after');

  assert.ok(!a.a.inputs.at(-1)!.context!.includes(request.id));

  await b.coordinator.send('owner work');

  const user = b.a.inputs.at(-1)!;

  assert.match(user.context!, /Accepted shared memory/);

  assert.equal(user.author, undefined);

  assert.deepEqual(listed(user.context), [request.id]);

  for (const present of [
    "To ask the owner of another session's claimed task",
    'Before starting a new task',
    'Save only new lasting',
    'Record a temporary execution hold',
  ])
    assert.ok(user.context!.includes(present), present);

  assert.equal(b.coordinator.snapshot.conversation!.title, 'owner work');

  assert.ok(b.coordinator.snapshot.completedTurn);
});

test('a delivery hold taken during admission still runs the admitted answer turn', async (t) => {
  const { f, a, b, claim } = await owners(t.onTestFinished);
  const begin = b.coordination.beginAnswer.bind(b.coordination);
  let release: (() => void) | undefined;

  b.coordination.beginAnswer = () => {
    release = b.coordinator.holdPromptDelivery();

    return begin();
  };

  const request = await ask(a, claim, 'Held?');

  await refreshed(b);

  await until('answer turn', () => answerTurns(b).length === 1 && settled(b));

  assert.ok(answerTurns(b)[0]!.context!.includes(request.id));

  assert.ok((await stored(f, request)).attemptedAt);

  release!();
});

test('pending requests to one owner coalesce into one answer turn', async (t) => {
  const { f, a, b, claim } = await owners(t.onTestFinished);

  b.a.peerReply = (requests) =>
    JSON.stringify({
      answers: requests.map(({ id, message }) => ({
        id,
        message: message === 'First?' ? 'Answer one' : 'Answer two',
      })),
    });

  const gate = new TurnGate();

  b.a.gate = gate;

  const working = b.coordinator.send('working');

  await gate.entered;

  const first = await ask(a, claim, 'First?');
  const second = await ask(a, claim, 'Second?');

  await refreshed(b);

  assert.deepEqual(answerTurns(b), []);

  gate.open();

  await working;

  await until('answer turn', () => answerTurns(b).length === 1 && settled(b));

  const [input] = answerTurns(b);

  assert.ok(input!.context!.includes(first.id));

  assert.ok(input!.context!.includes(second.id));

  assert.equal((await stored(f, first)).answer?.message, 'Answer one');

  assert.equal((await stored(f, second)).answer?.message, 'Answer two');

  assert.ok(
    b.coordinator.snapshot.items.some(
      ({ text }) =>
        text ===
        `Witch started a turn to answer peer requests ${first.id}, ${second.id}.`,
    ),
  );

  await refreshed(b);

  assert.equal(answerTurns(b).length, 1);
});

test('busy owner answers after queued prompts', async (t) => {
  const { a, b, claim } = await owners(t.onTestFinished);
  const gate = new TurnGate();

  b.a.gate = gate;

  b.a.refuseSteer = true;

  const sends = [b.coordinator.send('one')];

  await gate.entered;

  sends.push(b.coordinator.send('two'), b.coordinator.send('three'));

  await until('queued', () => b.coordinator.snapshot.queue.length === 2);

  await ask(a, claim, 'Which branch?');

  await refreshed(b);

  gate.open();

  await Promise.all(sends);

  await until('answer turn', () => answerTurns(b).length === 1 && settled(b));

  assert.deepEqual(prompts(b), ['one', 'two\nthree', 'answer']);
});

test('recovery, pending questions and failed turns hold answer turns until resolved', async (t) => {
  const { f, a, b, claim, seen } = await owners(
    t.onTestFinished,
    undefined,
    coordinationFixture,
  );

  b.a.interruptNext = true;

  await b.coordinator.send('remember-port');

  assert.equal(b.coordinator.snapshot.phase, 'recovery');

  await holds(f, b, await ask(a, claim, 'During recovery?'), seen);

  await b.coordinator.recoverMemory('accept');

  await until(
    'answer after recovery',
    () => answerTurns(b).length === 1 && settled(b),
  );

  seen.answering = false;

  const question: UserRequest = {
    id: 'question',
    kind: 'question',
    title: 'Questions',
    detail: '',
    questions: [{ id: 'target', title: 'Which target?', options: ['A'] }],
    replyAsPrompt: true,
  };

  b.a.sessions.at(-1)!.options.onEvent({ type: 'request', request: question });

  await holds(f, b, await ask(a, claim, 'During a question?'), seen);

  await b.coordinator.respond('question', { decision: 'decline' });

  await refreshed(b);

  await until(
    'answer after the question',
    () => answerTurns(b).length === 2 && settled(b),
  );

  seen.answering = false;

  b.a.failNext = true;

  await b.coordinator.send('fails');

  await holds(f, b, await ask(a, claim, 'After a failure?'), seen);

  await b.coordinator.send('next');

  await until(
    'answer after the next send',
    () => answerTurns(b).length === 3 && settled(b),
  );

  assert.deepEqual(prompts(b).slice(-3), ['fails', 'next', 'answer']);
});

test('released claim is never admitted, and a prompt sent meanwhile still runs', async (t) => {
  const { f, a, b, claim } = await owners(t.onTestFinished);
  const request = await ask(a, claim, 'Still yours?');
  const attempt = CoordinationStore.prototype.attemptPeerRequests;
  const admission = Promise.withResolvers<void>();
  let admitting = false;
  const results: ReturnType<typeof attempt>[] = [];

  vi.spyOn(
    CoordinationStore.prototype,
    'attemptPeerRequests',
  ).mockImplementation(async function (this: CoordinationStore, ...args) {
    admitting = true;

    await f.registry.release(
      claim.owner,
      claim.id,
      Date.now() + 5000,
      async () => {},
    );

    await admission.promise;

    const result = attempt.apply(this, args);

    results.push(result);

    return result;
  });

  await refreshed(b);

  await until('admission', () => admitting);

  const sent = b.coordinator.send('sent during admission');

  admission.resolve();

  await sent;

  await until('user turn', () => prompts(b).length === 1 && settled(b));

  assert.deepEqual((await results[0]!).attempted, []);

  assert.equal((await stored(f, request)).attemptedAt, undefined);

  assert.deepEqual(prompts(b), ['sent during admission']);

  assert.deepEqual(b.coordinator.snapshot.queue, []);
});

test('interrupted answer turn is not retried, and Escape holds answer turns', async (t) => {
  const { f, a, b, claim, seen } = await owners(t.onTestFinished);
  const gate = new TurnGate();

  b.a.gate = gate;

  const working = b.coordinator.send('working');

  await gate.entered;

  const waiting = await ask(a, claim, 'While working?');

  await refreshed(b);

  await b.coordinator.interrupt();

  // an answer turn the hold failed to stop runs through and is seen
  gate.open();

  await working;

  await holds(f, b, waiting, seen);

  await b.coordinator.send('continue');

  await until(
    'answer after the send',
    () => answerTurns(b).length === 1 && settled(b),
  );

  assert.deepEqual(prompts(b), ['working', 'continue', 'answer']);

  const answering = new TurnGate();

  b.a.gate = answering;

  const interrupted = await ask(a, claim, 'Interrupted?');

  await refreshed(b);

  await answering.entered;

  await b.coordinator.interrupt();

  await until('owner settled', () => settled(b));

  await assert.rejects(access(answerTurns(b)[1]!.answer!.requestFile), {
    code: 'ENOENT',
  });

  b.a.gate = undefined;

  seen.answering = false;

  await holds(f, b, await ask(a, claim, 'Later?'), seen);

  assert.equal(answerTurns(b).length, 2);

  const status = await callControl(await a.binding(), {
    kind: 'peer-request',
    request: interrupted.id,
  });

  assert.equal(status.kind === 'peer-request' && status.status, 'attempted');

  await b.coordinator.newConversation();

  const fresh = await ask(a, await claimed(b, 'b-next'), 'New conversation?');

  await refreshed(b);

  await until(
    'answer in the new conversation',
    () => answerTurns(b).length === 3 && settled(b),
  );

  assert.ok(answerTurns(b)[2]!.context!.includes(fresh.id));
});

test('a restart clears the hold but not the attempt', async (t) => {
  const { f, a, b, claim } = await owners(t.onTestFinished);
  const gate = new TurnGate();

  b.a.gate = gate;

  const first = await ask(a, claim, 'First?');

  await refreshed(b);

  await gate.entered;

  await b.coordinator.interrupt();

  await until('owner settled', () => settled(b));

  const second = await ask(a, claim, 'Second?');
  const conversation = b.coordinator.snapshot.conversation!.id;

  await b.coordinator.close({ restart: true });

  const restarted = await f.start('B', { conversation });

  await refreshed(restarted);

  await until(
    'answer after restart',
    () => answerTurns(restarted).length === 1 && settled(restarted),
  );

  const context = answerTurns(restarted)[0]!.context!;

  assert.ok(context.includes(second.id));

  assert.ok(!context.includes(first.id));
});

test('a restored queue holds answer turns until the composer takes it, which wakes them', async (t) => {
  const { f, a, b, claim } = await owners(t.onTestFinished);
  const gate = new TurnGate();

  b.a.gate = gate;

  b.a.refuseSteer = true;

  const sending = b.coordinator.send('Start');

  sending.catch(() => {});

  await gate.entered;

  await b.coordinator.send('held');

  const conversation = b.coordinator.snapshot.conversation!.id;

  await b.coordinator.close({ restart: true });

  gate.open();

  const restarted = await f.start('B', { conversation });

  assert.deepEqual(restarted.coordinator.snapshot.queue, ['held']);

  const seen = { answering: false };

  restarted.coordinator.subscribe(() => {
    if (restarted.coordinator.snapshot.answering) seen.answering = true;
  });

  await holds(f, restarted, await ask(a, claim, 'After a restart?'), seen);

  // no refresh follows, so only taking the queue can start the answer
  restarted.coordinator.unqueue('held');

  await until(
    'answer after the queue is taken',
    () => answerTurns(restarted).length === 1 && settled(restarted),
  );
});

test('a closing Witch stamps nothing', async (t) => {
  const { f, a, b, claim } = await owners(t.onTestFinished);
  const request = await ask(a, claim, 'Before you go?');
  const attempt = CoordinationStore.prototype.attemptPeerRequests;
  let closing: Promise<void> | undefined;
  let admitted: Promise<string> | undefined;

  vi.spyOn(
    CoordinationStore.prototype,
    'attemptPeerRequests',
  ).mockImplementation(function (this: CoordinationStore, ...args) {
    closing ??= b.coordinator.close();

    const result = attempt.apply(this, args);

    admitted = result.then(
      () => 'admitted',
      (error: Error) => error.message,
    );

    return result;
  });

  const begin = b.coordination.beginAnswer;
  const admissions: Promise<PeerRequest[]>[] = [];

  vi.spyOn(b.coordination, 'beginAnswer').mockImplementation(function (
    this: typeof b.coordination,
  ) {
    const result = begin.call(this);

    admissions.push(result);

    return result;
  });

  // the admission closes B, so this refresh's own activation check rejects
  await refreshed(b).catch(() => {});

  await until('admission', () => admitted !== undefined);

  assert.equal(
    await admitted,
    'This control activation is no longer current. Use the prefix from the current Witch context.',
  );

  assert.deepEqual(await admissions[0], []);

  await closing;

  const after = await stored(f, request);

  assert.equal(after.attemptedAt, undefined);

  assert.equal(
    peerRequestStatus(after, await f.registry.claims()),
    'undeliverable',
  );

  assert.deepEqual(b.a.inputs, []);
});

test('an origin change during admission stamps nothing', async (t) => {
  const { f, a, b, claim, refreshes } = await owners(t.onTestFinished);
  const attempt = CoordinationStore.prototype.attemptPeerRequests;
  const admission = Promise.withResolvers<void>();
  let admitting = false;

  vi.spyOn(
    CoordinationStore.prototype,
    'attemptPeerRequests',
  ).mockImplementation(async function (this: CoordinationStore, ...args) {
    admitting = true;

    await admission.promise;

    return attempt.apply(this, args);
  });

  const request = await ask(a, claim, 'Same project?');

  await refreshed(b);

  await until('admission', () => admitting);

  await git(
    '-C',
    join(f.root, 'B'),
    'remote',
    'set-url',
    'origin',
    join(f.root, 'other'),
  );

  const owner = b.coordinator.snapshot.conversation!.id;

  await until('project change', async () => {
    for (const refresh of refreshes) refresh();

    return (await f.registry.presences()).some(
      ({ id, project }) => id === owner && project !== claim.owner.project,
    );
  });

  admission.resolve();

  await until('owner settled', () => settled(b));

  assert.equal((await stored(f, request)).attemptedAt, undefined);

  assert.deepEqual(answerTurns(b), []);
});

test('a prompt sent during an answer turn runs as its own turn after it', async (t) => {
  const { a, b, claim } = await owners(t.onTestFinished);
  const completed = new Set<string>();

  b.coordinator.subscribe(() => {
    const id = b.coordinator.snapshot.completedTurn;

    if (id) completed.add(id);
  });

  const attempt = CoordinationStore.prototype.attemptPeerRequests;
  const admission = Promise.withResolvers<void>();
  let admitting = false;

  const spy = vi
    .spyOn(CoordinationStore.prototype, 'attemptPeerRequests')
    .mockImplementation(async function (this: CoordinationStore, ...args) {
      admitting = true;

      await admission.promise;

      return attempt.apply(this, args);
    });

  await ask(a, claim, 'During admission?');

  await refreshed(b);

  await until('admission', () => admitting);

  const duringAdmission = b.coordinator.send('sent during admission');

  admission.resolve();

  await duringAdmission;

  spy.mockRestore();

  await until('user turn', () => prompts(b).length === 2 && settled(b));

  assert.deepEqual(prompts(b), ['answer', 'sent during admission']);

  const gate = new TurnGate();

  b.a.gate = gate;

  await ask(a, claim, 'During the turn?');

  await refreshed(b);

  await gate.entered;

  const duringTurn = b.coordinator.send('sent during answer');

  await until('queued', () => b.coordinator.snapshot.queue.length === 1);

  assert.deepEqual(b.a.steers, []);

  gate.open();

  await duringTurn;

  await until('user turn', () => prompts(b).length === 4 && settled(b));

  assert.deepEqual(prompts(b).slice(2), ['answer', 'sent during answer']);

  assert.deepEqual(
    b.coordinator.snapshot.items
      .filter(({ kind }) => kind === 'user')
      .map(({ text }) => text),
    ['sent during admission', 'sent during answer'],
  );

  assert.equal(completed.size, 2);

  const base = new TurnGate();

  b.a.gate = base;

  const working = b.coordinator.send('base');

  await base.entered;

  await ask(a, claim, 'During a steer?');

  await refreshed(b);

  const session = b.a.sessions.at(-1)!.session;
  const steer = session.steer;
  const steering = Promise.withResolvers<void>();

  session.steer = async () => {
    await steering.promise;

    return false;
  };

  const steered = b.coordinator.send('steered');

  base.open();

  await working;

  await until('owner idle', () => b.coordinator.snapshot.phase === 'idle');

  steering.resolve();

  await steered;

  session.steer = steer;

  await until('steered turn', () => prompts(b).length === 7 && settled(b));

  assert.deepEqual(prompts(b).slice(4), ['base', 'steered', 'answer']);

  assert.deepEqual(b.coordinator.snapshot.queue, []);

  const failing = new TurnGate();

  b.a.gate = failing;

  b.a.failNext = true;

  await ask(a, claim, 'Fails?');

  await refreshed(b);

  await failing.entered;

  const kept = b.coordinator.send('after failure');

  await until('queued', () => b.coordinator.snapshot.queue.length === 1);

  failing.open();

  await kept;

  await until('owner settled', () => settled(b));

  assert.deepEqual(b.coordinator.snapshot.queue, ['after failure']);

  assert.ok(!prompts(b).includes('after failure'));
});
