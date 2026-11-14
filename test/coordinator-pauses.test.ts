import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, vi } from 'vitest';
import type {
  CoordinationAction,
  SessionPresence,
  TaskClaim,
} from '../src/core/coordination-state.js';
import { pauseStatuses } from '../src/core/pauses.js';
import type { Pause } from '../src/core/pauses.js';
import { SessionCoordination } from '../src/core/coordination.js';
import { CoordinationStore } from '../src/persistence/coordination.js';
import { callControl } from '../src/persistence/control.js';
import { TurnGate } from './fixtures/agent.js';
import { orderedCleanup } from './fixtures/cleanup.js';
import {
  unitCoordinationFixture,
  legacyLock,
  pauseDiscovery,
} from './fixtures/coordination.js';
import { holdSettlement, record } from './fixtures/coordinator.js';
import { until } from './fixtures/within.js';

type Fixture = Awaited<ReturnType<typeof unitCoordinationFixture>>;

type Client = Awaited<ReturnType<Fixture['start']>>;

const id = (client: Client) => client.coordinator.snapshot.conversation!.id;
/** the refresh a discovery tick runs, awaited. */
const refreshed = (client: Client) => client.coordination.context();

const prompts = (client: Client) =>
  client.a.inputs.filter(({ author }) => !author).map(({ prompt }) => prompt);

const answerTurns = (client: Client) =>
  client.a.inputs.filter(({ author }) => author === 'witch');

const interrupts = (client: Client) =>
  client.a.stops.filter(({ operation }) => operation === 'interrupt').length;

const shown = (client: Client, notice: string) =>
  client.coordinator.snapshot.items.some((item) => item.id === notice);

function control(client: Client, action: CoordinationAction) {
  return client.binding().then((binding) => callControl(binding, action));
}

async function pause(client: Client, to?: string[]): Promise<Pause> {
  const result = await control(client, { kind: 'pause', to });

  if (result.kind !== 'pause') assert.fail(JSON.stringify(result));

  return result.pause;
}

async function refused(client: Client, to: string[] | undefined) {
  const result = await control(client, { kind: 'pause', to });

  if (result.kind !== 'error') assert.fail(JSON.stringify(result));

  return result.message;
}

async function statuses(f: Fixture, issued: Pause) {
  return pauseStatuses(await f.registry.pause(issued.from, issued.id));
}

/** the recipient reads the pause, stops and confirms. */
async function confirmed(f: Fixture, client: Client, issued: Pause) {
  await refreshed(client);

  await until(
    'pause confirmed',
    async () => (await statuses(f, issued))[id(client)] === 'paused',
  );
}

async function claimed(client: Client, name: string): Promise<TaskClaim> {
  const result = await client.claim(`task:${name}`, `${name} work`);

  if (result.kind !== 'claimed') assert.fail(JSON.stringify(result));

  return result.claim;
}

/** a peer request reaches the client, which starts no answer turn for it. */
async function holdsAutomatic(from: Client, client: Client, name: string) {
  const claim =
    (await client.query()).ownClaim ?? (await claimed(client, name));

  const before = answerTurns(client).length;

  const asked = await control(from, {
    kind: 'ask',
    claim: claim.id,
    message: `Still there, ${name}?`,
  });

  assert.equal(asked.kind, 'peer-request', JSON.stringify(asked));

  await refreshed(client);

  await refreshed(client);

  // an unheld session would start its answer turn within this
  await delay(500);

  assert.equal(answerTurns(client).length, before);
}

