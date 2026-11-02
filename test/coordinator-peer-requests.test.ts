import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, vi } from 'vitest';
import { ClaudeAdapter } from '../src/agents/claude.js';
import { CodexAdapter } from '../src/agents/codex.js';
import type { UserRequest } from '../src/agents/types.js';
import type { TaskClaim } from '../src/core/coordination-state.js';
import {
  answerInstruction,
  peerRequestStatus,
} from '../src/core/peer-requests.js';
import type { PeerRequest } from '../src/core/peer-requests.js';
import type { PullRequest } from '../src/core/repository.js';
import { untitled } from '../src/core/state.js';
import { CoordinationStore } from '../src/persistence/coordination.js';
import { callControl } from '../src/persistence/control.js';
import { NotificationSchedule } from '../src/persistence/notifications.js';
import { identifyProcess } from '../src/persistence/process.js';
import { watchTerminal } from '../src/ui/terminal.js';
import { TurnGate } from './fixtures/agent.js';
import { orderedCleanup } from './fixtures/cleanup.js';
import type { RegisterCleanup } from './fixtures/cleanup.js';
import {
  coordinationFixture,
  git,
  pauseDiscovery,
} from './fixtures/coordination.js';
import { scratch } from './fixtures/scratch.js';
import { readRecord } from './fixtures/coordinator.js';
import { until, within } from './fixtures/within.js';

type Fixture = Awaited<ReturnType<typeof coordinationFixture>>;
type Client = Awaited<ReturnType<Fixture['start']>>;

const secret = 'peer-only-text';

async function claimed(client: Client, name: string): Promise<TaskClaim> {
  const result = await client.claim(`task:${name}`, `${name} work`);
  if (result.kind !== 'claimed') assert.fail(JSON.stringify(result));
  return result.claim;
}

async function ask(
  client: Client,
  claim: TaskClaim,
  message: string,
): Promise<PeerRequest> {
  const result = await callControl(await client.binding(), {
    kind: 'ask',
    claim: claim.id,
    message,
  });
  if (result.kind !== 'peer-request') assert.fail(JSON.stringify(result));
  return result.request;
}

async function answer(client: Client, request: PeerRequest, message: string) {
  const result = await callControl(await client.binding(), {
    kind: 'answer',
    request: request.id,
    message,
  });
  if (result.kind !== 'peer-request') assert.fail(JSON.stringify(result));
}

/** A runs the asker and B the owner, with discovery ticks under the test's control. */
async function owners(register: RegisterCleanup, task = 'b-work') {
  const refreshes = pauseDiscovery(vi.spyOn);
  const f = await coordinationFixture(orderedCleanup(register));
  const a = await f.start('A');
  const b = await f.start('B');
  const claim = await claimed(b, task);
  const seen = { answering: false };
  b.coordinator.subscribe(() => {
    if (b.coordinator.snapshot.answering) seen.answering = true;
  });
  return { f, a, b, claim, seen, refreshes };
}

/** the refresh a discovery tick runs, awaited; it renotifies while requests are answerable. */
const refreshed = (client: Client) => client.coordination.context();
const answerTurns = (client: Client) =>
  client.a.inputs.filter(({ author }) => author === 'witch');
const prompts = (client: Client) =>
  client.a.inputs.map(({ prompt, author }) => (author ? 'answer' : prompt));
const notice = (client: Client, id: string) =>
  client.coordinator.snapshot.items.find((item) => item.id === id);
const settled = (client: Client) =>
  client.coordinator.snapshot.phase === 'idle' &&
  !client.coordinator.snapshot.answering;
const stored = async (f: Fixture, request: PeerRequest) =>
  (await f.registry.peerRequests(request.project, request.to)).find(
    ({ id }) => id === request.id,
  )!;
const listed = (context = ''): string[] => {
  const paragraph = context
    .split('\n\n')
    .find((text) =>
      text.startsWith('These peer requests have recorded answers'),
    );
  return paragraph
    ? (
        JSON.parse(paragraph.slice(paragraph.indexOf('\n') + 1)) as {
          id: string;
        }[]
      ).map(({ id }) => id)
    : [];
};

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
  const { f, a, b, claim, seen } = await owners(t.onTestFinished);
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

