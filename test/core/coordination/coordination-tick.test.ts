import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, vi } from 'vitest';
import type { SessionCoordination } from '../../../src/core/coordination/coordination.js';
import type { SessionPresence } from '../../../src/core/coordination/coordination-state.js';
import type { PullRequest } from '../../../src/core/repository/repository.js';
import { callControl } from '../../../src/persistence/control.js';
import { CoordinationStore } from '../../../src/persistence/coordination.js';
import type { Ledger } from '../../../src/persistence/coordination.js';
import { identifyProcess } from '../../../src/persistence/process.js';
import type { RegisterCleanup } from '../../fixtures/cleanup.js';
import { orderedCleanup } from '../../fixtures/cleanup.js';
import { unitCoordinationFixture, git } from '../../fixtures/coordination.js';
import { record } from '../../fixtures/coordinator.js';
import { countProbes } from '../../fixtures/probes.js';
import { until } from '../../fixtures/within.js';

/** waits for every refresh a tick started, including those a project change starts after it. */
async function settle(coordination: SessionCoordination) {
  for (;;) {
    await coordination['projecting']?.promise;

    const running = [
      coordination['refreshing']?.promise,
      coordination['events'].pending,
    ].filter((promise) => promise !== undefined);

    if (!running.length) return;

    await Promise.all(running);
  }
}

async function tick(coordination: SessionCoordination, milliseconds = 2000) {
  vi.advanceTimersByTime(milliseconds);
  await settle(coordination);
}

/** waits for `id`'s idle presence, then ticks past it and the presence write that follows. */
async function quiesce(
  fixture: Awaited<ReturnType<typeof unitCoordinationFixture>>,
  id: string,
  coordination: SessionCoordination,
) {
  await until('idle presence', async () =>
    (await fixture.registry.presences()).some(
      (presence) => presence.id === id && presence.phase === 'idle',
    ),
  );

  await tick(coordination);
  // the presence write after a project read is debounced by 100 ms
  await delay(150);
  await tick(coordination);
}

/** one Witch whose first ticks and presence writes are spent. */
async function idle(register: RegisterCleanup) {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  const fixture = await unitCoordinationFixture(register);

  register(() => {
    vi.useRealTimers();
  });

  const a = await fixture.start('A');
  const id = a.coordinator.snapshot.conversation!.id;
  await quiesce(fixture, id, a.coordination);

  const own = (await fixture.registry.presences()).find(
    (presence) => presence.id === id,
  )!;

  return { ...fixture, a, own };
}

/** a peer in project A's project whose process is a child that can be ended. */
async function livePeer(
  register: RegisterCleanup,
  f: Awaited<ReturnType<typeof idle>>,
): Promise<{ id: string; end: () => Promise<void> }> {
  const child = spawn('/bin/sleep', ['60']);
  const ended = once(child, 'close');

  register(async () => {
    child.kill();
    await ended;
  });

  await once(child, 'spawn');
  const id = 'peer-' + randomUUID();
  const held = await f.store.create(record(id, join(f.root, 'B')));
  register(() => held.close());
  const activation = randomUUID();
  register(await f.registry.holdActivation(activation));

  await f.registry.publish({
    ...f.own,
    id,
    title: id,
    cwd: join(f.root, 'B'),
    activation,
    process: (await identifyProcess(child.pid!))!,
  });

  return {
    id,
    end: async () => {
      child.kill();
      await ended;
    },
  };
}

const peers = (coordination: SessionCoordination) =>
  coordination.snapshot.peers.map(({ presence }) => presence.id);

const otherPresence = (own: SessionPresence): SessionPresence => ({
  ...own,
  id: randomUUID(),
  activation: randomUUID(),
});

const merged: PullRequest = {
  number: 17,
  url: 'https://github.com/example/project/pull/17',
  state: 'MERGED',
  branch: 'feat/merge',
  base: 'main',
  commit: 'head-1',
};

test("an idle Witch's ticks probe nothing until its coordination files change or a minute passes", async (t) => {
  const f = await idle(orderedCleanup(t.onTestFinished));

  const quiet = await countProbes(async () => {
    await tick(f.a.coordination);
    await tick(f.a.coordination);
  });

  assert.deepEqual(
    { ps: quiet.ps, perl: quiet.perl, git: quiet.git },
    { ps: 0, perl: 0, git: 0 },
  );

  await f.registry.publish(otherPresence(f.own));
  const changed = await countProbes(() => tick(f.a.coordination));
  assert.ok(changed.perl >= 1, `${changed.perl} lock probes`);
  const minute = await countProbes(() => tick(f.a.coordination, 60_000));

  assert.deepEqual(
    { ps: minute.ps, perl: minute.perl, git: minute.git },
    { ps: 0, perl: 1, git: 0 },
  );
});

