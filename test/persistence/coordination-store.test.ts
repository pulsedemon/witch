import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { constants } from 'node:fs';
import { access, chmod, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import type {
  ClaimInput,
  ClaimOwner,
  SessionPresence,
  SelectionTicket,
  TaskClaim,
  TransferField,
} from '../../src/core/coordination/coordination-state.js';
import {
  ClaimConflict,
  CoordinationStore,
  DeadlineExpired,
} from '../../src/persistence/coordination.js';
import { StateStore } from '../../src/persistence/store.js';
import { entry, pauseStatuses } from '../../src/core/coordination/pauses.js';
import { identifyProcess } from '../../src/persistence/process.js';
import { openLocked, lockedFiles } from '../../src/persistence/lock.js';
import { record } from '../fixtures/coordinator.js';
import { scratch } from '../fixtures/scratch.js';
import { countProbes } from '../fixtures/probes.js';
import { within } from '../fixtures/within.js';
import { orderedCleanup } from '../fixtures/cleanup.js';
import type { RegisterCleanup } from '../fixtures/cleanup.js';

const identity = (await identifyProcess(process.pid))!;
const owner = { conversation: 'a', project: 'project-p' };
const input = { reference: 'task:shared', summary: 'First task' };
const verify = async () => {};

const claim = (
  store: CoordinationStore,
  givenOwner: ClaimOwner = owner,
  givenInput: ClaimInput = input,
) => store.claim(givenOwner, givenInput, identity, Date.now() + 5000, verify);

const release = (
  store: CoordinationStore,
  givenOwner: ClaimOwner,
  id: string,
) => store.release(givenOwner, id, Date.now() + 5000, verify);

test('reference release normalizes and deduplicates selections while preserving the continuing claim and assignments', async () => {
  const store = await CoordinationStore.open(
    await StateStore.open(await scratch('witch-release-references-')),
  );

  const side = 'https://github.com/team/side/pull/12';

  const original = await claim(store, owner, {
    ...input,
    aliases: [side, 'task:side'],
  });

  const assigned = (await store.recordAssignment(
    original.id,
    ['github:team/side#12'],
    Date.now() + 5000,
    verify,
  ))!;

  const expected = { ...assigned, references: ['task:project-p:shared'] };

  assert.deepEqual(
    await store.releaseReferences(
      owner,
      original.id,
      ['https://github.com/TEAM/SIDE/issues/12/', side, 'task: SIDE '],
      Date.now() + 5000,
      verify,
    ),
    {
      references: ['github:team/side#12', 'task:project-p:side'],
      claim: expected,
    },
  );

  assert.deepEqual(await store.claims(), [expected]);

  assert.deepEqual(
    await store.releaseReferences(
      owner,
      original.id,
      ['task:shared'],
      Date.now() + 5000,
      verify,
    ),
    { references: ['task:project-p:shared'] },
  );

  assert.deepEqual(await store.claims(), []);

  await assert.rejects(
    store.releaseReferences(
      owner,
      original.id,
      ['task:shared'],
      Date.now() + 5000,
      verify,
    ),
    /no longer exists/,
  );
});

test('reference release refuses foreign owners and mixed valid/unknown selections without partial mutation', async () => {
  const store = await CoordinationStore.open(
    await StateStore.open(await scratch('witch-release-refusal-')),
  );

  const original = await claim(store, owner, {
    ...input,
    aliases: ['task:side'],
  });

  await assert.rejects(
    store.releaseReferences(
      { ...owner, conversation: 'other' },
      original.id,
      ['task:side'],
      Date.now() + 5000,
      verify,
    ),
    /Only the owning conversation/,
  );

  assert.deepEqual(await store.claims(), [original]);

  await assert.rejects(
    store.releaseReferences(
      owner,
      original.id,
      ['task:side', 'task:unknown'],
      Date.now() + 5000,
      verify,
    ),
    /Every released reference must belong/,
  );

  assert.deepEqual(await store.claims(), [original]);
});

for (const size of [1, 8])
  test(`reconciliation batches ${size} groups and retains the exact live owners`, async (t) => {
    const cleanup = orderedCleanup(t.onTestFinished);
    const root = await scratch('witch-reconcile-batch-');
    const store = await StateStore.open(root);
    const registry = await CoordinationStore.open(store);
    const exited = spawn(process.execPath, ['-e', '']);
    await once(exited, 'close');

    const claims: TaskClaim[] = [],
      liveClaims: TaskClaim[] = [];

    const selections: SelectionTicket[] = [],
      liveSelections: SelectionTicket[] = [];

    for (let index = 0; index < size; index++) {
      for (const kind of [
        'live',
        'exited',
        'reused',
        'legacy-held',
        'legacy-free',
      ]) {
        const id = `${kind}-${index}`;

        const entry: TaskClaim = {
          id: randomUUID(),
          owner: { conversation: id, project: 'project-p' },
          references: [`named:project-p:${id}`],
          summary: id,
          createdAt: index,
        };

        if (kind === 'live') entry.process = identity;
        else if (kind === 'exited')
          entry.process = { ...identity, pid: exited.pid! };
        else if (kind === 'reused')
          entry.process = { ...identity, started: 'previous incarnation' };
        else {
          const held = await store.create(record(id, root));

          if (kind === 'legacy-held') cleanup(() => held.close());
          else await held.close();
        }

        claims.push(entry);

        if (kind === 'live' || kind === 'legacy-held') liveClaims.push(entry);
      }

      for (const active of [true, false]) {
        const ticket: SelectionTicket = {
          id: randomUUID(),
          owner: { conversation: randomUUID(), project: 'project-p' },
          activation: randomUUID(),
          turn: randomUUID(),
        };

        const close = await registry.holdActivation(ticket.activation);

        if (active) {
          cleanup(close);
          liveSelections.push(ticket);
        } else await close();

        selections.push(ticket);
      }
    }

    const file = join(root, 'coordination', 'claims.json');
    const original = JSON.stringify({ version: 2, claims, selections });
    await writeFile(file, original);
    const probes = await countProbes(() => registry.state());

    assert.deepEqual(probes.value, {
      claims: liveClaims,
      selections: liveSelections,
    });

    assert.equal(await readFile(file, 'utf8'), original);
    assert.ok(probes.ps <= 1, `${probes.ps} process probes`);
    assert.ok(probes.perl <= 2, `${probes.perl} lock probes`);

    await assert.rejects(
      registry.claim(owner, input, identity, Date.now() + 5000, async () => {
        throw new Error('verification rejected');
      }),
      /verification rejected/,
    );

    assert.equal(await readFile(file, 'utf8'), original);
  });

test('activation observation follows release without retaining ownership', async () => {
  const root = await scratch('witch-activation-observation-');
  const store = await CoordinationStore.open(await StateStore.open(root));
  const activation = randomUUID();
  const close = await store.holdActivation(activation);

  try {
    assert.deepEqual(
      await Promise.all([
        store.activeActivations([activation, activation]),
        store.activeActivations([activation]),
      ]),
      [new Set([activation]), new Set([activation])],
    );
  } finally {
    await close();
  }

  assert.deepEqual(
    await Promise.all([
      store.activeActivations([activation]),
      store.activeActivations([activation]),
    ]),
    [new Set(), new Set()],
  );

  await assert.rejects(
    access(join(root, 'coordination', 'sessions', `${activation}.lock`)),
    { code: 'ENOENT' },
  );
});

function contender(
  register: RegisterCleanup,
  root: string,
  conversation: string,
) {
  const child = fork(
    fileURLToPath(
      new URL('../fixtures/coordination-owner.mts', import.meta.url),
    ),
    [root, conversation],
    {
      cwd: root,
      execArgv: ['--import', import.meta.resolve('tsx')],
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    },
  );

  const ended = new Promise<void>((resolve) =>
    child.once('exit', () => resolve()),
  );

  register(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');

    await ended;
  });

  const ready = within(once(child, 'message'), 5000, 'owner ready');

  return {
    ready,
    claim: async () => {
      const reply = within(once(child, 'message'), 7000, 'owner response');
      child.send('claim');
      const [message] = await reply;

      return message as { kind: string; claim: TaskClaim };
    },
  };
}