const merged: PullRequest = {
  number: 17,
  url: 'https://github.com/example/project/pull/17',
  state: 'MERGED',
  branch: 'feat/events',
  base: 'main',
  commit: 'head-23',
};

test('answer turns keep pending context, handoffs, merges and answers, and the compaction check', async (t) => {
  const { a, b, claim } = await owners(t.onTestFinished);
  await b.coordinator.send('start');
  await b.coordinator.selectModel({ agent: 'b', id: 'b-model' });
  assert.equal(b.coordinator.snapshot.conversation!.handoff?.to, 'b');
  const { project } = await a.coordinator.memory.scopePaths(
    a.coordinator.snapshot.conversation!.cwd,
  );
  a.coordination.updateRepository({
    branch: merged.branch,
    ahead: 0,
    behind: 0,
    staged: 0,
    modified: 0,
    conflicts: 0,
    untracked: 0,
    pullRequest: merged,
    pullRequestProject: project,
  });
  const own = await ask(b, await claimed(a, 'a-work'), 'From B?');
  await answer(a, own, 'From A');
  await until('merge and answer reach the owner', async () => {
    await refreshed(b);
    const id = b.coordinator.snapshot.conversation!.id;
    return (
      b.coordination.events.mergeEvents(id).length === 1 &&
      !!notice(b, `peer-answer/${own.id}`)
    );
  });
  const session = b.b.sessions.at(-1)!.session;
  const send = session.send;
  session.send = async () => ({
    status: 'interrupted',
    text: '',
    unreadContext: ['<bash-input>already-ran</bash-input>'],
  });
  await b.coordinator.send('seed');
  session.send = send;
  const usage = session.contextUsage;
  session.contextUsage = async () => 90;
  await ask(a, claim, 'Answer now?');
  await refreshed(b);
  await until(
    'answer turn',
    () => b.b.inputs.some(({ author }) => author === 'witch') && settled(b),
  );
  assert.equal(b.b.compactions.length, 1);
  session.contextUsage = usage;
  const paragraphs = [
    'Pending task context from',
    'These commands already ran before an interrupt',
    'Witch observed these project merges',
    'These peer requests have recorded answers',
  ];
  const answered = b.b.inputs.find(({ author }) => author === 'witch')!;
  for (const paragraph of paragraphs)
    assert.ok(!answered.context!.includes(paragraph), paragraph);
  await b.coordinator.send('after');
  const user = b.b.inputs.at(-1)!;
  for (const paragraph of paragraphs)
    assert.ok(user.context!.includes(paragraph), paragraph);
  assert.equal(b.b.compactions.length, 1);
});

test('control requests stay scoped while an automatic answer is in flight', async (t) => {
  const { f, a, b, claim } = await owners(t.onTestFinished);
  const other = await claimed(a, 'a-work');
  b.a.peerReply = (requests) =>
    JSON.stringify({
      answers: requests.map(({ id, message }) => ({
        id,
        message: `Automatic: ${message}`,
      })),
    });
  const gate = new TurnGate();
  b.a.gate = gate;
  const request = await ask(a, claim, 'Hold on?');
  const second = await ask(a, claim, 'Second question');
  await refreshed(b);
  await gate.entered;
  assert.equal(b.coordinator.snapshot.answering, true);
  const binding = await b.binding();
  const peers = await callControl(binding, { kind: 'peers' });
  assert.equal(peers.kind, 'peers', JSON.stringify(peers));
  const read = await callControl(binding, {
    kind: 'peer-request',
    request: request.id,
  });
  assert.equal(read.kind, 'peer-request', JSON.stringify(read));
  await answer(b, request, 'Mid-turn');
  assert.equal((await stored(f, request)).answer?.message, 'Mid-turn');
  for (const action of [
    { kind: 'ask', claim: other.id, message: 'Back to you?' },
    { kind: 'claim', input: { reference: 'task:other', summary: 'Other' } },
    { kind: 'release', claim: claim.id },
  ] as const) {
    const result = await callControl(binding, action);
    assert.equal(result.kind, 'error', JSON.stringify(result));
    if (result.kind === 'error')
      assert.equal(
        result.message,
        'Answer the current peer requests without asking other sessions or changing claims.',
      );
  }
  gate.open();
  await until('owner settled', () => settled(b));
  assert.equal((await stored(f, request)).answer?.message, 'Mid-turn');
  assert.equal(
    (await stored(f, second)).answer?.message,
    'Automatic: Second question',
  );
  await refreshed(b);
  assert.equal(answerTurns(b).length, 1);
  assert.equal((await b.query()).ownClaim?.id, claim.id);
});