test("another Witch's claim shows within a tick", async (t) => {
  const f = await idle(orderedCleanup(t.onTestFinished));

  await f.registry.claim(
    { conversation: randomUUID(), project: f.own.project },
    { reference: 'task:peer', summary: 'Peer work' },
    f.a.coordination['process'],
    Date.now() + 5000,
    async () => {},
  );

  await tick(f.a.coordination);
  assert.equal(f.a.coordination.snapshot.reservations.length, 1);
});

test('a merge another Witch records shows within a tick', async (t) => {
  const f = await idle(orderedCleanup(t.onTestFinished));
  await f.registry.recordMerge(f.own.project, merged, randomUUID(), [f.own.id]);
  await tick(f.a.coordination);
  assert.equal(f.a.coordination.events.mergeEvents(f.own.id).length, 1);
});

test('a peer whose process ends without removing its presence leaves at the next minute reread', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const f = await idle(cleanup);
  const peer = await livePeer(cleanup, f);
  await tick(f.a.coordination);
  assert.deepEqual(peers(f.a.coordination), [peer.id]);
  await peer.end();
  await tick(f.a.coordination);
  assert.deepEqual(peers(f.a.coordination), [peer.id]);
  await tick(f.a.coordination, 60_000);
  assert.deepEqual(peers(f.a.coordination), []);
});

test('a discovery that failed outside the tick retries on the next tick', async (t) => {
  const f = await idle(orderedCleanup(t.onTestFinished));
  const open = f.store.openConversations.bind(f.store);
  let failing = true;

  vi.spyOn(f.store, 'openConversations').mockImplementation(
    async (...args: Parameters<typeof open>) => {
      // reconcile asks about listed conversations; discovery asks about all of them
      if (args[0] === undefined && failing) {
        failing = false;

        throw new Error('discovery failed');
      }

      return open(...args);
    },
  );

  t.onTestFinished(() => {
    vi.restoreAllMocks();
  });

  // a context query refreshes outside the tick, so only the failure brings the next tick's refresh
  await f.a.coordination.context();
  assert.match(f.a.coordination.snapshot.error ?? '', /discovery failed/);
  await tick(f.a.coordination);
  assert.equal(f.a.coordination.snapshot.error, undefined);
});

test('a failed merge read retries on the next tick', async (t) => {
  const f = await idle(orderedCleanup(t.onTestFinished));
  const read = CoordinationStore.prototype.mergeEvents;
  let failing = true;

  vi.spyOn(CoordinationStore.prototype, 'mergeEvents').mockImplementation(
    async function (this: CoordinationStore, ...args: Parameters<typeof read>) {
      if (failing) {
        failing = false;

        throw new Error('merge read failed');
      }

      return read.apply(this, args);
    },
  );

  t.onTestFinished(() => {
    vi.restoreAllMocks();
  });

  await f.registry.publish(otherPresence(f.own));
  await tick(f.a.coordination);
  assert.match(f.a.coordination.snapshot.error ?? '', /merge read failed/);
  await tick(f.a.coordination);
  assert.equal(f.a.coordination.snapshot.error, undefined);
});

test('a refresh that publishes nothing is retried on the next unchanged tick', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const f = await idle(cleanup);
  const coordination = f.a.coordination;
  const store: CoordinationStore = coordination['registry'];
  const owner = { conversation: f.own.id, project: f.own.project };
  const input = { reference: 'task:held', summary: 'Held work' };

  const claim = (verify?: (ledger: Ledger) => Promise<void>) =>
    coordination['change'](
      undefined,
      (check: (ledger: Ledger) => Promise<void>) =>
        store.claim(
          owner,
          input,
          coordination['process'],
          Date.now() + 5000,
          check,
        ),
      verify,
    );

  await claim();
  await tick(coordination);
  const ledger = await f.ledger();
  const peer = await livePeer(cleanup, f);
  const state = CoordinationStore.prototype.state;

  const held = Promise.withResolvers<void>(),
    reading = Promise.withResolvers<void>();

  let holding = true;

  vi.spyOn(CoordinationStore.prototype, 'state').mockImplementation(
    async function (
      this: CoordinationStore,
      ...args: Parameters<typeof state>
    ) {
      const result = await state.apply(this, args);

      if (holding) {
        holding = false;
        reading.resolve();
        await held.promise;
      }

      return result;
    },
  );

  t.onTestFinished(() => {
    vi.restoreAllMocks();
  });

  vi.advanceTimersByTime(2000);
  await reading.promise;

  // the repeated claim bumps the mutation revision after the held read, and lands after the refresh ends
  await claim(async () => {
    held.resolve();
    await coordination['refreshing']?.promise;
    assert.deepEqual(peers(coordination), []);
  });

  assert.equal(await f.ledger(), ledger);
  await settle(coordination);
  await tick(coordination);
  assert.deepEqual(peers(coordination), [peer.id]);
});