test('a pause stops and holds the sessions live when issued, and no session opened later', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  pauseDiscovery(vi.spyOn);

  const f = await unitCoordinationFixture(cleanup);

  await f.checkout('I');

  await f.checkout('D');

  const i = await f.start('I');
  const a = await f.start('A');
  const b = await f.start('B');
  const c = await f.start('C');
  const sends: Promise<void>[] = [];

  for (const [name, client] of [
    ['a', a],
    ['b', b],
  ] as const) {
    client.a.gate = new TurnGate();
    client.a.refuseSteer = true;

    sends.push(client.coordinator.send(`${name} working`));

    await client.a.gate.entered;

    sends.push(client.coordinator.send(`${name} queued`));

    await until('queued', () => client.coordinator.snapshot.queue.length === 1);
  }

  const issued = await pause(i);

  assert.deepEqual(
    issued.recipients.map(({ conversation }) => conversation).sort(),
    [id(a), id(b)].sort(),
  );

  assert.deepEqual(await statuses(f, issued), {
    [id(a)]: 'pending',
    [id(b)]: 'pending',
  });

  await confirmed(f, a, issued);

  await confirmed(f, b, issued);

  for (const [name, client] of [
    ['a', a],
    ['b', b],
  ] as const) {
    assert.equal(interrupts(client), 1);

    assert.ok(shown(client, `pause/${issued.id}`));

    client.a.gate!.open();

    await refreshed(client);

    assert.deepEqual(prompts(client), [`${name} working`]);

    assert.deepEqual(client.coordinator.snapshot.queue, [`${name} queued`]);
  }

  await holdsAutomatic(i, b, 'b-held');

  assert.equal(interrupts(c), 0);

  const d = await f.start('D');

  await d.coordinator.send('d works');

  assert.deepEqual(prompts(d), ['d works']);

  assert.equal(interrupts(d), 0);

  assert.deepEqual(
    (await f.registry.pause(id(i), issued.id)).recipients
      .map(({ conversation }) => conversation)
      .sort(),
    [id(a), id(b)].sort(),
  );

  // the user's prompt lifts A's pause and runs right after what A queued
  await a.coordinator.send('a resumes');

  await until('a resumed', () => prompts(a).length === 3);

  assert.deepEqual(prompts(a), ['a working', 'a queued', 'a resumes']);

  await until(
    'a stored as resumed',
    async () => (await statuses(f, issued))[id(a)] === 'resumed',
  );

  await refreshed(b);

  assert.deepEqual(prompts(b), ['b working']);

  assert.equal((await statuses(f, issued))[id(b)], 'paused');

  const lifted = await control(i, { kind: 'resume', pause: issued.id });

  assert.equal(lifted.kind, 'pause', JSON.stringify(lifted));

  await refreshed(b);

  await until('b released', () => prompts(b).length === 2);

  assert.equal(prompts(b)[1], 'b queued');

  await until('b answers', () => answerTurns(b).length === 1);

  assert.ok(shown(b, `pause-lifted/${issued.id}`));

  const stored = await f.registry.pause(id(i), issued.id);

  assert.deepEqual(
    Object.fromEntries(
      stored.recipients.map(({ conversation, resumedBy }) => [
        conversation,
        resumedBy,
      ]),
    ),
    { [id(a)]: 'user', [id(b)]: 'issuer' },
  );

  await Promise.all(sends);
});

test('a pause holds across switching conversations and a restart, until a prompt resumes it', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  pauseDiscovery(vi.spyOn);

  const f = await unitCoordinationFixture(cleanup);

  await f.checkout('I');

  const i = await f.start('I');
  const a = await f.start('A');
  const b = await f.start('B');
  const issued = await pause(i);

  await confirmed(f, a, issued);

  await confirmed(f, b, issued);

  const conversation = id(a);
  const other = id(b);

  // the other conversation isn't held: it answers a peer request on its own
  await a.coordinator.newConversation();

  const elsewhere = await claimed(a, 'elsewhere');

  await control(i, { kind: 'ask', claim: elsewhere.id, message: 'Free?' });

  await refreshed(a);

  await until(
    'answered elsewhere',
    () =>
      answerTurns(a).length === 1 &&
      a.coordinator.snapshot.phase === 'idle' &&
      !a.coordinator.snapshot.answering,
  );

  await a.coordinator.selectConversation(conversation);

  await refreshed(a);

  await holdsAutomatic(i, a, 'a-switched');

  // B's Witch closes; A's opens B's paused conversation straight from its own, and a prompt there resumes only B
  await b.coordinator.close();

  await a.coordinator.selectConversation(other);

  await refreshed(a);

  await holdsAutomatic(i, a, 'b-in-a');

  await a.coordinator.send('b resumes');

  await until(
    'b resumed',
    async () => (await statuses(f, issued))[other] === 'resumed',
  );

  await until(
    'b settled',
    () =>
      a.coordinator.snapshot.phase === 'idle' &&
      !a.coordinator.snapshot.answering,
  );

  await a.coordinator.selectConversation(conversation);

  await refreshed(a);

  await holdsAutomatic(i, a, 'a-again');

  await a.coordinator.close({ restart: true });

  const restarted = await f.start('A', { conversation });

  await refreshed(restarted);

  await holdsAutomatic(i, restarted, 'a-restarted');

  const stored = await f.registry.pause(id(i), issued.id);

  assert.deepEqual(stored.recipients, [
    ...issued.recipients.map((recipient) => ({
      ...recipient,
      ...stored.recipients.find(
        ({ conversation }) => conversation === recipient.conversation,
      ),
    })),
  ]);

  assert.deepEqual(pauseStatuses(stored), {
    [conversation]: 'paused',
    [other]: 'resumed',
  });

  await restarted.coordinator.send('a resumes');

  await until('a resumed', () => prompts(restarted).includes('a resumes'));

  await until(
    'a stored as resumed',
    async () => (await statuses(f, issued))[conversation] === 'resumed',
  );
});

