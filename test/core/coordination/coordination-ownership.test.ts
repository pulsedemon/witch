import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { constants, promises as files } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  SelectionTicket,
  TaskClaim,
} from '../../../src/core/coordination/coordination-state.js';
import { SessionCoordination } from '../../../src/core/coordination/coordination.js';
import { Memory } from '../../../src/memory/memory.js';
import { CoordinationStore } from '../../../src/persistence/coordination.js';
import { callControl } from '../../../src/persistence/control.js';
import { openLocked } from '../../../src/persistence/lock.js';
import { ConversationStore } from '../../../src/persistence/store.js';
import { identifyProcess } from '../../../src/persistence/process.js';
import {
  git,
  legacyLock,
  measureControl,
  pauseDiscovery,
  unitCoordinationFixture,
} from '../../fixtures/coordination.js';
import { record } from '../../fixtures/coordinator.js';
import { selectionTurn } from '../../fixtures/task-selection.js';
import { until, within } from '../../fixtures/within.js';
import { countProbes } from '../../fixtures/probes.js';
import { orderedCleanup } from '../../fixtures/cleanup.js';

test('a live legacy owner blocks new work until its lock closes, and a reused identity is never treated as registered', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  const { root, start, store, registry } =
    await unitCoordinationFixture(cleanup);

  const a = await start();
  // select-next refuses while the legacy lock is held, so the ticket comes first
  const choosing = await selectionTurn(cleanup, a);
  const { ticket } = await choosing.select();
  const legacy = record(randomUUID(), join(root, 'B'));
  await (await store.create(legacy)).close();
  const lock = await legacyLock(store, legacy.id);
  cleanup(() => lock.close());
  const snapshot = await a.query();

  assert.deepEqual(
    snapshot.unregistered.map((p) => p.id),
    [legacy.id],
  );

  const waiting = await callControl(choosing.binding, {
    kind: 'selection-status',
    selection: ticket.id,
  });

  if (waiting.kind !== 'error') assert.fail(JSON.stringify(waiting));

  assert.match(waiting.message, /unregistered/);
  const blocked = await a.claim();
  assert.equal(blocked.kind, 'error');
  assert.deepEqual(await registry.claims(), []);
  const own = (await registry.presences())[0]!;

  await registry.publish({
    ...own,
    id: legacy.id,
    cwd: legacy.cwd,
    process: { ...own.process, started: 'wrong start time' },
  });

  assert.deepEqual(
    (await a.query()).unregistered.map((p) => p.id),
    [legacy.id],
  );

  await lock.close();
  assert.equal((await a.claim()).kind, 'claimed');
  assert.deepEqual((await a.query()).peers, []);
});

for (const name of ['B', 'C']) {
  test(`a missing directory in ${name === 'B' ? 'the same' : 'another'} project preserves claims without blocking discovery or selection`, async (t) => {
    const cleanup = orderedCleanup(t.onTestFinished);

    const { root, start, store, memory, registry } =
      await unitCoordinationFixture(cleanup);

    const a = await start();
    const choosing = await selectionTurn(cleanup, a);
    const cwd = join(root, name);
    const { project } = await memory.scopePaths(cwd);
    const legacy = record(randomUUID(), cwd);
    await (await store.create(legacy)).close();
    const lock = await legacyLock(store, legacy.id);
    cleanup(() => lock.close());
    const reference = 'https://github.com/acme/queue/issues/17';

    const held = await registry.claim(
      { conversation: legacy.id, project },
      { reference, summary: 'Existing task' },
      (await registry.presences())[0]!.process,
      Date.now() + 1000,
      async () => {},
    );

    await files.rename(cwd, `${cwd}-moved`);
    const snapshot = await a.query();
    assert.deepEqual(snapshot.unregistered, []);

    assert.deepEqual(
      snapshot.reservations,
      name === 'B' ? [{ claim: held, status: 'unknown' }] : [],
    );

    const duplicate = await a.claim(reference);

    if (duplicate.kind !== 'conflict') assert.fail(JSON.stringify(duplicate));

    assert.deepEqual(duplicate.claim, held);
    const available = await a.claim('task:available');

    if (available.kind !== 'claimed') assert.fail(JSON.stringify(available));

    assert.deepEqual(await registry.claims(), [held, available.claim]);

    const released = await callControl(choosing.binding, {
      kind: 'release',
      claim: available.claim.id,
    });

    assert.equal(released.kind, 'released');
    const selection = await choosing.select();
    assert.equal(selection.position, 1);
    assert.deepEqual((await registry.state()).selections, [selection.ticket]);
    assert.deepEqual(await registry.claims(), [held]);
    assert.equal(await store.isOpen(legacy.id), true);
  });
}