test('a tick while a refresh runs leaves what that refresh missed to the next tick', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const f = await idle(cleanup);
  const first = await livePeer(cleanup, f);
  const presences = CoordinationStore.prototype.presences;

  const held = Promise.withResolvers<void>(),
    reading = Promise.withResolvers<void>();

  let holding = true;

  vi.spyOn(CoordinationStore.prototype, 'presences').mockImplementation(
    async function (
      this: CoordinationStore,
      ...args: Parameters<typeof presences>
    ) {
      const result = await presences.apply(this, args);

      if (holding) {
        holding = false;
        reading.resolve();
        await held.promise;
      }

      return result;
    },
  );

  t.onTestFinished(() => {
    vi.restoreAllMocks();
  });

  vi.advanceTimersByTime(2000);
  await reading.promise;
  const second = await livePeer(cleanup, f);
  vi.advanceTimersByTime(2000);
  held.resolve();
  await settle(f.a.coordination);
  assert.deepEqual(peers(f.a.coordination), [first.id]);
  await tick(f.a.coordination);

  assert.deepEqual(
    peers(f.a.coordination).toSorted(),
    [first.id, second.id].toSorted(),
  );
});

test('a standing project failure retries one project read at a time', async (t) => {
  const f = await idle(orderedCleanup(t.onTestFinished));
  const held = Promise.withResolvers<void>();
  let reads = 0;

  vi.spyOn(f.memory, 'scopePaths').mockImplementation(async () => {
    // the first read fails at once, and the later ones hang as a stuck Git would
    if (++reads > 1) await held.promise;

    throw new Error('git failed');
  });

  t.onTestFinished(() => {
    vi.restoreAllMocks();
  });

  await git(
    '-C',
    join(f.root, 'A'),
    'remote',
    'set-url',
    'origin',
    join(f.root, 'other'),
  );

  await tick(f.a.coordination);
  assert.match(f.a.coordination.snapshot.error ?? '', /git failed/);
  vi.advanceTimersByTime(2000);
  await until('a hung read', () => reads === 2);
  vi.advanceTimersByTime(6000);
  held.resolve();
  await settle(f.a.coordination);
  assert.equal(reads, 2);
});

test('an origin change moves the presence to the new project within a tick', async (t) => {
  const f = await idle(orderedCleanup(t.onTestFinished));
  const cwd = join(f.root, 'A');
  await git('-C', cwd, 'remote', 'set-url', 'origin', join(f.root, 'other'));
  const { project } = await f.memory.scopePaths(cwd);
  assert.notEqual(project, f.own.project);
  await tick(f.a.coordination);

  await until(
    'presence in the new project',
    async () =>
      (await f.registry.presences()).find(({ id }) => id === f.own.id)
        ?.project === project,
  );
});

test('project reads land in the order they started', async (t) => {
  const f = await idle(orderedCleanup(t.onTestFinished));
  const cwd = join(f.root, 'A');
  const scope = f.memory.scopePaths.bind(f.memory);
  const old = await scope(cwd);
  const first = Promise.withResolvers<void>();
  let calls = 0;

  vi.spyOn(f.memory, 'scopePaths').mockImplementation(
    async (...args: Parameters<typeof scope>) => {
      // the older read answers with what it saw before the origin changed
      if (++calls === 1) {
        await first.promise;

        return old;
      }

      return scope(...args);
    },
  );

  t.onTestFinished(() => {
    vi.restoreAllMocks();
  });

  await git('-C', cwd, 'remote', 'set-url', 'origin', join(f.root, 'other'));
  vi.advanceTimersByTime(2000);
  const context = f.a.coordination.context();
  // long enough for an unordered newer read to land before the older one
  await delay(200);
  first.resolve();
  await context;
  await settle(f.a.coordination);
  assert.equal(f.a.coordination['active']!.project, (await scope(cwd)).project);
});

test('a project change refreshes the peers within its tick', async (t) => {
  const f = await idle(orderedCleanup(t.onTestFinished));
  const c = await f.start('C');
  const id = c.coordinator.snapshot.conversation!.id;
  await quiesce(f, id, f.a.coordination);
  assert.deepEqual(peers(f.a.coordination), []);

  await git(
    '-C',
    join(f.root, 'A'),
    'remote',
    'set-url',
    'origin',
    join(f.root, 'other'),
  );

  await tick(f.a.coordination);
  assert.deepEqual(peers(f.a.coordination), [id]);
});

