import assert from 'node:assert/strict';

import { spawn } from 'node:child_process';

import type { ChildProcess } from 'node:child_process';

import { randomUUID } from 'node:crypto';

import { subscribe, unsubscribe } from 'node:diagnostics_channel';

import { once } from 'node:events';

import { constants } from 'node:fs';

import { readFile, writeFile } from 'node:fs/promises';

import { join } from 'node:path';

import { test, vi } from 'vitest';

import { SessionCoordination } from '../src/core/coordination.js';

import type {
  SelectionTicket,
  TaskClaim,
} from '../src/core/coordination-state.js';

import { Memory } from '../src/memory/memory.js';

import { CoordinationStore } from '../src/persistence/coordination.js';

import { tryOpenLocked } from '../src/persistence/lock.js';

import { identifyProcess, ps } from '../src/persistence/process.js';

import { StateStore } from '../src/persistence/store.js';

import { orderedCleanup } from './fixtures/cleanup.js';

import type { RegisterCleanup } from './fixtures/cleanup.js';

import { git, legacyLock } from './fixtures/coordination.js';

import { record } from './fixtures/coordinator.js';

import { scratch } from './fixtures/scratch.js';

import { within } from './fixtures/within.js';

const identity = (await identifyProcess(process.pid))!;

const input = { reference: 'task:chosen', summary: 'Chosen task' };

const requestTimeout = 1500;

function pauseProbe(matches: (child: ChildProcess) => boolean, nth = 1) {
  const started = Promise.withResolvers<ChildProcess>();

  const closed = Promise.withResolvers<void>();

  let probe: ChildProcess | undefined;

  let listening = true;

  let ended = false;

  const observe = (message: unknown) => {
    const { process: child, options } = message as {
      process: ChildProcess;
      options: { file: string; args: string[] };
    };

    if (!listening || probe || !matches(child) || --nth !== 0) return;

    probe = child;

    // stop inside the child so a fast probe cannot exit before the parent handles spawn.
    options.file = '/bin/sh';

    options.args = ['/bin/sh', '-c', 'kill -STOP $$'];

    child.once('spawn', () => started.resolve(child));

    child.once('error', started.reject);

    child.once('close', () => {
      ended = true;

      closed.resolve();
    });
  };

  subscribe('tracing:child_process.spawn:start', observe);

  return {
    started: started.promise,
    get ended() {
      return ended;
    },
    async close() {
      listening = false;

      unsubscribe('tracing:child_process.spawn:start', observe);

      if (!probe) return;

      if (probe.exitCode === null && probe.signalCode === null)
        probe.kill('SIGKILL');

      await closed.promise;
    },
  };
}

async function foreignProcess(cleanup: RegisterCleanup, cwd: string) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd,
    stdio: 'ignore',
  });

  const closed = new Promise<void>((resolve) =>
    child.once('close', () => resolve()),
  );

  cleanup(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');

    await closed;
  });

  await once(child, 'spawn');

  return (await identifyProcess(child.pid!))!;
}

async function assertUnlocked(root: string) {
  const lock = await tryOpenLocked(
    join(root, 'coordination', 'lock'),
    constants.O_RDWR,
  );

  assert.ok(lock, 'the failed request released the ledger lock');

  await lock.close();
}

test('a stalled probe survives a delayed parent spawn notification', async () => {
  const delaySpawn = (message: unknown) => {
    const { process: child } = message as { process: ChildProcess };

    child.once('spawn', () => {
      if (child.spawnfile === '/bin/ps')
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    });
  };

  subscribe('child_process', delaySpawn);

  const paused = pauseProbe((child) => child.spawnfile === '/bin/ps');

  const rejected = assert.rejects(ps('pid=', [process.pid], { timeout: 300 }));

  try {
    const child = await within(paused.started, 2000, 'probe started');

    await within(rejected, 2000, 'probe timed out');

    assert.equal(child.signalCode, 'SIGKILL');

    assert.equal(paused.ended, true);
  } finally {
    unsubscribe('child_process', delaySpawn);

    await paused.close();

    await rejected;
  }
});