for (const failure of [
  { code: 'EACCES', syscall: 'realpath' },
  { code: 'ENOENT', syscall: 'spawn git' },
]) {
  test(`${failure.code} from ${failure.syscall} still blocks discovery and new ownership`, async (t) => {
    const cleanup = orderedCleanup(t.onTestFinished);

    const { root, start, store, memory, registry } =
      await unitCoordinationFixture(cleanup);

    const a = await start();
    const choosing = await selectionTurn(cleanup, a);
    const cwd = join(root, 'B');
    const legacy = record(randomUUID(), cwd);
    await (await store.create(legacy)).close();
    const lock = await legacyLock(store, legacy.id);
    cleanup(() => lock.close());
    const scopePaths = memory.scopePaths.bind(memory);
    const error = Object.assign(new Error('Cannot determine project'), failure);

    vi.spyOn(memory, 'scopePaths').mockImplementation((directory: string) =>
      directory === cwd ? Promise.reject(error) : scopePaths(directory),
    );

    const query = await callControl(await a.binding(), { kind: 'peers' });
    assert.equal(query.kind, 'error');

    if (query.kind === 'error')
      assert.match(query.message, /Cannot determine project/);

    assert.equal((await a.claim()).kind, 'error');

    const selection = await callControl(choosing.binding, {
      kind: 'select-next',
      turn: choosing.turn,
    });

    assert.equal(selection.kind, 'error');
    assert.deepEqual(await registry.state(), { claims: [], selections: [] });
  });
}

test('closing a conversation releases its claim even if its stale presence says it runs', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { start, registry } = await unitCoordinationFixture(cleanup);

  const a = await start(),
    b = await start('B');

  const result = await a.claim();
  assert.equal(result.kind, 'claimed');

  const stale = (await registry.presences()).find(
    (p) => p.id === a.coordinator.snapshot.conversation!.id,
  )!;

  await a.coordinator.close();
  await registry.publish(stale);
  const snapshot = await b.query();
  assert.deepEqual(snapshot.peers, []);
  assert.deepEqual(snapshot.reservations, []);
  assert.equal((await b.claim()).kind, 'claimed');
});

test('a failed presence removal cannot register a later legacy lock owner', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { start, store, registry } = await unitCoordinationFixture(cleanup);

  const a = await start(),
    b = await start('B');

  const old = await a.binding();
  const remove = CoordinationStore.prototype.removePresence;

  vi.spyOn(CoordinationStore.prototype, 'removePresence').mockImplementation(
    function (this: CoordinationStore, id: string, activation: string) {
      return id === old.conversation
        ? Promise.reject(new Error('presence removal failed'))
        : remove.call(this, id, activation);
    },
  );

  await a.coordinator.newConversation();

  assert.ok(
    (await registry.presences()).some((p) => p.id === old.conversation),
  );

  assert.equal(
    (await registry.activeActivations([old.activation])).has(old.activation),
    false,
  );

  const legacy = await legacyLock(store, old.conversation);

  try {
    assert.equal((await b.claim('task:other')).kind, 'error');
    const snapshot = await b.query();

    assert.deepEqual(
      snapshot.unregistered.map((p) => p.id),
      [old.conversation],
    );

    assert.ok(snapshot.peers.every((p) => p.presence.id !== old.conversation));
    assert.deepEqual(await registry.claims(), []);
  } finally {
    await legacy.close();
  }

  assert.equal((await b.claim('task:other')).kind, 'claimed');
});