test('answers follow native session receipts', async (t) => {
  const { f, a, b, claim } = await owners(t.onTestFinished);
  const first = await ask(a, claim, 'First?');
  const gate = new TurnGate();
  a.a.gate = gate;
  const working = a.coordinator.send('working');
  await gate.entered;
  await answer(b, first, 'First answer');
  await refreshed(a);
  gate.open();
  await working;
  a.a.gate = undefined;
  assert.deepEqual(listed(a.a.inputs.at(-1)!.context), []);
  await a.coordinator.send('next');
  assert.deepEqual(listed(a.a.inputs.at(-1)!.context), [first.id]);
  await a.coordinator.send('again');
  assert.deepEqual(listed(a.a.inputs.at(-1)!.context), []);

  const second = await ask(a, claim, 'Second?');
  await answer(b, second, 'Second answer');
  await refreshed(a);
  a.a.interruptNext = true;
  await a.coordinator.send('interrupted');
  assert.deepEqual(listed(a.a.inputs.at(-1)!.context), [second.id]);
  await a.coordinator.send('resumed');
  assert.deepEqual(listed(a.a.inputs.at(-1)!.context), [second.id]);
  await a.coordinator.send('settled');
  assert.deepEqual(listed(a.a.inputs.at(-1)!.context), []);

  await a.coordinator.selectModel({ agent: 'b', id: 'b-model' });
  await a.coordinator.send('on b');
  assert.deepEqual(listed(a.b.inputs.at(-1)!.context), [first.id, second.id]);
  await a.coordinator.send('again on b');
  assert.deepEqual(listed(a.b.inputs.at(-1)!.context), []);
  await a.coordinator.compact();
  await a.coordinator.send('compacted');
  assert.deepEqual(listed(a.b.inputs.at(-1)!.context), [first.id, second.id]);
  await a.coordinator.send('once');
  assert.deepEqual(listed(a.b.inputs.at(-1)!.context), []);

  const conversation = a.coordinator.snapshot.conversation!.id;
  await a.coordinator.close({ restart: true });
  const restarted = await f.start('A', { conversation });
  await refreshed(restarted);
  assert.equal(
    restarted.coordination.events.peerRequests(conversation).length,
    2,
  );
  await restarted.coordinator.send('restarted');
  assert.deepEqual(listed(restarted.b.inputs.at(-1)!.context), []);
  const native = restarted.b.sessions.at(-1)!;
  native.options.onEvent({
    type: 'info',
    info: { ...native.session.info, id: 'replaced' },
  });
  await restarted.coordinator.send('replaced');
  assert.deepEqual(listed(restarted.b.inputs.at(-1)!.context), [
    first.id,
    second.id,
  ]);
});

