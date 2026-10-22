import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { controlPrefix } from '../../src/cli-control.js';
import { Coordinator } from '../../src/core/coordinator.js';
import { SessionCoordination } from '../../src/core/coordination.js';
import { Memory } from '../../src/memory/memory.js';
import { CoordinationStore } from '../../src/persistence/coordination.js';
import { callControl } from '../../src/persistence/control.js';
import { exclusiveLock } from '../../src/persistence/lock.js';
import { StateStore } from '../../src/persistence/store.js';
import { FixtureAgent } from './agent.js';
import { scratch } from './scratch.js';

const execute = promisify(execFile);
export const git = (...args: string[]) => execute('git', args);
const entry = fileURLToPath(new URL('../../src/cli.tsx', import.meta.url));

/** holds an existing conversation's `lock` without `coordinated`, as a Witch from before registration locks does. */
export function legacyLock(store: StateStore, id: string): Promise<FileHandle> {
  return open(
    join(store.root, 'conversations', id, 'lock'),
    constants.O_RDWR | constants.O_NONBLOCK | exclusiveLock,
  );
}

export async function coordinationFixture(
  t: TestContext,
  assign: Parameters<typeof SessionCoordination.open>[4] = async () => {},
) {
  const root = await scratch('witch-coordination-');
  await git('init', '--bare', join(root, 'origin'));
  await git('init', '--bare', join(root, 'other'));
  for (const name of ['A', 'B', 'C'])
    await git(
      'clone',
      join(root, name === 'C' ? 'other' : 'origin'),
      join(root, name),
    );
  const store = await StateStore.open(join(root, 'state'));
  const memory = new Memory(join(store.root, 'memory.git'));
  const registry = await CoordinationStore.open(store.root);
  const clients: Coordinator[] = [];
  t.after(async () => {
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
  return { root, store, memory, registry, start, ledger };
}