for (const window of ['opening', 'closing', 'reconnecting'] as const) {
  test(`a peer ${window} a conversation neither refuses a claim nor ends a selection wait`, async (t) => {
    const cleanup = orderedCleanup(t.onTestFinished);
    const { start, store, registry } = await unitCoordinationFixture(cleanup);

    const a = await start(),
      b = await start('B');

    const choosing = await selectionTurn(cleanup, a);
    const { ticket } = await choosing.select();
    const id = b.coordinator.snapshot.conversation!.id;
    const gate = Promise.withResolvers<void>();
    let pending: Promise<void>;

    if (window !== 'closing') {
      const activate = b.coordination.activate.bind(b.coordination);

      vi.spyOn(b.coordination, 'activate').mockImplementation(
        async (...args: Parameters<typeof activate>) => {
          await gate.promise;

          return activate(...args);
        },
      );

      pending =
        window === 'opening'
          ? b.coordinator.newConversation()
          : b.coordinator.selectModel({ agent: 'b', id: 'b-model' });
    } else {
      const close = ConversationStore.prototype.close;

      vi.spyOn(ConversationStore.prototype, 'close').mockImplementation(
        async function (this: ConversationStore) {
          if (this.record.id === id) await gate.promise;

          return close.call(this);
        },
      );

      pending = b.coordinator.close();
    }

    // the fixture's teardown would close B while it waits on the gate
    try {
      // opening holds a new conversation; closing and reconnecting keep the original
      const held = () => b.coordinator.snapshot.conversation!.id;

      await until('B holding a conversation without presence', async () => {
        const presences = await registry.presences();

        return (
          (window !== 'opening' || held() !== id) &&
          presences.every((p) => p.id !== id && p.id !== held())
        );
      });

      assert.equal(await store.isOpen(held()), true);
      assert.deepEqual((await a.query()).unregistered, []);

      const waiting = await callControl(choosing.binding, {
        kind: 'selection-status',
        selection: ticket.id,
      });

      assert.equal(waiting.kind, 'selection', JSON.stringify(waiting));
      assert.equal((await a.claim(`task:${window}`)).kind, 'claimed');
    } finally {
      gate.resolve();
      await pending;
    }
  });
}

test('unknown discovery refuses both a successful query and new ownership', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  pauseDiscovery(vi.spyOn);
  const { start, store, registry } = await unitCoordinationFixture(cleanup);
  const a = await start();
  const id = randomUUID();
  const directory = join(store.root, 'conversations', id);

  const held = await store.create(
    record(id, a.coordinator.snapshot.conversation!.cwd),
  );

  cleanup(() => held.close());
  await files.writeFile(join(directory, 'state.json'), '{broken');
  const bound = await a.binding();

  const query = await measureControl(vi.spyOn, () =>
    callControl(bound, { kind: 'peers' }),
  );

  assert.equal(query.value.kind, 'error');
  assert.equal(query.discoveries, 1);
  const attempt = await measureControl(vi.spyOn, () => a.claim());
  assert.equal(attempt.value.kind, 'error');
  assert.equal(attempt.discoveries, 1);
  assert.deepEqual(await registry.claims(), []);
  const context = await a.coordination.context();
  assert.match(context.context, /Coordination is unavailable/);
  assert.match(context.context, /No selection turn is current/);
  assert.doesNotMatch(context.context, /When asked to choose/);
  assert.match(context.instructions, /When asked to choose/);
});

test('an origin change leaves a discoverable reservation in the original project until explicit release', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  const { root, start, ledger, registry } =
    await unitCoordinationFixture(cleanup);

  const a = await start(),
    b = await start('B');

  const result = await a.claim();
  assert.equal(result.kind, 'claimed');

  if (result.kind !== 'claimed') assert.fail();

  const before = await ledger(),
    bound = await a.binding();

  await git(
    '-C',
    join(root, 'A'),
    'remote',
    'set-url',
    'origin',
    join(root, 'other'),
  );

  const refused = await a.claim('task:new', 'New project');
  assert.equal(refused.kind, 'error');
  assert.equal(await ledger(), before);
  assert.deepEqual((await a.query()).ownClaim, result.claim);

  // presence republishes on a 100 ms timer after the origin change
  await until('A presence outside the original project', async () =>
    (await registry.presences()).some(
      (p) =>
        p.id === result.claim.owner.conversation &&
        p.project !== result.claim.owner.project,
    ),
  );

  const observer = await b.query();
  assert.deepEqual(observer.peers, []);

  assert.deepEqual(observer.reservations, [
    { claim: result.claim, status: 'owner-outside-project' },
  ]);

  assert.equal(
    (await callControl(bound, { kind: 'release', claim: result.claim.id }))
      .kind,
    'released',
  );

  const next = await a.claim('task:new');
  assert.equal(next.kind, 'claimed');

  if (next.kind !== 'claimed') assert.fail();

  assert.notEqual(next.claim.owner.project, result.claim.owner.project);

  assert.equal(
    (await callControl(bound, { kind: 'release', claim: result.claim.id }))
      .kind,
    'released',
  );

  assert.deepEqual((await a.query()).ownClaim, next.claim);
});