test('a resume whose write failed is stored when the session restarts', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  pauseDiscovery(vi.spyOn);

  const f = await unitCoordinationFixture(cleanup);

  await f.checkout('I');

  const i = await f.start('I');
  const a = await f.start('A');
  const issued = await pause(i);

  await confirmed(f, a, issued);

  const conversation = id(a);

  vi.spyOn(CoordinationStore.prototype, 'resumeByUser').mockRejectedValueOnce(
    new Error('disk full'),
  );

  await a.coordinator.send('a resumes');

  await until('write failed', () =>
    (a.coordination.snapshot.error ?? '').includes('disk full'),
  );

  // no tick runs before the restart, so closing stores it
  await a.coordinator.close({ restart: true });

  assert.equal((await statuses(f, issued))[conversation], 'resumed');

  const restarted = await f.start('A', { conversation });

  await refreshed(restarted);

  const claim = await claimed(restarted, 'after-restart');

  await control(i, { kind: 'ask', claim: claim.id, message: 'Back?' });

  await refreshed(restarted);

  await until('answer turn', () => answerTurns(restarted).length === 1);
});

test('a failed resume write retries on the tick while the prompt is delivered once', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const ticks = pauseDiscovery(vi.spyOn);
  const f = await unitCoordinationFixture(cleanup);

  await f.checkout('I');

  const i = await f.start('I');
  const a = await f.start('A');
  const issued = await pause(i);

  await confirmed(f, a, issued);

  const resume = CoordinationStore.prototype.resumeByUser;

  vi.spyOn(CoordinationStore.prototype, 'resumeByUser')
    .mockRejectedValueOnce(new Error('disk full'))
    .mockImplementation(function (this: CoordinationStore, ...args) {
      return resume.apply(this, args);
    });

  await a.coordinator.send('a resumes');

  assert.deepEqual(prompts(a), ['a resumes']);

  await until('write failed', () =>
    (a.coordination.snapshot.error ?? '').includes('disk full'),
  );

  assert.equal((await statuses(f, issued))[id(a)], 'paused');

  await refreshed(a);

  await a.coordinator.send('still running');

  assert.deepEqual(prompts(a), ['a resumes', 'still running']);

  for (const tick of ticks) tick();

  await until(
    'write retried',
    async () => (await statuses(f, issued))[id(a)] === 'resumed',
  );

  await until('error cleared', () => !a.coordination.snapshot.error);
});

test('a recipient confirms only after its stopped turn settles, and retries a failed stop', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  pauseDiscovery(vi.spyOn);

  const f = await unitCoordinationFixture(cleanup);

  await f.checkout('I');

  const i = await f.start('I');
  const a = await f.start('A');
  const settlement = holdSettlement(a.a.sessions[0]!.session);

  cleanup(() => settlement.restore());

  const gate = new TurnGate();
  a.a.gate = gate;
  a.a.failInterrupt = true;
  const working = a.coordinator.send('working');

  await gate.entered;

  const issued = await pause(i);

  await refreshed(a);

  await until('stop failed', () =>
    a.coordinator.snapshot.items.some(({ text }) =>
      text.startsWith('Witch could not stop this conversation for its pause'),
    ),
  );

  a.a.failInterrupt = false;

  await until('stop retried', () => interrupts(a) === 2, 250);

  await settlement.entered;

  await refreshed(a);

  assert.equal((await statuses(f, issued))[id(a)], 'pending');

  settlement.release();

  await working;

  await until(
    'confirmed after settlement',
    async () => (await statuses(f, issued))[id(a)] === 'paused',
  );
});