test('peer notices stay single across restart', async (t) => {
  const { f, a, b, claim } = await owners(t.onTestFinished);
  const request = await ask(a, claim, 'Once?');
  await answer(b, request, 'Only once');
  const clients = { a, b };
  const ids = {
    a: `peer-answer/${request.id}`,
    b: `peer-request/${request.id}`,
  };
  const rows = async (conversation: string, id: string) =>
    (
      await readFile(
        join(f.store.root, 'conversations', conversation, 'history.jsonl'),
        'utf8',
      )
    )
      .trim()
      .split('\n')
      .filter((line) => (JSON.parse(line) as { id: string }).id === id).length;
  for (const name of ['a', 'b'] as const) {
    let client = clients[name];
    await refreshed(client);
    assert.ok(notice(client, ids[name]));
    const conversation = client.coordinator.snapshot.conversation!.id;
    await client.coordinator.close({ restart: true });
    assert.equal(await rows(conversation, ids[name]), 1);
    client = await f.start(name.toUpperCase(), { conversation });
    await refreshed(client);
    await refreshed(client);
    assert.equal(
      client.coordinator.snapshot.items.filter(({ id }) => id === ids[name])
        .length,
      1,
    );
    await client.coordinator.close({ restart: true });
    assert.equal(await rows(conversation, ids[name]), 1);
  }
});

test('peer notices escape peer text', async (t) => {
  const { a, b, claim } = await owners(
    t.onTestFinished,
    '[x](https://example.com)',
  );
  b.a.peerReply = (requests) =>
    JSON.stringify({
      answers: requests.map(({ id }) => ({
        id,
        message: 'see [y](https://example.com)\nnext',
      })),
    });
  const request = await ask(
    a,
    claim,
    'line one\n  line two [x](https://example.com)',
  );
  await refreshed(b);
  await until('answer turn', () => answerTurns(b).length === 1 && settled(b));
  const about = 'about task:\\[x\\](https://example.com)';
  assert.equal(
    notice(b, `peer-request/${request.id}`)!.text,
    `Peer request ${request.id} from session ${request.from} ${about}: line one line two \\[x\\](https://example.com)`,
  );
  await refreshed(a);
  assert.equal(
    notice(a, `peer-answer/${request.id}`)!.text,
    `Answer to peer request ${request.id} from session ${request.to} ${about}: see \\[y\\](https://example.com) next`,
  );
});

test('invalid native answers publish nothing and consume their one automatic attempt', async (t) => {
  const { a, b, claim, f } = await owners(t.onTestFinished);
  b.a.peerReply = () => '{"answers":[]}';
  const request = await ask(a, claim, 'Malformed?');
  await refreshed(b);
  await until('failed answer', () => answerTurns(b).length === 1 && settled(b));
  const stored = await f.registry.peerRequests(request.project, request.to);
  assert.ok(stored.find(({ id }) => id === request.id)?.attemptedAt);
  assert.equal(stored.find(({ id }) => id === request.id)?.answer, undefined);
  assert.equal(
    b.coordinator.snapshot.conversation!.sessions.a!.deliveredRevision,
    undefined,
  );
  await refreshed(b);
  assert.equal(answerTurns(b).length, 1);
});

test('a failed turn cleanup still removes the request file', async (t) => {
  const { a, b, claim } = await owners(t.onTestFinished);
  vi.spyOn(b.coordination, 'endTurn').mockRejectedValueOnce(
    new Error('Turn cleanup failed'),
  );
  await ask(a, claim, 'Cleanup?');
  await refreshed(b);
  await until(
    'reported cleanup failure',
    () =>
      b.coordinator.snapshot.error === 'Turn cleanup failed' &&
      !b.coordinator.snapshot.answering,
  );
  await assert.rejects(access(answerTurns(b)[0]!.answer!.requestFile), {
    code: 'ENOENT',
  });
});

test('a failed admission clears and retries', async (t) => {
  const { f, a, b, claim } = await owners(t.onTestFinished);
  vi.spyOn(
    CoordinationStore.prototype,
    'attemptPeerRequests',
  ).mockRejectedValueOnce(new Error('Peer requests unreadable'));
  const request = await ask(a, claim, 'Retry?');
  await refreshed(b);
  // a refresh during the failed drain is dropped, and the paused tick would be what renotifies
  await until(
    'admission failure',
    () =>
      (b.coordination.snapshot.error ?? '').includes(
        'Peer requests unreadable',
      ) && settled(b),
  );
  assert.deepEqual(answerTurns(b), []);
  await refreshed(b);
  await until('answer turn', () => answerTurns(b).length === 1 && settled(b));
  assert.equal(b.coordination.snapshot.error, undefined);
  assert.ok((await stored(f, request)).attemptedAt);
});

