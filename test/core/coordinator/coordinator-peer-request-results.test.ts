import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, vi } from 'vitest';
import { ClaudeAdapter } from '../../../src/agents/claude/adapter.js';
import { CodexAdapter } from '../../../src/agents/codex/adapter.js';
import { unreportedContextCatalog } from '../../fixtures/codex-adapter.js';
import { answerInstruction } from '../../../src/core/coordination/peer-requests.js';
import type { PeerRequest } from '../../../src/core/coordination/peer-requests.js';
import type { PullRequest } from '../../../src/core/repository/repository.js';
import { CoordinationStore } from '../../../src/persistence/coordination.js';
import { callControl } from '../../../src/persistence/control.js';
import { NotificationSchedule } from '../../../src/persistence/notifications.js';
import { watchTerminal } from '../../../src/ui/terminal/terminal.js';
import { TurnGate } from '../../fixtures/agent.js';
import { orderedCleanup } from '../../fixtures/cleanup.js';
import type { RegisterCleanup } from '../../fixtures/cleanup.js';
import {
  pauseDiscovery,
  unitCoordinationFixture,
} from '../../fixtures/coordination.js';
import { scratch } from '../../fixtures/scratch.js';
import { until, within } from '../../fixtures/within.js';
import { repositoryRead } from '../../fixtures/repository.js';
import type { Client } from '../../fixtures/coordinator-peer-requests.js';
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
} from '../../fixtures/coordinator-peer-requests.js';

async function answer(client: Client, request: PeerRequest, message: string) {
  const result = await callControl(await client.binding(), {
    kind: 'answer',
    request: request.id,
    message,
  });

  if (result.kind !== 'peer-request') assert.fail(JSON.stringify(result));
}

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

  a.coordination.updateRepository(
    repositoryRead({
      branch: merged.branch,
      pullRequest: merged,
      pullRequestProject: project,
    }),
  );

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
    { kind: 'pause' },
    { kind: 'resume', pause: randomUUID() },
  ] as const) {
    const result = await callControl(binding, action);
    assert.equal(result.kind, 'error', JSON.stringify(result));

    if (result.kind === 'error')
      assert.equal(
        result.message,
        'Answer the current peer requests without asking or pausing other sessions or changing claims.',
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

  const attempts = vi
    .spyOn(CoordinationStore.prototype, 'attemptPeerRequests')
    .mockRejectedValueOnce(new Error('Peer requests unreadable'));

  // a refresh during the failed drain is dropped, but any coordination publish after it retries at once and clears the
  // error, so the failure is caught as it's published rather than polled for
  let failed = false;

  b.coordination.subscribe(() => {
    failed ||= (b.coordination.snapshot.error ?? '').includes(
      'Peer requests unreadable',
    );
  });

  const request = await ask(a, claim, 'Retry?');
  await refreshed(b);
  await until('admission failure', () => failed && settled(b));
  await refreshed(b);
  await until('answer turn', () => answerTurns(b).length === 1 && settled(b));
  assert.equal(attempts.mock.calls.length, 2);
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

  a.coordination.updateRepository(
    repositoryRead({
      branch: merged.branch,
      pullRequest: merged,
      pullRequestProject: project,
    }),
  );

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
  const f = await unitCoordinationFixture(orderedCleanup(register));
  const source = await f.start('A');
  const cwd = join(f.root, 'B');

  const executable = fileURLToPath(
    new URL(`../../fixtures/${name}.mjs`, import.meta.url),
  );

  const launch = (signal?: AbortSignal) =>
    spawn(process.execPath, [executable], { cwd, stdio: 'pipe', signal });

  const adapter =
    name === 'codex'
      ? new CodexAdapter(
          (_, __, signal) => launch(signal),
          unreportedContextCatalog,
        )
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