test('a recipient that Claude Code runs on its own confirms once that run ends', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  pauseDiscovery(vi.spyOn);

  const f = await unitCoordinationFixture(cleanup);

  await f.checkout('I');

  const i = await f.start('I');
  const a = await f.start('A');
  const emit = a.a.sessions.at(-1)!.options.onEvent;

  emit({ type: 'running', running: true });

  const issued = await pause(i);

  await refreshed(a);

  await refreshed(a);

  // an unheld confirmation would be written within this
  await delay(500);

  assert.equal((await statuses(f, issued))[id(a)], 'pending');

  emit({ type: 'running', running: false });

  await until(
    'confirmed after the native run',
    async () => (await statuses(f, issued))[id(a)] === 'paused',
  );
});

test('a resume cancels a scheduled stop retry, which never interrupts the next turn', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  pauseDiscovery(vi.spyOn);

  const f = await unitCoordinationFixture(cleanup);

  await f.checkout('I');

  const i = await f.start('I');
  const a = await f.start('A');
  const gate = new TurnGate();
  a.a.gate = gate;
  a.a.failInterrupt = true;
  const working = a.coordinator.send('working');

  await gate.entered;

  await pause(i);

  await refreshed(a);

  await until('stop failed', () => interrupts(a) === 1);

  a.a.failInterrupt = false;

  // the user's prompt resumes before the retry fires, and runs once the stopped turn ends
  const resuming = a.coordinator.send('carry on');

  gate.open();

  await Promise.all([working, resuming]);

  await until('next turn', () => prompts(a).includes('carry on'));

  await delay(2500);

  assert.equal(interrupts(a), 1);
});

test('--to pauses only the named sessions, in any project', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  pauseDiscovery(vi.spyOn);

  const f = await unitCoordinationFixture(cleanup);
  const a = await f.start('A');
  const b = await f.start('B');
  const c = await f.start('C');
  const issued = await pause(a, [id(c), id(c)]);

  assert.deepEqual(
    issued.recipients.map(({ conversation }) => conversation),
    [id(c)],
  );

  await confirmed(f, c, issued);

  await refreshed(b);

  assert.equal(interrupts(b), 0);

  assert.equal(interrupts(c), 1);
});

test('a session that goes live before a default pause is recorded is a recipient', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  pauseDiscovery(vi.spyOn);

  const f = await unitCoordinationFixture(cleanup);

  await f.checkout('D');

  const a = await f.start('A');
  const b = await f.start('B');
  let d: Awaited<ReturnType<typeof f.start>> | undefined;
  // D opens in the same project after admission chose the recipients, before the pause is recorded
  const issue = CoordinationStore.prototype.issuePause;

  const spy = vi
    .spyOn(CoordinationStore.prototype, 'issuePause')
    .mockImplementationOnce(async function (this: CoordinationStore, ...args) {
      d = await f.start('D');

      return issue.apply(this, args);
    });

  const issued = await pause(a);

  spy.mockRestore();

  assert.deepEqual(
    new Set(issued.recipients.map(({ conversation }) => conversation)),
    new Set([id(b), id(d!)]),
  );
});

test('a pause that cannot reach every intended recipient records nothing', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  pauseDiscovery(vi.spyOn);

  const f = await unitCoordinationFixture(cleanup);
  const a = await f.start('A');

  const nothing = async () =>
    assert.deepEqual(await f.registry.pauses(id(a)), []);

  assert.equal(await refused(a, undefined), 'No other live session to pause.');

  assert.equal(await refused(a, [id(a)]), 'No other live session to pause.');

  const b = await f.start('B');
  const unknown = randomUUID();

  assert.match(
    await refused(a, [id(b), unknown]),
    new RegExp(`These are not live Witch sessions: ${unknown}`),
  );

  await nothing();

  // B closes after admission captured it, inside the locked check
  const issue = CoordinationStore.prototype.issuePause;

  const spy = vi
    .spyOn(CoordinationStore.prototype, 'issuePause')
    .mockImplementationOnce(async function (this: CoordinationStore, ...args) {
      await b.coordinator.close();

      return issue.apply(this, args);
    });

  assert.match(
    await refused(a, undefined),
    /These sessions closed before the pause was recorded/,
  );

  spy.mockRestore();

  await nothing();

  const legacy = record(randomUUID(), join(f.root, 'B'));

  await (await f.store.create(legacy)).close();

  const lock = await legacyLock(f.store, legacy.id);

  cleanup(() => lock.close());

  assert.match(
    await refused(a, undefined),
    /Restart or close these unregistered Witch sessions before pausing/,
  );

  await nothing();
});