test('a failed peer request read reports and clears', async (t) => {
  const { a, b, claim } = await owners(t.onTestFinished);
  const owner = b.coordinator.snapshot.conversation!.id;
  const read = CoordinationStore.prototype.peerRequests;
  let failing = true;
  vi.spyOn(CoordinationStore.prototype, 'peerRequests').mockImplementation(
    function (this: CoordinationStore, project, conversation) {
      if (!failing || conversation !== owner)
        return read.call(this, project, conversation);
      failing = false;
      return Promise.reject(new Error('Peer requests unreadable'));
    },
  );
  await ask(a, claim, 'Readable?');
  await refreshed(b);
  await until('read failure', () =>
    (b.coordination.snapshot.error ?? '').includes('Peer requests unreadable'),
  );
  assert.deepEqual(answerTurns(b), []);
  await refreshed(b);
  await until('answer turn', () => answerTurns(b).length === 1 && settled(b));
  assert.equal(b.coordination.snapshot.error, undefined);
});

test('a failed merge read leaves peer requests flowing', async (t) => {
  const { a, b, claim } = await owners(t.onTestFinished);
  const owner = b.coordinator.snapshot.conversation!.id;
  const read = CoordinationStore.prototype.mergeEvents;
  vi.spyOn(CoordinationStore.prototype, 'mergeEvents').mockImplementation(
    function (this: CoordinationStore, project, conversation) {
      return conversation === owner
        ? Promise.reject(new Error('Merge events unreadable'))
        : read.call(this, project, conversation);
    },
  );
  const request = await ask(a, claim, 'Despite merges?');
  await refreshed(b);
  assert.match(b.coordination.snapshot.error ?? '', /Merge events unreadable/);
  await until('answer turn', () => answerTurns(b).length === 1 && settled(b));
  assert.ok(notice(b, `peer-request/${request.id}`));
});

test('a failed peer request read leaves merge events flowing', async (t) => {
  const { a, b } = await owners(t.onTestFinished);
  const owner = b.coordinator.snapshot.conversation!.id;
  const read = CoordinationStore.prototype.peerRequests;
  vi.spyOn(CoordinationStore.prototype, 'peerRequests').mockImplementation(
    function (this: CoordinationStore, project, conversation) {
      return conversation === owner
        ? Promise.reject(new Error('Peer requests unreadable'))
        : read.call(this, project, conversation);
    },
  );
  const { project } = await a.coordinator.memory.scopePaths(
    a.coordinator.snapshot.conversation!.cwd,
  );
  a.coordination.updateRepository({
    branch: merged.branch,
    ahead: 0,
    behind: 0,
    staged: 0,
    modified: 0,
    conflicts: 0,
    untracked: 0,
    pullRequest: merged,
    pullRequestProject: project,
  });
  await until('merge reaches the owner', async () => {
    await refreshed(b);
    return b.coordination.events.mergeEvents(owner).length === 1;
  });
  assert.match(b.coordination.snapshot.error ?? '', /Peer requests unreadable/);
});

test("an answer turn keeps a user turn's completion notice on time", async (t) => {
  const { a, b, claim } = await owners(t.onTestFinished);
  const schedule = await NotificationSchedule.open(
    join(await scratch('witch-peer-notify-'), 'notifications'),
  );
  // a recent alert defers the next one past the answer turn's start
  await schedule.attempt(
    () => 'earlier alert',
    () => {},
  );
  const output: string[] = [];
  const stop = watchTerminal(
    b.coordinator,
    b.coordination,
    (data) => {
      output.push(data);
    },
    schedule,
  );
  t.onTestFinished(stop);
  const user = new TurnGate();
  b.a.gate = user;
  const working = b.coordinator.send('user work');
  await user.entered;
  await ask(a, claim, 'Meanwhile?');
  await refreshed(b);
  const answering = new TurnGate();
  b.a.gate = answering;
  user.open();
  await answering.entered;
  await until(
    'completion notice',
    () => output.some((data) => data.includes('Turn complete')),
    250,
  );
  assert.equal(b.coordinator.snapshot.answering, true);
  answering.open();
  await working;
});