test('two independent claimants have one owner and only its work starts', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const root = await scratch('witch-coordination-race-');
  const a = contender(cleanup, root, 'a');
  const b = contender(cleanup, root, 'b');
  await Promise.all([a.ready, b.ready]);
  const results = await Promise.all([a.claim(), b.claim()]);

  assert.deepEqual(results.map(({ kind }) => kind).sort(), [
    'claimed',
    'conflict',
  ]);

  const winner = results.find(({ kind }) => kind === 'claimed')!.claim;
  const loser = results.find(({ kind }) => kind === 'conflict')!.claim;
  assert.deepEqual(loser, winner);
  const store = await CoordinationStore.open(await StateStore.open(root));
  assert.deepEqual(await store.claims(), [winner]);

  assert.deepEqual(
    (await readdir(root)).filter((name) => name.endsWith('.worked')),
    [`${winner.owner.conversation}.worked`],
  );
});

test('an alias collision stores none of the requested references', async () => {
  const root = await scratch('witch-coordination-alias-');
  const store = await CoordinationStore.open(await StateStore.open(root));
  const reserved = await claim(store);
  const file = join(root, 'coordination', 'claims.json');
  const before = await readFile(file, 'utf8');

  await assert.rejects(
    claim(
      store,
      { ...owner, conversation: 'b' },
      {
        reference: 'task:free',
        aliases: ['task:shared'],
        summary: 'Losing task',
      },
    ),
    (error) => error instanceof ClaimConflict && error.claim.id === reserved.id,
  );

  assert.equal(await readFile(file, 'utf8'), before);
});