test('a session whose Witch cannot be paused refuses the whole pause', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  pauseDiscovery(vi.spyOn);

  const publish = CoordinationStore.prototype.publish;

  // B's presence comes from a Witch built before pauses
  vi.spyOn(CoordinationStore.prototype, 'publish').mockImplementation(function (
    this: CoordinationStore,
    presence: SessionPresence,
  ) {
    const older = { ...presence };

    if (presence.cwd.endsWith('/B')) delete older.pauses;

    return publish.call(this, older);
  });

  const f = await unitCoordinationFixture(cleanup);

  await f.checkout('I');

  const i = await f.start('I');

  await f.start('A');

  const b = await f.start('B');

  assert.match(
    await refused(i, undefined),
    new RegExp(`cannot be paused until their user restarts them.*${id(b)}`),
  );

  assert.deepEqual(await f.registry.pauses(id(i)), []);
});

test('a failed pause read is retried on the next tick without another write', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const ticks = pauseDiscovery(vi.spyOn);
  const f = await unitCoordinationFixture(cleanup);

  await f.checkout('I');

  const i = await f.start('I');
  const a = await f.start('A');
  const read = CoordinationStore.prototype.pauses;
  let failed = false;

  vi.spyOn(CoordinationStore.prototype, 'pauses').mockImplementation(function (
    this: CoordinationStore,
    conversation: string,
  ) {
    if (conversation === id(a) && !failed) {
      failed = true;

      return Promise.reject(new Error('pauses unreadable'));
    }

    return read.call(this, conversation);
  });

  const issued = await pause(i);

  // the pause's write is what the first tick sees; the second sees no new write
  for (const tick of ticks) tick();

  await until('read failed', () =>
    (a.coordination.snapshot.error ?? '').includes('pauses unreadable'),
  );

  await delay(200);

  assert.equal((await statuses(f, issued))[id(a)], 'pending');

  for (const tick of ticks) tick();

  await until(
    'confirmed after reread',
    async () => (await statuses(f, issued))[id(a)] === 'paused',
  );
});

test('an issuer resume while a stopped, undelivered turn settles still runs the held queue', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  pauseDiscovery(vi.spyOn);

  const f = await unitCoordinationFixture(cleanup);

  await f.checkout('I');

  const i = await f.start('I');
  const a = await f.start('A');
  const session = a.a.sessions[0]!.session;
  // the pause lands before the runtime took the input, so the drain requeues it and ends
  const send = session.send.bind(session);
  let first = true;

  session.send = async (...args) => {
    const result = await send(...args);

    if (!first) return result;

    first = false;

    return { ...result, inputUnsent: true };
  };

  const settlement = holdSettlement(session);

  cleanup(() => settlement.restore());

  a.a.gate = new TurnGate();
  a.a.refuseSteer = true;
  const working = a.coordinator.send('working');

  await a.a.gate.entered;

  const queued = a.coordinator.send('queued');

  await until('queued', () => a.coordinator.snapshot.queue.length === 1);

  const issued = await pause(i);

  await refreshed(a);

  await settlement.entered;

  a.a.gate.open();

  const lifted = await control(i, { kind: 'resume', pause: issued.id });

  assert.equal(lifted.kind, 'pause', JSON.stringify(lifted));

  await refreshed(a);

  settlement.release();

  await Promise.all([working, queued]);

  await until('queue ran', () => prompts(a).length === 2);

  assert.deepEqual(prompts(a), ['working', 'working\nqueued']);
});