for (const probe of ['process', 'conversation', 'activation'] as const)
  test(`a stalled ${probe} reconciliation probe closes before the ledger unlocks`, async (t) => {
    const cleanup = orderedCleanup(t.onTestFinished);

    const root = await scratch('witch-reconcile-deadline-');

    const store = await StateStore.open(root);

    const registry = await CoordinationStore.open(store);

    const held = await store.create(record('legacy', root));

    cleanup(() => held.close());

    const foreign = await foreignProcess(cleanup, root);

    const existing: TaskClaim[] = [
      {
        id: randomUUID(),
        owner: { conversation: 'existing', project: 'project-p' },
        references: ['task:project-p:existing'],
        summary: 'Existing owner',
        createdAt: 1,
        process: foreign,
      },
      {
        id: randomUUID(),
        owner: { conversation: 'legacy', project: 'project-p' },
        references: ['task:project-p:legacy'],
        summary: 'Legacy owner',
        createdAt: 2,
      },
    ];

    const ticket: SelectionTicket = {
      id: randomUUID(),
      owner: { conversation: 'selector', project: 'project-p' },
      activation: randomUUID(),
      turn: randomUUID(),
    };

    cleanup(await registry.holdActivation(ticket.activation));

    const ledger = { version: 2, claims: existing, selections: [ticket] };

    const file = join(root, 'coordination', 'claims.json');

    await writeFile(file, JSON.stringify(ledger));

    const paused = pauseProbe(
      (child) =>
        child.spawnfile === (probe === 'process' ? '/bin/ps' : '/usr/bin/perl'),
      probe === 'activation' ? 2 : 1,
    );

    const request = registry.claim(
      { conversation: 'timed-out', project: 'project-p' },
      input,
      identity,
      Date.now() + requestTimeout,
      async () => {},
    );

    const rejected = assert.rejects(request);

    try {
      const child = await within(paused.started, 5000, 'probe started');

      await within(rejected, 5000, 'request rejected');

      assert.equal(child.signalCode, 'SIGKILL');

      assert.equal(paused.ended, true);

      await assertUnlocked(root);

      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), ledger);
    } finally {
      await paused.close();

      await rejected;
    }

    const later = await registry.claim(
      { conversation: 'later', project: 'project-p' },
      input,
      identity,
      Date.now() + 2000,
      async () => {},
    );

    assert.deepEqual(await registry.state(), {
      claims: [...existing, later],
      selections: [ticket],
    });
  });

async function session(cleanup: RegisterCleanup) {
  const root = await scratch('witch-verify-deadline-');

  const cwd = join(root, 'project');

  await git('init', cwd);

  await git(
    '-C',
    cwd,
    'remote',
    'add',
    'origin',
    'https://example.com/one.git',
  );

  const store = await StateStore.open(join(root, 'state'));

  const registry = await CoordinationStore.open(store);

  const memory = new Memory(join(root, 'memory.git'));

  const conversation = record('claimant', cwd);

  const held = await store.create(conversation);

  const coordination = await SessionCoordination.open(
    store,
    memory,
    join(root, 'control'),
    () => '',
    async () => ({ assigned: [] }),
  );

  cleanup(async () => {
    await coordination.close();

    await held.close();
  });

  const { project } = await memory.scopePaths(cwd);

  const binding = await coordination.activate(conversation, project);

  clearInterval(coordination['timer']);

  const claim = (deadline = Date.now() + 2000) =>
    coordination['handle']({
      version: 1,
      id: randomUUID(),
      ...binding,
      deadline,
      action: { kind: 'claim', input },
    });

  return { root, cwd, store, registry, memory, coordination, project, claim };
}