test('a retry preserves identity while updating its summary and merging aliases', async () => {
  const store = await CoordinationStore.open(
    await StateStore.open(await scratch('witch-coordination-retry-')),
  );

  const first = await claim(store, owner, {
    reference: 'https://github.com/Acme/Kit/issues/17?view=one#comment',
    summary: 'First summary',
  });

  const retried = await claim(store, owner, {
    reference: 'https://github.com/acme/kit/pull/17/',
    aliases: ['task:  Release   PATCH  ', 'task:release patch'],
    summary: 'Second summary',
  });

  assert.deepEqual(retried, {
    ...first,
    references: ['github:acme/kit#17', 'task:project-p:release patch'],
    summary: 'Second summary',
  });

  assert.deepEqual(await store.claims(), [retried]);

  await assert.rejects(
    claim(store, owner, {
      reference: 'task:separate',
      summary: 'Another task',
    }),
    /Release the current task/,
  );

  await assert.rejects(
    claim(store, { ...owner, project: 'project-q' }),
    /Release/,
  );

  assert.deepEqual(await store.claims(), [retried]);
});

test('only the matching owner and exact claim id can release a reservation', async () => {
  const root = await scratch('witch-coordination-release-');
  const store = await CoordinationStore.open(await StateStore.open(root));
  const first = await claim(store);
  const file = join(root, 'coordination', 'claims.json');
  const before = await readFile(file, 'utf8');

  for (const wrong of [
    { ...owner, conversation: 'b' },
    { ...owner, project: 'project-q' },
  ])
    await assert.rejects(release(store, wrong, first.id), /Only the owning/);

  assert.equal(await readFile(file, 'utf8'), before);
  await release(store, owner, first.id);

  const next = await claim(store, owner, {
    reference: 'task:next',
    summary: 'Next',
  });

  assert.notEqual(next.id, first.id);
  await release(store, owner, first.id);
  assert.deepEqual(await store.claims(), [next]);
});

test('normalized named tasks conflict within a project and stay separate across projects', async () => {
  const store = await CoordinationStore.open(
    await StateStore.open(await scratch('witch-coordination-projects-')),
  );

  await claim(store);

  await assert.rejects(
    claim(
      store,
      { ...owner, conversation: 'b' },
      {
        reference: 'task: SHARED ',
        summary: 'Duplicate',
      },
    ),
    ClaimConflict,
  );

  await claim(store, { conversation: 'b', project: 'project-q' });

  assert.deepEqual(
    (await store.claims()).map((entry) => entry.references),
    [['task:project-p:shared'], ['task:project-q:shared']],
  );
});

for (const variant of [
  'https://github.com/ACME/KIT/issues/17',
  'https://github.com/acme/kit/issues/17/?q=one#two',
  'https://github.com/acme/kit/pull/17/',
  'https://github.com/%61cme/kit/issues/17',
]) {
  test(`GitHub spelling ${variant} conflicts with its existing number`, async () => {
    const store = await CoordinationStore.open(
      await StateStore.open(await scratch('witch-coordination-url-')),
    );

    await claim(store, owner, {
      reference: 'https://github.com/acme/kit/issues/17',
      summary: 'Reserved',
    });

    await assert.rejects(
      claim(
        store,
        { conversation: 'b', project: 'project-q' },
        {
          reference: variant,
          summary: 'Duplicate',
        },
      ),
      ClaimConflict,
    );
  });
}