test('closing rejects a mutation waiting for the ledger and drains one already committing', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { start, store, registry } = await unitCoordinationFixture(cleanup);
  const a = await start();
  const bound = await a.binding();

  const lock = await openLocked(
    join(store.root, 'coordination', 'lock'),
    constants.O_CREAT | constants.O_RDWR | constants.O_NONBLOCK,
    { mode: 0o600 },
  );

  // a request the host hasn't read when it closes gets no reply, so wait for the request's own ledger read
  const deadline = Date.now() + 10_000;
  const waiting = Promise.withResolvers<void>();
  const state = CoordinationStore.prototype.state;

  vi.spyOn(CoordinationStore.prototype, 'state').mockImplementation(function (
    this: CoordinationStore,
    ...args: Parameters<typeof state>
  ) {
    if (args[0] === deadline) waiting.resolve();

    return state.apply(this, args);
  });

  const attempt = callControl(
    bound,
    { kind: 'claim', input: { reference: 'task:shared', summary: 'A task' } },
    deadline,
  );

  let closing: ReturnType<typeof a.coordinator.close> | undefined;
  const reads = Promise.withResolvers<void>();

  try {
    await within(waiting.promise, 5000, 'request waiting on lock');
    // project reads that crawl, as under other suites' spawn load, can't hold a closing session's refusal past the deadline
    const scope = Memory.prototype.scopePaths;

    vi.spyOn(Memory.prototype, 'scopePaths').mockImplementation(async function (
      this: Memory,
      ...args
    ) {
      await reads.promise;

      return scope.apply(this, args);
    });

    closing = a.coordinator.close();
    await lock.close();
    assert.equal((await attempt).kind, 'error');
    reads.resolve();
    await within(closing, 5000, 'close');
    assert.deepEqual(await registry.claims(), []);
  } finally {
    reads.resolve();
    await lock.close();
    await Promise.allSettled([attempt, closing]);
  }

  const b = await start('B');

  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();

  const rename = files.rename;

  vi.spyOn(files, 'rename').mockImplementation(
    async (...args: Parameters<typeof files.rename>) => {
      if (String(args[1]).endsWith('/coordination/claims.json')) {
        entered.resolve();
        await finish.promise;
      }

      return rename(...args);
    },
  );

  syncBuiltinESMExports();

  cleanup(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });

  const committing = b.claim();
  let draining: ReturnType<typeof b.coordinator.close> | undefined;

  try {
    await within(entered.promise, 5000, 'commit boundary');
    let closed = false;

    draining = b.coordinator.close().then(() => {
      closed = true;
    });

    await delay(50);
    assert.equal(closed, false);
    finish.resolve();
    assert.equal((await committing).kind, 'claimed');
    await within(draining, 5000, 'commit drain');
    assert.deepEqual(await registry.claims(), []);
    assert.deepEqual(await registry.presences(), []);
  } finally {
    finish.resolve();
    await Promise.allSettled([committing, draining]);
  }
});

test('a delayed presence writer drains before replacement activation publishes', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const { start, registry } = await unitCoordinationFixture(cleanup);
  const a = await start();
  const bound = await a.binding();

  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();

  const publish = CoordinationStore.prototype.publish;
  let held = false;

  vi.spyOn(CoordinationStore.prototype, 'publish').mockImplementation(
    async function (
      this: CoordinationStore,
      presence: Parameters<typeof publish>[0],
    ) {
      if (!held && presence.activation === bound.activation) {
        held = true;
        entered.resolve();
        await finish.promise;
      }

      return publish.call(this, presence);
    },
  );

  const deactivating = Promise.withResolvers<void>();
  const deactivate = SessionCoordination.prototype.deactivate;

  vi.spyOn(SessionCoordination.prototype, 'deactivate').mockImplementation(
    function (this: SessionCoordination) {
      deactivating.resolve();

      return deactivate.call(this);
    },
  );

  let switching: ReturnType<typeof a.coordinator.newConversation> | undefined;

  try {
    a.a.sessions.at(-1)!.options.onEvent({
      type: 'request',
      request: { id: 'q', kind: 'approval', title: 'Wait', detail: '' },
    });

    await within(entered.promise, 3000, 'delayed presence write');
    switching = a.coordinator.newConversation();
    await within(deactivating.promise, 5000, 'old activation deactivating');
    assert.equal((await callControl(bound, { kind: 'peers' })).kind, 'error');
    finish.resolve();
    await switching;
    const next = await a.binding();
    assert.notEqual(next.activation, bound.activation);

    assert.deepEqual(
      (await registry.presences()).map((p) => p.activation),
      [next.activation],
    );

    await a.coordinator.close();
    await delay(150);
    assert.deepEqual(await registry.presences(), []);
  } finally {
    finish.resolve();
    await switching?.catch(() => {});
  }
});

