import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AccountReading } from '../../src/agents/types.js';
import { Coordinator } from '../../src/core/coordinator.js';
import { StateStore } from '../../src/persistence/store.js';
import { FixtureAgent } from './agent.js';
import { hookedGit, passThrough } from './git.js';
import { scratch } from './scratch.js';
import { seededMemory } from './seeded-memory.js';
import { until } from './within.js';

export const continuation =
  'Continue the task described by the handoff context. Check the working files before relying on statements about their state.';

/** a fresh reading of one weekly window at `percent`, stamped when it is read. */
export const reading =
  (percent: number) => async (): Promise<AccountReading> => ({
    limits: [{ window: '7D', percent, observedAt: Date.now() }],
  });

export const models = (ids: string[]) =>
  ids.map((id) => ({ id, label: id, efforts: [] }));

/** a conversation on Claude's opus, whose CLI reports family aliases, beside a Codex with room that lists two astra versions. */
export async function exhaustion(
  prepare?: (claude: FixtureAgent, codex: FixtureAgent) => void,
) {
  const root = await scratch('witch-exhaustion-');
  const project = join(root, 'project');

  await mkdir(project);

  const store = await StateStore.open(join(root, 'state'));
  const hook = { current: passThrough };

  const memory = await seededMemory(
    join(root, 'state', 'memory.git'),
    hookedGit(hook),
  );

  const claude = new FixtureAgent('claude');
  const codex = new FixtureAgent('codex');

  claude.catalog.splice(
    0,
    Infinity,
    ...models(['claude-opus-5-5', 'claude-sonnet-5-5']),
  );

  claude.latest = async () => ({
    opus: 'claude-opus-5-5',
    sonnet: 'claude-sonnet-5-5',
  });

  codex.catalog.splice(
    0,
    Infinity,
    ...models(['gpt-6-astra', 'gpt-6.1-astra', 'gpt-6.1-sol']),
  );

  claude.accountRead = reading(10);
  codex.accountRead = reading(40);

  prepare?.(claude, codex);

  const agents = [claude, codex].map((adapter) => ({
    adapter,
    executable: adapter.id,
  }));

  const coordinator = new Coordinator(store, memory, agents);

  await coordinator.initialize(project);

  await coordinator.selectModel({ agent: 'claude', id: 'claude-opus-5-5' });

  await until('the connect read of codex', () =>
    Boolean(coordinator.snapshot.accounts.codex),
  );

  const reopen = async () => {
    const reopened = new Coordinator(store, memory, agents);

    await reopened.initialize(project, { continue: true });

    return reopened;
  };

  return { coordinator, claude, codex, store, memory, hook, reopen };
}