test('bounded ledger reads wait for the reservation lock and release it', async () => {
  const root = await scratch('witch-coordination-read-lock-');
  const store = await CoordinationStore.open(await StateStore.open(root));

  const lock = await openLocked(
    join(root, 'coordination', 'lock'),
    constants.O_CREAT | constants.O_RDWR | constants.O_NONBLOCK,
    { mode: 0o600 },
  );

  try {
    await assert.rejects(store.state(Date.now() + 50), /expired/);
    assert.deepEqual(await store.claims(), []);
  } finally {
    await lock.close();
  }

  assert.deepEqual(await store.state(Date.now() + 1000), {
    claims: [],
    selections: [],
  });

  const held = await claim(store);

  assert.deepEqual(await store.state(Date.now() + 1000), {
    claims: [held],
    selections: [],
  });
});

for (const damage of ['invalid JSON', 'unreadable'] as const) {
  test(`an ${damage} ledger refuses mutations without replacing its bytes`, async () => {
    const root = await scratch('witch-coordination-damaged-');
    const store = await CoordinationStore.open(await StateStore.open(root));
    await claim(store);
    const file = join(root, 'coordination', 'claims.json');

    if (damage === 'invalid JSON') await writeFile(file, '{');

    const before = await readFile(file, 'utf8');

    if (damage === 'unreadable') await chmod(file, 0o000);

    try {
      await assert.rejects(claim(store, { ...owner, conversation: 'b' }));
      await assert.rejects(release(store, owner, randomUUID()));
    } finally {
      await chmod(file, 0o600);
    }

    assert.equal(await readFile(file, 'utf8'), before);
  });
}

test('verification receives the reconciled ledger under the reservation lock', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const root = await scratch('witch-coordination-authority-');
  const store = await CoordinationStore.open(await StateStore.open(root));

  const live = await claim(
    store,
    { ...owner, conversation: 'other' },
    {
      reference: 'task:other',
      summary: 'Other live owner',
    },
  );

  const stale = {
    ...live,
    id: randomUUID(),
    owner: { ...owner, conversation: 'exited' },
    references: ['task:project-p:exited'],
    process: { ...identity, started: 'previous incarnation' },
  };

  const file = join(root, 'coordination', 'claims.json');

  const original = JSON.stringify({
    version: 2,
    claims: [live, stale],
    selections: [],
  });

  await writeFile(file, original);

  await assert.rejects(
    store.claim(owner, input, identity, Date.now() + 5000, async (ledger) => {
      assert.deepEqual(ledger, { claims: [live], selections: [] });
      const lock = join(root, 'coordination', 'lock');
      assert.equal((await lockedFiles([lock])).get(lock), 'exclusive');

      throw new Error('Revoked');
    }),
    /Revoked/,
  );

  assert.equal(await readFile(file, 'utf8'), original);
  assert.deepEqual(await store.claims(), [live]);
  const next = contender(cleanup, root, 'b');
  await next.ready;
  const result = await next.claim();
  assert.equal(result.kind, 'claimed');
  assert.equal(result.claim.owner.conversation, 'b');
});

test('a failed mutation releases the ledger lock without releasing the task', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const root = await scratch('witch-coordination-failure-');
  const store = await CoordinationStore.open(await StateStore.open(root));
  const held = await claim(store);

  await assert.rejects(
    release(store, { ...owner, conversation: 'b' }, held.id),
  );

  const next = contender(cleanup, root, 'b');
  await next.ready;
  const result = await next.claim();
  assert.equal(result.kind, 'conflict');
  assert.deepEqual(result.claim, held);
});

test('presence removal cannot delete a newer activation or its task claim', async () => {
  const root = await scratch('witch-coordination-presence-');
  const conversations = await StateStore.open(root);
  const files = await conversations.create(record('a', root));

  try {
    const store = await CoordinationStore.open(conversations);
    const held = await claim(store);

    const first: SessionPresence = {
      id: 'a',
      title: 'First',
      cwd: root,
      agent: 'codex',
      project: 'project-p',
      version: 1,
      activation: randomUUID(),
      process: (await identifyProcess(process.pid))!,
      phase: 'idle',
      requests: 0,
      familiars: 0,
      brews: 0,
      openedAt: 1,
      updatedAt: 2,
    };

    await store.publish(first);

    const next = {
      ...first,
      activation: randomUUID(),
      title: 'Second',
      updatedAt: 3,
    };

    await store.publish(next);
    await store.removePresence('a', first.activation);
    assert.deepEqual(await store.presences(), [next]);
    await store.removePresence('a', next.activation);
    assert.deepEqual(await store.presences(), []);
    assert.deepEqual(await store.claims(), [held]);
  } finally {
    await files.close();
  }
});