for (const size of [1, 8])
  test(
    'discovery probe counts stay bounded with ' + size + ' owner groups',
    async (t) => {
      const cleanup = orderedCleanup(t.onTestFinished);
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

      const { root, start, store, registry } =
        await unitCoordinationFixture(cleanup);

      cleanup(() => {
        vi.useRealTimers();
      });

      const a = await start();
      const own = (await registry.presences())[0]!;

      const claims: TaskClaim[] = [],
        tickets: SelectionTicket[] = [];

      const expectedPeers: string[] = [],
        legacyClaims: TaskClaim[] = [];

      const expectedOpenStatePaths = new Set([
        join(store.root, 'conversations', own.id, 'state.json'),
      ]);

      for (let index = 0; index < size; index++) {
        const child = spawn('/bin/sleep', ['60']);
        const ended = once(child, 'close');

        cleanup(async () => {
          child.kill();
          await ended;
        });

        await once(child, 'spawn');
        const identity = (await identifyProcess(child.pid!))!;

        for (const duplicate of [false, true]) {
          const id = 'peer-' + index + '-' + duplicate;
          const held = await store.create(record(id, join(root, 'B')));
          cleanup(() => held.close());
          expectedOpenStatePaths.add(join(held.directory, 'state.json'));
          const activation = randomUUID();
          const release = await registry.holdActivation(activation);
          cleanup(release);

          await registry.publish({
            ...own,
            id,
            title: id,
            cwd: join(root, 'B'),
            activation,
            process: identity,
            openedAt: index * 2 + Number(duplicate),
          });

          expectedPeers.push(id);

          claims.push({
            id: randomUUID(),
            owner: { conversation: id, project: own.project },
            references: ['named:' + own.project + ':' + id],
            summary: id,
            createdAt: index,
            process: identity,
          });

          tickets.push({
            id: randomUUID(),
            owner: { conversation: id, project: own.project },
            activation,
            turn: randomUUID(),
          });
        }

        const id = 'legacy-' + index;
        const held = await store.create(record(id, join(root, 'B')));
        cleanup(() => held.close());
        expectedOpenStatePaths.add(join(held.directory, 'state.json'));

        const legacy = {
          id: randomUUID(),
          owner: { conversation: id, project: own.project },
          references: ['named:' + own.project + ':' + id],
          summary: id,
          createdAt: index,
        };

        claims.push(legacy);
        legacyClaims.push(legacy);

        tickets.push({
          id: randomUUID(),
          owner: { conversation: 'released-' + index, project: own.project },
          activation: randomUUID(),
          turn: randomUUID(),
        });
      }

      for (let index = 0; index < (size === 1 ? 1 : 100); index++)
        await (
          await store.create(record('closed-' + index, join(root, 'B')))
        ).close();

      await files.writeFile(
        join(store.root, 'coordination', 'claims.json'),
        JSON.stringify({ version: 2, claims, selections: tickets }),
      );

      // the ledger's one-second default, here and when closing, can't cover these probes under load, and the counts don't depend on it
      const ledgers = CoordinationStore.prototype as unknown as Record<
        'state' | 'mutate',
        (deadline?: number, ...rest: unknown[]) => Promise<unknown>
      >;

      for (const method of ['state', 'mutate'] as const) {
        const original = ledgers[method];

        vi.spyOn(ledgers, method).mockImplementation(function (
          this: unknown,
          deadline,
          ...rest
        ) {
          return original.call(
            this,
            deadline === undefined ? undefined : Date.now() + 10_000,
            ...rest,
          );
        });
      }

      const readStatePaths: string[] = [];
      const read = files.readFile;

      const reading = vi
        .spyOn(files, 'readFile')
        .mockImplementation((...args: Parameters<typeof files.readFile>) => {
          if (
            typeof args[0] === 'string' &&
            args[0].startsWith(store.root) &&
            args[0].endsWith('/state.json')
          )
            readStatePaths.push(args[0]);

          return read(...args);
        });

      syncBuiltinESMExports();

      const probes = await countProbes(() => a.coordination.context()).finally(
        () => {
          reading.mockRestore();
          syncBuiltinESMExports();
        },
      );

      assert.deepEqual(
        a.coordination.snapshot.peers.map(({ presence }) => presence.id),
        expectedPeers,
      );

      assert.deepEqual(
        a.coordination.snapshot.peers.map(({ claim }) => claim),
        claims.filter((c) => c.process),
      );

      assert.deepEqual(
        a.coordination.snapshot.reservations,
        legacyClaims.map((claim) => ({ claim, status: 'unknown' })),
      );

      assert.deepEqual(
        a.coordination.snapshot.peers.map(({ selection }) => selection?.ticket),
        tickets.filter(
          (ticket) => !ticket.owner.conversation.startsWith('released-'),
        ),
      );

      assert.ok(probes.ps <= 3, probes.ps + ' process probes');
      assert.ok(probes.perl <= 6, probes.perl + ' lock probes');
      assert.deepEqual(new Set(readStatePaths), expectedOpenStatePaths);
      assert.equal(readStatePaths.length, expectedOpenStatePaths.size);
    },
  );