test('a repository created after activation is followed at the minute reread', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  const f = await unitCoordinationFixture(cleanup);

  cleanup(() => {
    vi.useRealTimers();
  });

  const cwd = join(f.root, 'D');
  await mkdir(cwd);
  const d = await f.start('D');
  const id = d.coordinator.snapshot.conversation!.id;
  // a presence write landing inside the minute's ticks would start a refresh that skips the minute
  await quiesce(f, id, d.coordination);
  await f.checkout('D');
  const { project } = await f.memory.scopePaths(cwd);
  await tick(d.coordination, 60_000);
  await until('config found', () => !!d.coordination['active']?.config);
  await tick(d.coordination);

  await until(
    'presence in the origin project',
    async () =>
      (await f.registry.presences()).find((presence) => presence.id === id)
        ?.project === project,
  );
});

test("a turn's project read stands in for the context's only while it matches and no read failed", async (t) => {
  const f = await idle(orderedCleanup(t.onTestFinished));
  const coordination = f.a.coordination;
  const reads = vi.spyOn(f.memory, 'scopePaths');
  await coordination.context(f.own.project);
  assert.equal(reads.mock.calls.length, 0);
  await coordination.context('projects/elsewhere');
  assert.equal(reads.mock.calls.length, 1);
  assert.equal(coordination['active']!.project, f.own.project);
  reads.mockRejectedValueOnce(new Error('git failed'));

  await git(
    '-C',
    join(f.root, 'A'),
    'remote',
    'set-url',
    'origin',
    join(f.root, 'other'),
  );

  await tick(coordination);
  assert.match(coordination.snapshot.error ?? '', /git failed/);
  await coordination.context(f.own.project);
  assert.equal(coordination.snapshot.error, undefined);
  assert.notEqual(coordination['active']!.project, f.own.project);
});

test("a peers request whose ledger read outlasts a tick's bounded read still answers", async (t) => {
  const f = await idle(orderedCleanup(t.onTestFinished));
  const open = f.store.openConversations.bind(f.store);
  const holding = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();

  vi.spyOn(f.store, 'openConversations').mockImplementation(
    async (...args: Parameters<typeof open>) => {
      // only the request's reconciliation has more than the tick's second to spend
      if (args[0] !== undefined && (args[1]?.timeout ?? 0) > 5000) {
        holding.resolve();
        await released.promise;
      }

      return open(...args);
    },
  );

  t.onTestFinished(() => {
    released.resolve();
    vi.restoreAllMocks();
  });

  const answer = callControl(await f.a.binding(), { kind: 'peers' });
  await holding.promise;
  await f.registry.publish(otherPresence(f.own));
  await tick(f.a.coordination);
  assert.match(f.a.coordination.snapshot.error ?? '', /expired/);
  released.resolve();
  const result = await answer;
  assert.equal(result.kind, 'peers', JSON.stringify(result));
  assert.match(f.a.coordination.snapshot.error ?? '', /expired/);
});

test("a peers request still answers when a tick's later read has its probe killed at the deadline", async (t) => {
  const f = await idle(orderedCleanup(t.onTestFinished));
  const open = f.store.openConversations.bind(f.store);
  const holding = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let killed = false;

  vi.spyOn(f.store, 'openConversations').mockImplementation(
    async (...args: Parameters<typeof open>) => {
      const timeout = args[1]?.timeout;

      if (timeout !== undefined && timeout > 5000) {
        // the request's discovery stays open while the tick's read follows the request's own
        if (args[0] === undefined) {
          holding.resolve();
          await released.promise;
        }
      } else if (timeout !== undefined && args[0] !== undefined) {
        // execFile kills a probe at its timeout and rejects with the failed command, not with an expiry
        await delay(timeout + 20);
        killed = true;

        throw Object.assign(new Error('Command failed: /usr/bin/perl'), {
          killed: true,
          signal: 'SIGKILL',
        });
      }

      return open(...args);
    },
  );

  const local = f.a.coordination['registry'];
  const state = local.state.bind(local);
  const read = Promise.withResolvers<void>();

  vi.spyOn(local, 'state').mockImplementation(
    async (...args: Parameters<typeof state>) => {
      const ledger = await state(...args);

      // only the request's read has more than the tick's second
      if ((args[0] ?? 0) - Date.now() > 5000) read.resolve();

      return ledger;
    },
  );

  t.onTestFinished(() => {
    released.resolve();
    vi.restoreAllMocks();
  });

  const answer = callControl(await f.a.binding(), { kind: 'peers' });
  await Promise.all([holding.promise, read.promise]);
  await f.registry.publish(otherPresence(f.own));
  await tick(f.a.coordination);
  assert.ok(killed, "the tick's read got the ledger");
  assert.match(f.a.coordination.snapshot.error ?? '', /expired/);
  released.resolve();
  const result = await answer;
  assert.equal(result.kind, 'peers', JSON.stringify(result));
  assert.match(f.a.coordination.snapshot.error ?? '', /expired/);
});