async function transferFixture(
  register: RegisterCleanup,
  field: TransferField,
) {
  const root = await scratch('witch-transfer-');
  const store = await CoordinationStore.open(await StateStore.open(root));
  const sleeper = spawn('/bin/sleep', ['60']);
  const closed = once(sleeper, 'close');

  register(async () => {
    sleeper.kill();
    await closed;
  });

  await once(sleeper, 'spawn');
  // a requester distinct from the owner, so a hand-over that keeps the owner's process shows
  const requester = (await identifyProcess(sleeper.pid!))!;

  const hold = async () => {
    const activation = randomUUID();
    const close = await store.holdActivation(activation);
    register(close);

    return { activation, close };
  };

  return {
    store,
    file: join(root, 'coordination', 'claims.json'),
    requester,
    hold,
    request: async (
      to: ClaimOwner,
      activation: string,
      expires = Date.now() + 60_000,
    ) =>
      store.requestTransfer(
        to,
        field === 'transfer'
          ? { field, reference: 'task:shared' }
          : {
              field,
              input,
              claim: (await store.claims()).find(
                (entry) => entry.owner.conversation === owner.conversation,
              )!,
            },
        { activation, process: requester, expires: () => expires },
        Date.now() + 5000,
        verify,
      ),
    handOver: (
      id: string,
      refusal: () => string | undefined = () => undefined,
    ) => store.handOver(owner, id, Date.now() + 5000, verify, refusal, field),
  };
}

const taker = { conversation: 'b', project: 'project-p' };

test('a captured automatic conflict cannot take a retained main claim after its side references are released', async (t) => {
  const f = await transferFixture(
    orderedCleanup(t.onTestFinished),
    'automaticTransfer',
  );

  const original = await claim(f.store, owner, {
    ...input,
    aliases: ['task:side'],
  });

  const request = {
    reference: 'task:new',
    aliases: ['task:side'],
    summary: 'Side work',
  };

  await assert.rejects(claim(f.store, taker, request), ClaimConflict);

  const released = await f.store.releaseReferences(
    owner,
    original.id,
    ['task:side'],
    Date.now() + 5000,
    verify,
  );

  await assert.rejects(
    f.store.requestTransfer(
      taker,
      { field: 'automaticTransfer', claim: original, input: request },
      {
        activation: (await f.hold()).activation,
        process: f.requester,
        expires: () => Date.now() + 5000,
      },
      Date.now() + 5000,
      verify,
    ),
    /conflicting references were released/,
  );

  assert.deepEqual(await f.store.claims(), [released.claim]);
  const side = await claim(f.store, taker, request);
  assert.equal(side.owner.conversation, taker.conversation);
  assert.deepEqual(await f.store.claims(), [released.claim, side]);
});

test('an automatic transfer still follows a conflict caused only by a requested alias', async (t) => {
  const f = await transferFixture(
    orderedCleanup(t.onTestFinished),
    'automaticTransfer',
  );

  const original = await claim(f.store);

  const request = {
    reference: 'task:new',
    aliases: ['task:shared'],
    summary: 'Related work',
  };

  await f.store.requestTransfer(
    taker,
    { field: 'automaticTransfer', claim: original, input: request },
    {
      activation: (await f.hold()).activation,
      process: f.requester,
      expires: () => Date.now() + 5000,
    },
    Date.now() + 5000,
    verify,
  );

  const moved = await f.handOver(original.id);
  assert.equal(moved!.id, original.id);
  assert.deepEqual(moved!.references, original.references);
  assert.deepEqual(moved!.owner, taker);
});

test('a transfer request reads its expiry when it is written, after verification', async (t) => {
  const f = await transferFixture(orderedCleanup(t.onTestFinished), 'transfer');
  await claim(f.store);
  const { activation } = await f.hold();
  const real = Date.now.bind(Date);
  let waited = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => real() + waited);
  const started = Date.now();

  const requested = await f.store.requestTransfer(
    taker,
    { field: 'transfer', reference: 'task:shared' },
    { activation, process: f.requester, expires: () => Date.now() + 8000 },
    started + 30_000,
    async () => {
      waited = 9000;
    },
  );

  const stored = (await f.store.claims())[0]!.transfer!.expires;
  assert.equal(requested.transfer!.expires, stored);
  assert.ok(stored >= started + 17_000, String(stored - started));
});