test("an issuer resume leaves the user's own Escape hold in place", async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  pauseDiscovery(vi.spyOn);

  const f = await unitCoordinationFixture(cleanup);

  await f.checkout('I');

  const i = await f.start('I');
  const a = await f.start('A');

  await a.coordinator.interrupt();

  const issued = await pause(i);

  await confirmed(f, a, issued);

  const lifted = await control(i, { kind: 'resume', pause: issued.id });

  assert.equal(lifted.kind, 'pause', JSON.stringify(lifted));

  await refreshed(a);

  await holdsAutomatic(i, a, 'escaped');

  await a.coordinator.send('back');

  await until('answer turn', () => answerTurns(a).length === 1);
});

test('a pause arriving during an operation started while held stops it before confirming', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  pauseDiscovery(vi.spyOn);

  const f = await unitCoordinationFixture(cleanup);

  await f.checkout('I');

  const i = await f.start('I');
  const a = await f.start('A');

  await confirmed(f, a, await pause(i));

  a.a.gate = new TurnGate();
  let compacted = false;

  const compacting = a.coordinator.compact().finally(() => {
    compacted = true;
  });

  await a.a.gate.entered;

  const second = await pause(i);

  await confirmed(f, a, second);

  assert.equal(compacted, true);

  await compacting.catch(() => {});
});

test('automatic work waits for a restarted recipient to read its pauses', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  pauseDiscovery(vi.spyOn);

  const f = await unitCoordinationFixture(cleanup);

  await f.checkout('I');

  const i = await f.start('I');
  const a = await f.start('A');
  const claim = await claimed(a, 'restarting');

  await confirmed(f, a, await pause(i));

  const conversation = id(a);

  await a.coordinator.close({ restart: true });

  const read = CoordinationStore.prototype.pauses;
  let failing = true;

  vi.spyOn(CoordinationStore.prototype, 'pauses').mockImplementation(function (
    this: CoordinationStore,
    recipient: string,
  ) {
    if (failing && recipient === conversation)
      return Promise.reject(new Error('pauses unreadable'));

    return read.call(this, recipient);
  });

  const restarted = await f.start('A', { conversation });

  await control(i, { kind: 'ask', claim: claim.id, message: 'Awake?' });

  await refreshed(restarted);

  await refreshed(restarted);

  await delay(500);

  assert.deepEqual(answerTurns(restarted), []);

  failing = false;

  await refreshed(restarted);

  await delay(500);

  assert.deepEqual(answerTurns(restarted), []);
});

test("a failed pause read after switching away drops the previous conversation's hold", async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  pauseDiscovery(vi.spyOn);

  const f = await unitCoordinationFixture(cleanup);

  await f.checkout('I');

  const i = await f.start('I');
  const a = await f.start('A');

  await confirmed(f, a, await pause(i));

  const conversation = id(a);
  const read = CoordinationStore.prototype.pauses;
  let failing = true;

  vi.spyOn(CoordinationStore.prototype, 'pauses').mockImplementation(function (
    this: CoordinationStore,
    recipient: string,
  ) {
    if (failing && recipient !== conversation && recipient !== id(i))
      return Promise.reject(new Error('pauses unreadable'));

    return read.call(this, recipient);
  });

  await a.coordinator.newConversation();

  await a.coordinator.send('elsewhere');

  assert.deepEqual(prompts(a), ['elsewhere']);

  failing = false;

  await a.coordinator.selectConversation(conversation);

  await refreshed(a);

  await holdsAutomatic(i, a, 'a-back');
});

test('a prompt that resumes a pause runs before automatic work its release wakes', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  pauseDiscovery(vi.spyOn);

  const f = await unitCoordinationFixture(cleanup);

  await f.checkout('I');

  const i = await f.start('I');
  const a = await f.start('A');
  const claim = await claimed(a, 'waiting');

  await confirmed(f, a, await pause(i));

  await control(i, { kind: 'ask', claim: claim.id, message: 'Later?' });

  await refreshed(a);

  await a.coordinator.send('resume');

  await until('answer turn', () => answerTurns(a).length === 1);

  assert.deepEqual(
    a.a.inputs.map(({ prompt, author }) => (author ? 'answer' : prompt)),
    ['resume', 'answer'],
  );
});