async function nativeOwner(
  register: RegisterCleanup,
  name: 'claude' | 'codex',
) {
  pauseDiscovery(vi.spyOn);
  const f = await coordinationFixture(orderedCleanup(register));
  const source = await f.start('A');
  const cwd = join(f.root, 'B');
  const executable = fileURLToPath(
    new URL(`fixtures/${name}.mjs`, import.meta.url),
  );
  const launch = (signal?: AbortSignal) =>
    spawn(process.execPath, [executable], { cwd, stdio: 'pipe', signal });
  const adapter =
    name === 'codex'
      ? new CodexAdapter((_, __, signal) => launch(signal))
      : new ClaudeAdapter((options) => {
          if (options.args.includes('--tools=Read,Grep,Glob'))
            return spawn(process.execPath, [executable, 'peer-answer'], {
              cwd,
              stdio: 'pipe',
              signal: options.signal,
            });
          if (!options.args.includes('--no-session-persistence'))
            return launch(options.signal);
          const directory = join(cwd, 'usage');
          mkdirSync(directory, { recursive: true });
          return spawn(process.execPath, [executable, 'background'], {
            cwd: directory,
            stdio: 'pipe',
            signal: options.signal,
          });
        });
  const owner = await f.start('B', {}, [{ adapter, executable }]);
  const accepted = new Set<string>();
  register(
    owner.coordinator.subscribe(() => {
      for (const request of owner.coordinator.snapshot.requests) {
        if (accepted.has(request.id)) continue;
        accepted.add(request.id);
        void owner.coordinator.respond(request.id, { decision: 'accept' });
      }
    }),
  );
  const claim = await claimed(owner, 'native-work');
  const answerTurn = async () => {
    const request = await ask(source, claim, `Native? ${secret}`);
    await refreshed(owner);
    await until(
      'native answer turn',
      () =>
        owner.coordinator.snapshot.items.some(({ text }) =>
          text.startsWith('Witch started a turn to answer'),
        ) && settled(owner),
      500,
    );
    assert.equal(owner.coordinator.snapshot.error, undefined);
    return request;
  };
  return { owner, cwd, answerTurn };
}

test("Claude answer turns are labeled as Witch's", async (t) => {
  const { owner, cwd, answerTurn } = await nativeOwner(
    t.onTestFinished,
    'claude',
  );
  const content = async () =>
    JSON.parse(await readFile(join(cwd, 'content.json'), 'utf8')) as string;
  await within(owner.coordinator.send('user turn'), 10_000, 'user turn');
  const user = await content();
  assert.match(user, /Delegate work only through Witch/);
  assert.ok(user.endsWith('User request:\nuser turn'));
  const request = await answerTurn();
  const input = await content();
  assert.ok(input.endsWith(`Witch request:\n${answerInstruction}`));
  assert.ok(input.includes(request.id));
  for (const absent of [
    'User request:',
    'Delegate work only through Witch',
    secret,
  ])
    assert.ok(!input.includes(absent), absent);
});

test('Codex answer turns keep peer text out of native input', async (t) => {
  const { cwd, answerTurn } = await nativeOwner(t.onTestFinished, 'codex');
  const request = await answerTurn();
  const injection = JSON.parse(
    await readFile(join(cwd, 'context.json'), 'utf8'),
  ) as { items: { content: { text: string }[] }[] };
  const context = injection.items
    .flatMap(({ content }) => content.map(({ text }) => text))
    .join('\n');
  assert.ok(context.includes(request.id));
  assert.ok(!context.includes(secret));
  const start = JSON.parse(
    await readFile(join(cwd, 'prompt.json'), 'utf8'),
  ) as { params: { input: { text: string }[] } };
  assert.deepEqual(
    start.params.input.map(({ text }) => text),
    [answerInstruction],
  );
});