for (const field of ['transfer', 'automaticTransfer'] as const)
  test(`reference release preserves a pending ${field}, including its refusal`, async (t) => {
    const f = await transferFixture(orderedCleanup(t.onTestFinished), field);

    const original = await claim(f.store, owner, {
      ...input,
      aliases: ['task:side'],
    });

    const { activation } = await f.hold();
    await f.request(taker, activation);

    for (const refused of [false, true]) {
      if (refused) await f.handOver(original.id, () => 'Still working');

      const before = await f.store.claims();

      await assert.rejects(
        f.store.releaseReferences(
          owner,
          original.id,
          ['task:side'],
          Date.now() + 5000,
          verify,
        ),
        /pending task transfer/,
      );

      assert.deepEqual(await f.store.claims(), before);
    }

    await f.store.withdrawTransfer(
      activation,
      original.id,
      Date.now() + 5000,
      verify,
      field,
    );

    const released = await f.store.releaseReferences(
      owner,
      original.id,
      ['task:side'],
      Date.now() + 5000,
      verify,
    );

    assert.deepEqual(released.claim!.references, ['task:project-p:shared']);
  });

test('automatic transfer never follows a released reference onto a replacement claim', async (t) => {
  const f = await transferFixture(
    orderedCleanup(t.onTestFinished),
    'automaticTransfer',
  );

  const original = await claim(f.store);
  await release(f.store, owner, original.id);
  const replacement = await claim(f.store);
  const { activation } = await f.hold();

  await assert.rejects(
    f.store.requestTransfer(
      taker,
      { field: 'automaticTransfer', claim: original, input },
      { activation, process: f.requester, expires: () => Date.now() + 5000 },
      Date.now() + 5000,
      verify,
    ),
    /conflicting claim was released/,
  );

  assert.deepEqual(await f.store.claims(), [replacement]);
});

test('automatic transfer refuses a claim that moved since the conflict', async (t) => {
  const f = await transferFixture(orderedCleanup(t.onTestFinished), 'transfer');
  const original = await claim(f.store);
  await f.request(taker, (await f.hold()).activation);
  const moved = await f.handOver(original.id);
  const third = { conversation: 'c', project: 'project-p' };

  await assert.rejects(
    f.store.requestTransfer(
      third,
      { field: 'automaticTransfer', claim: original, input },
      {
        activation: (await f.hold()).activation,
        process: identity,
        expires: () => Date.now() + 5000,
      },
      Date.now() + 5000,
      verify,
    ),
    ClaimConflict,
  );

  assert.deepEqual(await f.store.claims(), [moved]);
});

for (const field of ['transfer', 'automaticTransfer'] as const)
  test(`${field} excludes a competing request of the other kind`, async (t) => {
    const f = await transferFixture(orderedCleanup(t.onTestFinished), field);
    const original = await claim(f.store);
    await f.request(taker, (await f.hold()).activation);
    const before = await readFile(f.file, 'utf8');

    await assert.rejects(
      f.store.requestTransfer(
        { conversation: 'c', project: 'project-p' },
        field === 'transfer'
          ? { field: 'automaticTransfer', claim: original, input }
          : { field: 'transfer', reference: 'task:shared' },
        {
          activation: (await f.hold()).activation,
          process: identity,
          expires: () => Date.now() + 5000,
        },
        Date.now() + 5000,
        verify,
      ),
    );

    assert.equal(await readFile(f.file, 'utf8'), before);
  });