for (const probe of [
  'project',
  'conversation',
  'activation',
  'process',
  'legacy-project',
] as const)
  test(`a stalled ${probe} verification probe releases the ledger without claiming`, async (t) => {
    const cleanup = orderedCleanup(t.onTestFinished);

    const f = await session(cleanup);

    let releasePeer: (() => Promise<void>) | undefined;

    if (['activation', 'process', 'legacy-project'].includes(probe)) {
      const peer = record('peer', f.cwd);

      const held = await f.store.create(peer);

      if (probe === 'legacy-project') {
        await held.close();

        const lock = await legacyLock(f.store, peer.id);

        releasePeer = () => lock.close();
      } else {
        cleanup(() => held.close());

        const activation = randomUUID();

        cleanup(await f.registry.holdActivation(activation));

        await f.registry.publish({
          ...peer,
          version: 1,
          selectionQueue: 1,
          project: f.project,
          activation,
          process:
            probe === 'process'
              ? await foreignProcess(cleanup, f.root)
              : identity,
          phase: 'idle',
          requests: 0,
          familiars: 0,
          brews: 0,
          openedAt: 1,
          updatedAt: 1,
        });
      }
    }

    const paused = pauseProbe(
      (child) =>
        probe === 'project' || probe === 'legacy-project'
          ? child.spawnfile === 'git' && child.spawnargs.includes('remote')
          : child.spawnfile ===
            (probe === 'process' ? '/bin/ps' : '/usr/bin/perl'),
      probe === 'legacy-project'
        ? 3
        : probe === 'project' || probe === 'activation'
          ? 2
          : 1,
    );

    const request = f.claim(Date.now() + requestTimeout);

    const rejected = assert.rejects(request);

    try {
      const child = await within(paused.started, 5000, 'probe started');

      await within(rejected, 5000, 'request rejected');

      assert.equal(child.signalCode, 'SIGKILL');

      assert.equal(paused.ended, true);

      await assertUnlocked(f.store.root);

      assert.deepEqual(await f.registry.claims(), []);
    } finally {
      await paused.close();

      await rejected;

      await releasePeer?.();
    }

    const later = await f.claim();

    assert.equal(later.kind, 'claimed');

    if (later.kind !== 'claimed') assert.fail(JSON.stringify(later));

    assert.deepEqual(await f.registry.claims(), [later.claim]);
  });

test('a request cancels a stalled earlier project read and keeps the next project', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  const f = await session(cleanup);

  const paused = pauseProbe((child) => child.spawnfile === 'git');

  const background = f.coordination['refreshProject'](
    f.coordination['active']!,
  ).catch(() => {});

  let rejected: Promise<void> | undefined;

  try {
    const child = await within(paused.started, 2000, 'background Git started');

    rejected = assert.rejects(f.claim(Date.now() + requestTimeout));

    await within(rejected, 5000, 'request rejected');

    await background;

    assert.equal(child.signalCode, 'SIGKILL');

    assert.equal(paused.ended, true);

    assert.equal(f.coordination['active']!.project, f.project);

    assert.deepEqual(await f.registry.claims(), []);
  } finally {
    await paused.close();

    await background;

    await rejected;
  }

  await git(
    '-C',
    f.cwd,
    'remote',
    'set-url',
    'origin',
    'https://example.com/two.git',
  );

  const { project } = await f.memory.scopePaths(f.cwd);

  assert.notEqual(project, f.project);

  const later = await f.claim();

  assert.equal(later.kind, 'claimed');

  if (later.kind !== 'claimed') assert.fail(JSON.stringify(later));

  assert.equal(later.claim.owner.project, project);

  assert.equal(f.coordination['active']!.project, project);

  assert.deepEqual(await f.registry.claims(), [later.claim]);
});

test('a discovery error waits for its stalled lock probe before releasing the ledger', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  const f = await session(cleanup);

  const failure = new Error('Presence read failed');

  const reading = vi
    .spyOn(CoordinationStore.prototype, 'presences')
    .mockRejectedValue(failure);

  const paused = pauseProbe((child) => child.spawnfile === '/usr/bin/perl');

  const rejected = assert.rejects(
    f.claim(Date.now() + requestTimeout),
    failure,
  );

  try {
    const child = await within(paused.started, 5000, 'lock probe started');

    await within(rejected, 5000, 'request rejected');

    assert.equal(child.signalCode, 'SIGKILL');

    assert.equal(paused.ended, true);

    await assertUnlocked(f.store.root);

    assert.deepEqual(await f.registry.claims(), []);
  } finally {
    await paused.close();

    await rejected;

    reading.mockRestore();
  }

  assert.equal((await f.claim()).kind, 'claimed');
});
