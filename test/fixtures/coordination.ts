import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { promises as files } from 'node:fs';
import { cp, readFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { controlPrefix } from '../../src/cli/cli-control.js';
import { Coordinator } from '../../src/core/coordinator.js';
import { SessionCoordination } from '../../src/core/coordination/coordination.js';
import { CoordinationStore } from '../../src/persistence/coordination.js';
import { callControl } from '../../src/persistence/control.js';
import { openLocked } from '../../src/persistence/lock.js';
import { StateStore } from '../../src/persistence/store.js';
import { FixtureAgent } from './agent.js';
import { scratch } from './scratch.js';
import { seededMemory } from './seeded-memory.js';
import { EmptyMemory } from './empty-memory.js';
import { ephemeralFiles } from './ephemeral-files.js';
import type { RegisterCleanup } from './cleanup.js';

const execute = promisify(execFile);
export const git = (...args: string[]) => execute('git', args);
// a local origin costs every project read three more git processes to follow its repository
const origin = 'https://example.com/witch/origin.git';
const entry = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));

/** keeps mailbox polling live while tests control periodic session discovery. */
export function pauseDiscovery(spyOn: typeof vi.spyOn) {
  const refreshes: (() => void)[] = [];
  const interval = globalThis.setInterval;

  spyOn(globalThis, 'setInterval').mockImplementation(
    <Args extends unknown[]>(
      run: (...args: Args) => void,
      milliseconds?: number,
      ...args: Args
    ) => {
      if (milliseconds !== 2000) return interval(run, milliseconds, ...args);

      refreshes.push(() => run(...args));

      return interval(() => {}, milliseconds);
    },
  );

  return refreshes;
}

export async function measureControl<T>(
  spyOn: typeof vi.spyOn,
  run: () => Promise<T>,
) {
  let discoveries = 0;
  let reads = 0;
  const open = StateStore.prototype.openConversations;

  const opening = spyOn(
    StateStore.prototype,
    'openConversations',
  ).mockImplementation(function (this: StateStore, ids?: readonly string[]) {
    if (ids === undefined) discoveries++;

    return open.call(this, ids);
  });

  const read = files.readFile;

  const reading = spyOn(files, 'readFile').mockImplementation(
    async (...args: Parameters<typeof read>) => {
      if (String(args[0]).endsWith('/coordination/claims.json')) reads++;

      return read(...args);
    },
  );

  syncBuiltinESMExports();

  try {
    return { value: await run(), discoveries, reads };
  } finally {
    opening.mockRestore();

    reading.mockRestore();

    syncBuiltinESMExports();
  }
}

/** holds an existing conversation's `lock` without `coordinated`, as a Witch from before registration locks does. */
export function legacyLock(store: StateStore, id: string): Promise<FileHandle> {
  return openLocked(
    join(store.root, 'conversations', id, 'lock'),
    constants.O_RDWR | constants.O_NONBLOCK,
  );
}

/** a checkout in A and B's project. */
async function checkout(path: string) {
  await git('init', '--quiet', path);

  await git('-C', path, 'remote', 'add', 'origin', origin);
}

let repositories: Promise<string> | undefined;

/** A, B, `other` and C, built once per test file and copied into each fixture. */
async function template(): Promise<string> {
  const root = await scratch('witch-coordination-repositories-');

  await checkout(join(root, 'A'));

  await checkout(join(root, 'B'));

  await git('init', '--bare', join(root, 'other'));

  await git('clone', join(root, 'other'), join(root, 'C'));

  return root;
}

export async function coordinationFixture(
  register: RegisterCleanup,
  assign: Parameters<typeof SessionCoordination.open>[4] = async () => ({
    assigned: [],
  }),
  unit = false,
) {
  const root = await scratch('witch-coordination-');

  if (unit) ephemeralFiles(root);

  await cp(await (repositories ??= template()), root, { recursive: true });

  // C's copied origin still names the template's `other`
  await git(
    '-C',
    join(root, 'C'),
    'remote',
    'set-url',
    'origin',
    join(root, 'other'),
  );

  const store = await StateStore.open(join(root, 'state'));
  const memoryRoot = join(store.root, 'memory.git');

  const memory = unit
    ? new EmptyMemory(memoryRoot)
    : await seededMemory(memoryRoot);

  const registry = await CoordinationStore.open(store);
  const clients: Coordinator[] = [];

  register(async () => {
    for (const coordinator of clients) await coordinator.close();
  });

  const start = async (
    name = 'A',
    launch: Parameters<Coordinator['initialize']>[1] = {},
    agents?: ConstructorParameters<typeof Coordinator>[2],
  ) => {
    const directory = join(root, `control-${clients.length}`);

    const coordination = await SessionCoordination.open(
      store,
      memory,
      directory,
      (binding) => controlPrefix(binding, entry),
      assign,
    );

    const a = new FixtureAgent('a');
    const b = new FixtureAgent('b');
    a.skills = [{ name: 'review', description: 'Review changes' }];

    const coordinator = new Coordinator(
      store,
      memory,
      agents ?? [a, b].map((adapter) => ({ adapter, executable: adapter.id })),
      undefined,
      undefined,
      coordination,
    );

    clients.push(coordinator);

    await coordinator.initialize(join(root, name), launch);

    const binding = async () => {
      const presence = (await registry.presences()).find(
        (presence) => presence.id === coordinator.snapshot.conversation!.id,
      );

      assert.ok(presence, 'current presence was published');

      return {
        directory,
        conversation: presence.id,
        activation: presence.activation,
      };
    };

    const query = async () => {
      const result = await callControl(await binding(), { kind: 'peers' });

      assert.equal(result.kind, 'peers', JSON.stringify(result));

      if (result.kind !== 'peers') assert.fail('expected a peer snapshot');

      return result.snapshot;
    };

    const claim = async (reference = 'task:shared', summary = `${name} task`) =>
      callControl(await binding(), {
        kind: 'claim',
        input: { reference, summary },
      });

    return {
      coordinator,
      coordination,
      a,
      b,
      directory,
      binding,
      query,
      claim,
    };
  };

  const ledger = () =>
    readFile(join(store.root, 'coordination', 'claims.json'), 'utf8');

  return {
    root,
    store,
    memory,
    registry,
    start,
    ledger,
    checkout: (name: string) => checkout(join(root, name)),
  };
}

/** unit cases keep repository lookup, state files and locks; persistence integration requires the real fixture. */
export function unitCoordinationFixture(
  register: Parameters<typeof coordinationFixture>[0],
  assign?: Parameters<typeof coordinationFixture>[1],
) {
  return coordinationFixture(register, assign, true);
}

/** lets the coordination lock be taken, then moves the clock past the deadline it was given. */
export function expireAfterLock(): void {
  const store = CoordinationStore.prototype as unknown as {
    lock(deadline: number): Promise<unknown>;
  };

  const lock = store.lock;

  vi.spyOn(store, 'lock').mockImplementation(async function (
    this: unknown,
    deadline: number,
  ) {
    const held = await lock.call(this, deadline);

    vi.spyOn(Date, 'now').mockReturnValue(deadline + 1);

    return held;
  });
}