for (const field of ['transfer', 'automaticTransfer'] as const) {
  test(`${field}: a transfer moves the claim with its identity and drops the requester's suggestion`, async (t) => {
    const f = await transferFixture(orderedCleanup(t.onTestFinished), field);

    const original = await claim(f.store, owner, {
      ...input,
      aliases: ['task:alias'],
    });

    const assigned = await f.store.recordAssignment(
      original.id,
      ['github:o/r#1'],
      Date.now() + 5000,
      verify,
    );

    const { activation } = await f.hold();
    const scope = { owner: taker, activation, turn: randomUUID() };

    const { ticket } = await f.store.beginSelection(
      scope,
      Date.now() + 5000,
      verify,
    );

    await f.store.recommend(
      scope,
      ticket.id,
      { reference: 'task:suggested', summary: 'Suggested work' },
      identity,
      Date.now() + 5000,
      verify,
    );

    await f.request(taker, activation);
    const moved = await f.handOver(original.id);
    assert.deepEqual(await f.store.claims(), [moved]);

    assert.deepEqual(moved, {
      ...assigned,
      owner: taker,
      process: f.requester,
      movedFrom: owner,
    });
  });

  test(`${field}: a second requester is refused while a transfer is pending or refused`, async (t) => {
    const f = await transferFixture(orderedCleanup(t.onTestFinished), field);
    const original = await claim(f.store);
    await f.request(taker, (await f.hold()).activation);
    const third = { conversation: 'c', project: 'project-p' };
    const { activation } = await f.hold();

    for (const refusal of [undefined, 'It is running.']) {
      if (refusal) await f.handOver(original.id, () => refusal);

      const before = await readFile(f.file, 'utf8');

      await assert.rejects(
        f.request(third, activation),
        field === 'transfer'
          ? /Another conversation is already taking this task\./
          : ClaimConflict,
      );

      assert.equal(await readFile(f.file, 'utf8'), before);
    }
  });

  test(`${field}: a refusal stays on the request, and a withdrawal clears only the requester's own request`, async (t) => {
    const f = await transferFixture(orderedCleanup(t.onTestFinished), field);
    const original = await claim(f.store);
    const { activation } = await f.hold();
    await f.request(taker, activation);
    const refused = await f.handOver(original.id, () => 'It is running.');
    assert.equal(refused?.[field]?.refusal, 'It is running.');
    assert.equal(await f.handOver(original.id), undefined);
    assert.deepEqual(await f.store.claims(), [refused]);

    const withdraw = (from: string) =>
      f.store.withdrawTransfer(
        from,
        original.id,
        Date.now() + 5000,
        verify,
        field,
      );

    assert.deepEqual(await withdraw(randomUUID()), refused);
    assert.deepEqual(await withdraw(activation), original);
    assert.deepEqual(await f.store.claims(), [original]);
  });

  test(`${field}: a hand-over refuses a requester that has since claimed another task`, async (t) => {
    const f = await transferFixture(orderedCleanup(t.onTestFinished), field);
    const original = await claim(f.store);
    await f.request(taker, (await f.hold()).activation);

    const other = await claim(f.store, taker, {
      reference: 'task:other',
      summary: 'Other task',
    });

    const refused = await f.handOver(original.id);
    assert.deepEqual(refused?.owner, owner);

    assert.equal(
      refused?.[field]?.refusal,
      'The requesting conversation holds another task. Release it there, then run /task take again.',
    );

    assert.deepEqual(await f.store.claims(), [refused, other]);
  });

  test(`${field}: reconcile drops a transfer whose requester activation is released or whose wait expired`, async (t) => {
    const f = await transferFixture(orderedCleanup(t.onTestFinished), field);
    const original = await claim(f.store);
    const left = await f.hold();
    await f.request(taker, left.activation);
    await left.close();
    assert.deepEqual(await f.store.claims(), [original]);
    await f.request(taker, (await f.hold()).activation, Date.now() + 50);
    await delay(100);
    assert.deepEqual(await f.store.claims(), [original]);
    assert.equal(await f.handOver(original.id), undefined);
    assert.deepEqual(await f.store.claims(), [original]);
  });
}