for (const damage of ['JSON', 'EACCES'])
  for (const locked of [false, true])
    for (const action of ['claim', 'select-next', 'recommend'])
      test(
        action +
          ' with ' +
          (locked ? 'open' : 'closed') +
          ' ' +
          damage +
          ' record',
        async (t) => {
          const cleanup = orderedCleanup(t.onTestFinished);

          const { start, store, root, ledger, registry } =
            await unitCoordinationFixture(cleanup);

          const a = await start();

          await files.writeFile(
            join(store.root, 'coordination', 'claims.json'),
            JSON.stringify({ version: 2, claims: [], selections: [] }),
          );

          const choosing =
            action === 'claim' ? undefined : await selectionTurn(cleanup, a);

          const selection =
            action === 'recommend' ? await choosing!.select() : undefined;

          const id = randomUUID();
          const held = await store.create(record(id, join(root, 'B')));
          cleanup(() => held.close());

          if (!locked) await held.close();

          const path = join(held.directory, 'state.json');

          if (damage === 'JSON') await files.writeFile(path, '{broken');
          else {
            await files.chmod(path, 0);
            cleanup(() => files.chmod(path, 0o600));
          }

          await files.writeFile(
            join(store.root, 'conversations', '.DS_Store'),
            'finder',
          );

          const before = await ledger();

          const result =
            action === 'claim'
              ? await a.claim('task:admission')
              : await callControl(
                  choosing!.binding,
                  action === 'select-next'
                    ? { kind: 'select-next', turn: choosing!.turn }
                    : {
                        kind: 'recommend',
                        selection: selection!.ticket.id,
                        input: {
                          reference: 'task:admission',
                          summary: 'Admission',
                        },
                      },
                );

          if (locked) {
            if (result.kind !== 'error') assert.fail(JSON.stringify(result));

            assert.match(result.message, /Cannot determine session ownership/);
            assert.ok(result.message.includes(id + '/state.json'));
            assert.equal(await ledger(), before);
          } else if (action === 'select-next') {
            if (result.kind !== 'selection')
              assert.fail(JSON.stringify(result));

            assert.equal(result.selection.position, 1);

            assert.equal(
              result.selection.ticket.owner.conversation,
              a.coordinator.snapshot.conversation!.id,
            );

            assert.deepEqual((await registry.state()).selections, [
              result.selection.ticket,
            ]);
          } else {
            if (result.kind !== 'claimed') assert.fail(JSON.stringify(result));

            assert.equal(
              result.claim.owner.conversation,
              a.coordinator.snapshot.conversation!.id,
            );

            assert.deepEqual((await registry.state()).claims, [result.claim]);
            assert.deepEqual((await registry.state()).selections, []);
          }
        },
      );