test('a prompt sent before a failed pause read resumes the pauses issued before it', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  pauseDiscovery(vi.spyOn);

  const f = await unitCoordinationFixture(cleanup);

  await f.checkout('I');

  const i = await f.start('I');
  const a = await f.start('A');
  const issued = await pause(i);

  await confirmed(f, a, issued);

  const conversation = id(a);

  await a.coordinator.close({ restart: true });

  const read = CoordinationStore.prototype.pauses;
  let failing = true;

  vi.spyOn(CoordinationStore.prototype, 'pauses').mockImplementation(function (
    this: CoordinationStore,
    recipient: string,
  ) {
    if (failing && recipient === conversation)
      return Promise.reject(new Error('pauses unreadable'));

    return read.call(this, recipient);
  });

  const restarted = await f.start('A', { conversation });

  await restarted.coordinator.send('after restart');

  assert.deepEqual(prompts(restarted), ['after restart']);

  failing = false;
  const later = await pause(i);

  await refreshed(restarted);

  await until(
    'resumed by the earlier prompt',
    async () => (await statuses(f, issued))[conversation] === 'resumed',
  );

  // a pause issued after the prompt still holds
  await until(
    'later pause confirmed',
    async () => (await statuses(f, later))[conversation] === 'paused',
  );

  await restarted.coordinator.send('after the later pause');

  await until('delivered', () => prompts(restarted).length === 2);
});

test('a pause arriving during an in-flight stop gets its own stop before confirming', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  pauseDiscovery(vi.spyOn);

  const f = await unitCoordinationFixture(cleanup);

  await f.checkout('I');

  const i = await f.start('I');
  const a = await f.start('A');
  const session = a.a.sessions[0]!.session;
  const interrupt = session.interrupt.bind(session);
  const held = Promise.withResolvers<void>();
  let first = true;

  session.interrupt = async (...args) => {
    if (first) {
      first = false;

      await held.promise;
    }

    return interrupt(...args);
  };

  const issued = await pause(i);

  await refreshed(a);

  const second = await pause(i);

  await refreshed(a);

  // an operation the user starts while the first stop is still in flight
  a.a.gate = new TurnGate();
  let compacted = false;

  const compacting = a.coordinator.compact().finally(() => {
    compacted = true;
  });

  await a.a.gate.entered;

  held.resolve();

  await until(
    'both confirmed',
    async () =>
      (await statuses(f, issued))[id(a)] === 'paused' &&
      (await statuses(f, second))[id(a)] === 'paused',
  );

  assert.equal(compacted, true);

  await compacting.catch(() => {});
});

test('a prompt sent while /clear reconnects coordination still stores its resume', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  pauseDiscovery(vi.spyOn);

  const f = await unitCoordinationFixture(cleanup);

  await f.checkout('I');

  const i = await f.start('I');
  const a = await f.start('A');
  const issued = await pause(i);

  await confirmed(f, a, issued);

  const activate = SessionCoordination.prototype.activate;
  let sending: Promise<void> | undefined;

  // the prompt lands after /clear deactivated coordination and before it reactivates
  vi.spyOn(SessionCoordination.prototype, 'activate').mockImplementationOnce(
    function (this: SessionCoordination, ...args) {
      sending = a.coordinator.send('resume');

      return activate.apply(this, args);
    },
  );

  await a.coordinator.clear();

  await sending;

  await until(
    'resume stored',
    async () => (await statuses(f, issued))[id(a)] === 'resumed',
  );
});

test('automatic work after /clear waits for the new activation to read its pauses', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  pauseDiscovery(vi.spyOn);

  const f = await unitCoordinationFixture(cleanup);

  await f.checkout('I');

  const i = await f.start('I');
  const a = await f.start('A');
  const claim = await claimed(a, 'clearing');

  // A last read no pauses; this one and the request land before it reads again
  await pause(i);

  await control(i, { kind: 'ask', claim: claim.id, message: 'Paused?' });

  const conversation = id(a);
  const read = CoordinationStore.prototype.pauses;

  vi.spyOn(CoordinationStore.prototype, 'pauses').mockImplementation(function (
    this: CoordinationStore,
    recipient: string,
  ) {
    if (recipient === conversation)
      return Promise.reject(new Error('pauses unreadable'));

    return read.call(this, recipient);
  });

  await a.coordinator.clear();

  await refreshed(a);

  await delay(500);

  assert.deepEqual(answerTurns(a), []);
});