test('pause records track each recipient and replay only their own retry', async () => {
  const root = await scratch('witch-pauses-');
  const store = await CoordinationStore.open(await StateStore.open(root));
  const issuer = { conversation: 'i', project: 'project-p' };
  const a = { conversation: 'a', project: 'project-p' };
  const b = { conversation: 'b', project: 'project-q' };
  const deadline = () => Date.now() + 1000;

  const status = async (id: string) =>
    pauseStatuses(await store.pause('i', id));

  const pause = await store.issuePause(
    issuer,
    'turn-1',
    ['a', 'b'],
    deadline(),
    async () => [a, b, a],
  );

  assert.deepEqual(
    pause.recipients.map(({ conversation }) => conversation),
    ['a', 'b'],
  );

  assert.deepEqual(await status(pause.id), { a: 'pending', b: 'pending' });
  await store.confirmPause('a', pause.id, deadline());
  const confirmed = entry(await store.pause('a', pause.id), 'a')!.confirmedAt;
  await delay(5);
  await store.confirmPause('a', pause.id, deadline());

  assert.equal(
    entry(await store.pause('a', pause.id), 'a')!.confirmedAt,
    confirmed,
  );

  assert.deepEqual(await status(pause.id), { a: 'paused', b: 'pending' });
  await store.resumeByUser('a', [pause.id], deadline());
  assert.deepEqual(await status(pause.id), { a: 'resumed', b: 'pending' });
  // a timed-out --pause rerun in the same turn gets the recorded pause back, even after a resume
  const refused = async () => assert.fail('a retry reverifies');

  const retried = await store.issuePause(
    issuer,
    'turn-1',
    ['a', 'b'],
    deadline(),
    refused,
  );

  assert.equal(retried.id, pause.id);

  for (const [turn, requested] of [
    ['turn-2', ['a', 'b']],
    ['turn-1', ['b']],
    [undefined, ['a', 'b']],
    [undefined, ['a', 'b']],
  ] as const)
    assert.notEqual(
      (
        await store.issuePause(
          issuer,
          turn,
          requested,
          deadline(),
          async () => [b],
        )
      ).id,
      pause.id,
    );

  await assert.rejects(store.resumePause('a', pause.id, deadline()), {
    message: `Only the issuing session can resume pause ${pause.id}.`,
  });

  const lifted = await store.resumePause('i', pause.id, deadline());

  assert.deepEqual(
    lifted.recipients.map(({ resumedBy }) => resumedBy),
    ['user', 'issuer'],
  );

  assert.deepEqual(await status(pause.id), { a: 'resumed', b: 'resumed' });
  const pauses = await store.pauses('a');

  assert.deepEqual(
    pauses.map(({ id }) => id),
    [pause.id],
  );

  assert.equal((await store.pauses('i')).length, 5);
  assert.deepEqual(await store.pauses('other'), []);
});

/** a ledger read whose `probe` fails with the clock moved past the read's deadline. */
async function readPastDeadline(
  probe: 'openConversations' | 'activeActivations',
  failure: object,
  other?: Error,
) {
  const state = await StateStore.open(await scratch('witch-probe-failure-'));
  const registry = await CoordinationStore.open(state);
  const deadline = Date.now() + 30_000;

  const fail = async (): Promise<never> => {
    vi.spyOn(Date, 'now').mockReturnValue(deadline + 1);

    throw Object.assign(new Error('Command failed: /usr/bin/perl'), failure);
  };

  const pass =
    <T>(value: T) =>
    async () => {
      if (other) throw other;

      return value;
    };

  vi.spyOn(state, 'openConversations').mockImplementation(
    probe === 'openConversations' ? fail : pass(new Map()),
  );

  vi.spyOn(registry, 'activeActivations').mockImplementation(
    probe === 'activeActivations' ? fail : pass(new Set<string>()),
  );

  return registry.state(deadline);
}

/** how execFile reports a probe it killed at its timeout. */
const killedBySignal = { killed: true, code: null, signal: 'SIGKILL' };

test('a ledger read preserves a probe killed before its deadline', async () => {
  const state = await StateStore.open(await scratch('witch-probe-failure-'));
  const registry = await CoordinationStore.open(state);
  const now = Date.now();

  const failure = Object.assign(
    new Error('Command failed: /usr/bin/perl'),
    killedBySignal,
  );

  vi.spyOn(Date, 'now').mockReturnValue(now);
  vi.spyOn(registry, 'activeActivations').mockRejectedValue(failure);

  await assert.rejects(registry.state(now + 30_000), (error: unknown) => {
    assert.equal(error, failure);

    return true;
  });
});

test('a ledger read whose probe is killed at its deadline reports the deadline', async (t) => {
  t.onTestFinished(() => {
    vi.restoreAllMocks();
  });

  await assert.rejects(
    readPastDeadline('activeActivations', killedBySignal),
    DeadlineExpired,
  );
});

test("a ledger read keeps a later probe's own failure when an earlier probe is killed at the deadline", async (t) => {
  t.onTestFinished(() => {
    vi.restoreAllMocks();
  });

  await assert.rejects(
    readPastDeadline(
      'openConversations',
      killedBySignal,
      Object.assign(new Error('EACCES: Could not inspect lock'), {
        code: 'EACCES',
      }),
    ),
    /EACCES/,
  );
});

test('a ledger read keeps the failure of a probe that exited by itself as its timeout fired', async (t) => {
  t.onTestFinished(() => {
    vi.restoreAllMocks();
  });

  await assert.rejects(
    readPastDeadline('activeActivations', {
      killed: true,
      code: 255,
      signal: null,
    }),
    /Command failed/,
  );
});
