import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import type { TestContext } from 'vitest';
import type { AccountReading } from '../src/agents/types.js';
import { Coordinator } from '../src/core/coordinator.js';
import * as github from '../src/core/github-reviews.js';
import { Memory } from '../src/memory/memory.js';
import { callControl } from '../src/persistence/control.js';
import { StateStore } from '../src/persistence/store.js';
import { FixtureAgent, TurnGate } from './fixtures/agent.js';
import { orderedCleanup } from './fixtures/cleanup.js';
import {
  coordinationFixture,
  git,
  pauseDiscovery,
} from './fixtures/coordination.js';
import { hookedGit, passThrough } from './fixtures/git.js';
import { reviewSource } from './fixtures/github-reviews.js';
import { scratch } from './fixtures/scratch.js';
import { until, within } from './fixtures/within.js';

const continuation =
  'Continue the task described by the handoff context. Check the working files before relying on statements about their state.';

/** a fresh reading of one weekly window at `percent`, stamped when it is read. */
const reading = (percent: number) => async (): Promise<AccountReading> => ({
  limits: [{ window: '7D', percent, observedAt: Date.now() }],
});

const models = (ids: string[]) =>
  ids.map((id) => ({ id, label: id, efforts: [] }));

/** a conversation on Claude's opus, whose CLI reports family aliases, beside a Codex with room that lists two astra versions. */
async function exhaustion(
  prepare?: (claude: FixtureAgent, codex: FixtureAgent) => void,
) {
  const root = await scratch('witch-exhaustion-');
  const project = join(root, 'project');
  await mkdir(project);
  const store = await StateStore.open(join(root, 'state'));
  const hook = { current: passThrough };
  const memory = new Memory(join(root, 'state', 'memory.git'), hookedGit(hook));
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
  return { coordinator, claude, codex, store, hook, reopen };
}

const notices = (coordinator: Coordinator) =>
  coordinator.snapshot.items
    .filter(({ kind }) => kind === 'notice')
    .map(({ text }) => text);

/** sends `First`, which runs out of usage, with `Queued` waiting behind it. */
async function exhaustWithQueue(
  coordinator: Coordinator,
  claude: FixtureAgent,
) {
  const gate = new TurnGate();
  claude.gate = gate;
  claude.refuseSteer = true;
  claude.exhaust = (prompt) => prompt.includes('First');
  const sending = coordinator.send('First');
  await within(gate.entered, 2000, 'the exhausted turn');
  await coordinator.send('Queued');
  assert.deepEqual(coordinator.snapshot.queue, ['Queued']);
  return { gate, sending };
}

test('an exhausted turn continues in the same drain step on the newest comparable model of a runtime with room', async () => {
  const { coordinator, claude, codex, store } = await exhaustion();
  try {
    const id = coordinator.snapshot.conversation!.id;
    claude.exhaust = (prompt) => prompt.includes('Migrate the store');
    await coordinator.send('Migrate the store');
    assert.equal(claude.inputs.length, 1);
    assert.deepEqual(
      codex.inputs.map(({ prompt }) => prompt),
      [continuation],
    );
    assert.match(codex.inputs[0]!.context!, /could not summarize/);
    assert.match(codex.inputs[0]!.context!, /User: Migrate the store/);
    const conversation = coordinator.snapshot.conversation!;
    assert.equal(conversation.agent, 'codex');
    assert.equal(conversation.sessions.codex!.model, 'gpt-6.1-astra');
    assert.ok(
      notices(coordinator).includes(
        'claude is out of usage. Continuing on codex · gpt-6.1-astra: codex 7D 40% has room',
      ),
    );
    assert.equal(conversation.id, id);
    await assert.rejects(store.claim(id), /open in another Witch instance/);
  } finally {
    await coordinator.close();
  }
});

test('a prompt queued behind an exhausted turn runs on the destination after the continuation, never shown idle with its queue', async () => {
  const { coordinator, claude, codex } = await exhaustion((_, codex) => {
    // a macrotask in the forced read, so an await before the switching phase would be sampled
    codex.accountRead = async () => {
      await new Promise(setImmediate);
      return reading(40)();
    };
  });
  const samples: { phase: string; queued: number }[] = [];
  coordinator.subscribe(() =>
    setImmediate(() =>
      samples.push({
        phase: coordinator.snapshot.phase,
        queued: coordinator.snapshot.queue.length,
      }),
    ),
  );
  const { gate, sending } = await exhaustWithQueue(coordinator, claude);
  try {
    gate.open();
    await sending;
    assert.deepEqual(
      codex.inputs.map(({ prompt }) => prompt),
      [continuation, 'Queued'],
    );
    assert.ok(samples.some(({ phase }) => phase === 'switching'));
    assert.deepEqual(
      samples.filter(({ phase, queued }) => phase === 'idle' && queued),
      [],
    );
  } finally {
    gate.open();
    await coordinator.close();
  }
});

test('a continuation that fails without exhaustion keeps the queued prompt held', async () => {
  const { coordinator, claude, codex } = await exhaustion();
  const { gate, sending } = await exhaustWithQueue(coordinator, claude);
  try {
    codex.failNext = true;
    gate.open();
    await sending;
    assert.equal(codex.inputs.length, 1);
    assert.equal(coordinator.snapshot.conversation!.agent, 'codex');
    assert.deepEqual(coordinator.snapshot.queue, ['Queued']);
  } finally {
    gate.open();
    await coordinator.close();
  }
});

test('a steered prompt the exhausted turn left unread reaches the destination once', async () => {
  const { coordinator, claude, codex } = await exhaustion();
  const gate = new TurnGate();
  try {
    const { session } = claude.sessions.at(-1)!;
    const send = session.send.bind(session);
    vi.spyOn(session, 'send').mockImplementation(async (...args) => {
      const result = await send(...args);
      return result.exhausted ? { ...result, unread: ['Steered'] } : result;
    });
    claude.gate = gate;
    claude.exhaust = (prompt) => prompt.includes('First');
    const sending = coordinator.send('First');
    await within(gate.entered, 2000, 'the exhausted turn');
    await coordinator.send('Steered');
    assert.deepEqual(claude.steers, ['Steered']);
    gate.open();
    await sending;
    assert.deepEqual(
      codex.inputs.map(({ prompt }) => prompt),
      [continuation, 'Steered'],
    );
    const sent = codex.inputs
      .flatMap(({ prompt, context }) => [prompt, context ?? ''])
      .join('\n');
    assert.equal(sent.split('Steered').length - 1, 1);
  } finally {
    gate.open();
    await coordinator.close();
  }
});

test('a /model switch whose summary fails leaves out a steered prompt the failed turn left unread', async () => {
  const { coordinator, claude, codex } = await exhaustion();
  const gate = new TurnGate();
  try {
    const { session } = claude.sessions.at(-1)!;
    const send = session.send.bind(session);
    vi.spyOn(session, 'send').mockImplementationOnce(async (...args) => ({
      ...(await send(...args)),
      status: 'failed',
      error: 'connection lost',
      unread: ['Steered'],
    }));
    claude.gate = gate;
    const sending = coordinator.send('First');
    await within(gate.entered, 2000, 'the failing turn');
    await coordinator.send('Steered');
    assert.deepEqual(claude.steers, ['Steered']);
    gate.open();
    await sending;
    assert.deepEqual(coordinator.snapshot.queue, ['Steered']);
    claude.exhaust = (prompt) => prompt.includes('handoff summary');
    await coordinator.selectModel({ agent: 'codex', id: 'gpt-6.1-astra' });
    await until('the steered prompt on codex', () => codex.inputs.length === 2);
    assert.deepEqual(
      codex.inputs.map(({ prompt }) => prompt),
      [continuation, 'Steered'],
    );
    assert.match(codex.inputs[0]!.context!, /User: First/);
    const sent = codex.inputs
      .flatMap(({ prompt, context }) => [prompt, context ?? ''])
      .join('\n');
    assert.equal(sent.split('Steered').length - 1, 1);
  } finally {
    gate.open();
    await coordinator.close();
  }
});

test('a /model switch whose summary fails leaves out a queued prompt whose input was never written', async () => {
  const { coordinator, claude, codex } = await exhaustion();
  try {
    await coordinator.send('Zero');
    const { session } = claude.sessions.at(-1)!;
    vi.spyOn(session, 'send').mockResolvedValueOnce({
      status: 'failed',
      text: '',
      error: 'write failed',
      inputUnsent: true,
    });
    await coordinator.send('First');
    assert.deepEqual(coordinator.snapshot.queue, ['First']);
    claude.exhaust = (prompt) => prompt.includes('handoff summary');
    await coordinator.selectModel({ agent: 'codex', id: 'gpt-6.1-astra' });
    await until('the queued prompt on codex', () => codex.inputs.length === 2);
    assert.deepEqual(
      codex.inputs.map(({ prompt }) => prompt),
      [continuation, 'First'],
    );
    assert.match(codex.inputs[0]!.context!, /User: Zero/);
    assert.doesNotMatch(codex.inputs[0]!.context!, /User: First/);
  } finally {
    await coordinator.close();
  }
});

test('a destination at 100% with verified credits qualifies once a forced refresh renews its due reading', async () => {
  let funded = false;
  const { coordinator, claude, codex } = await exhaustion((_, codex) => {
    codex.accountRead = async () => {
      const observedAt = Date.now();
      return {
        limits: [{ window: '7D', percent: 100, observedAt }],
        ...(funded
          ? {
              funding: {
                kind: 'credits' as const,
                balance: '27',
                unlimited: false,
                available: true,
                observedAt,
              },
              creditAccess: { state: 'available' as const, observedAt },
            }
          : {}),
      };
    };
  });
  try {
    // the connect read left a due reading whose attempt is under 10 minutes old
    funded = true;
    claude.exhaust = (prompt) => prompt.includes('First');
    await coordinator.send('First');
    assert.equal(codex.accountReads.length, 2);
    assert.equal(coordinator.snapshot.conversation!.agent, 'codex');
    assert.ok(
      notices(coordinator).includes(
        'claude is out of usage. Continuing on codex · gpt-6.1-astra: codex 7D 100%, 27 credits has usable credits',
      ),
    );
    assert.deepEqual(
      codex.inputs.map(({ prompt }) => prompt),
      [continuation],
    );
  } finally {
    await coordinator.close();
  }
});

for (const [blocker, prepare, reason] of [
  [
    'a destination at 100% without credits',
    (codex: FixtureAgent) => (codex.accountRead = reading(100)),
    'codex 7D 100% has no room',
  ],
  [
    'an empty destination catalog',
    (codex: FixtureAgent) => codex.catalog.splice(0),
    'codex lists no models',
  ],
] as const)
  test(`${blocker} gets the blocker, returns the queue and delivers nothing to the source`, async () => {
    const { coordinator, claude, codex } = await exhaustion((_, codex) =>
      prepare(codex),
    );
    const { gate, sending } = await exhaustWithQueue(coordinator, claude);
    try {
      gate.open();
      await sending;
      assert.ok(
        notices(coordinator).includes(
          `claude is out of usage and no other runtime can continue: ${reason}. The conversation stays on claude.`,
        ),
      );
      assert.equal(coordinator.snapshot.conversation!.agent, 'claude');
      assert.equal(coordinator.snapshot.phase, 'idle');
      assert.deepEqual(coordinator.snapshot.queue, ['Queued']);
      assert.equal(claude.inputs.length, 1);
      assert.equal(codex.sessions.length, 0);
    } finally {
      gate.open();
      await coordinator.close();
    }
  });

test('a reading from before a runtime ran out does not qualify it', async () => {
  const before = Date.now() - 1000;
  const { coordinator, claude, codex } = await exhaustion((claude) => {
    claude.accountRead = async () => ({
      limits: [{ window: '7D', percent: 10, observedAt: before }],
    });
  });
  try {
    claude.exhaust = (prompt) => prompt.includes('First');
    await coordinator.send('First');
    assert.equal(coordinator.snapshot.conversation!.agent, 'codex');
    codex.exhaust = (prompt) => prompt.includes('Second');
    await coordinator.send('Second');
    assert.ok(
      notices(coordinator).includes(
        'codex is out of usage and no other runtime can continue: claude has no reading since it ran out. The conversation stays on codex.',
      ),
    );
    assert.equal(coordinator.snapshot.conversation!.agent, 'codex');
    assert.equal(claude.inputs.length, 1);
  } finally {
    await coordinator.close();
  }
});

test('a /model summary that runs out of usage also requires a later reading before switching back', async () => {
  const before = Date.now() - 1000;
  const { coordinator, claude, codex } = await exhaustion((claude) => {
    claude.accountRead = async () => ({
      limits: [{ window: '7D', percent: 10, observedAt: before }],
    });
  });
  try {
    await coordinator.send('First');
    claude.exhaust = (prompt) => prompt.includes('handoff summary');
    await coordinator.selectModel({ agent: 'codex', id: 'gpt-6.1-astra' });
    assert.equal(coordinator.snapshot.conversation!.agent, 'codex');
    codex.exhaust = (prompt) => prompt.includes('Second');
    await coordinator.send('Second');
    assert.ok(
      notices(coordinator).includes(
        'codex is out of usage and no other runtime can continue: claude has no reading since it ran out. The conversation stays on codex.',
      ),
    );
    assert.equal(coordinator.snapshot.conversation!.agent, 'codex');
  } finally {
    await coordinator.close();
  }
});

test('with memory pending, the switch runs once recovery settles, and a prompt sent during it reaches the destination', async () => {
  const { coordinator, claude, codex } = await exhaustion();
  const gate = new TurnGate();
  try {
    claude.exhaust = (prompt) => prompt.includes('remember-port');
    await coordinator.send('remember-port');
    assert.equal(coordinator.snapshot.phase, 'recovery');
    assert.equal(codex.sessions.length, 0);
    codex.gate = gate;
    const recovering = coordinator.recoverMemory('accept');
    await within(gate.entered, 2000, 'the continuation');
    await coordinator.send('During');
    assert.deepEqual(coordinator.snapshot.queue, ['During']);
    gate.open();
    await recovering;
    await until('the prompt sent during the switch', () =>
      codex.inputs.some(({ prompt }) => prompt === 'During'),
    );
    assert.deepEqual(
      codex.inputs.map(({ prompt }) => prompt),
      [continuation, 'During'],
    );
    assert.deepEqual(codex.steers, []);
    assert.equal(claude.inputs.length, 1);
  } finally {
    gate.open();
    await coordinator.close();
  }
});

test('a blocker after recovery returns the queue without delivering to the source', async () => {
  const { coordinator, claude, codex } = await exhaustion((_, codex) => {
    codex.accountRead = reading(100);
  });
  try {
    claude.exhaust = (prompt) => prompt.includes('remember-port');
    await coordinator.send('remember-port');
    await coordinator.send('Queued');
    await coordinator.recoverMemory('accept');
    assert.ok(
      notices(coordinator).includes(
        'claude is out of usage and no other runtime can continue: codex 7D 100% has no room. The conversation stays on claude.',
      ),
    );
    assert.equal(coordinator.snapshot.phase, 'idle');
    assert.deepEqual(coordinator.snapshot.queue, ['Queued']);
    assert.equal(claude.inputs.length, 1);
    assert.equal(codex.sessions.length, 0);
  } finally {
    await coordinator.close();
  }
});

test('a recovery that fails and stays in recovery does not switch, and the next one that settles does', async () => {
  const { coordinator, claude, codex } = await exhaustion();
  try {
    claude.exhaust = (prompt) => prompt.includes('remember-port');
    await coordinator.send('remember-port');
    await assert.rejects(
      coordinator.recoverMemory('keep'),
      /Accept these memory changes/,
    );
    assert.equal(coordinator.snapshot.phase, 'recovery');
    assert.equal(coordinator.snapshot.conversation!.agent, 'claude');
    assert.equal(codex.sessions.length, 0);
    await coordinator.recoverMemory('accept');
    assert.equal(coordinator.snapshot.conversation!.agent, 'codex');
    assert.deepEqual(
      codex.inputs.map(({ prompt }) => prompt),
      [continuation],
    );
  } finally {
    await coordinator.close();
  }
});

test('pending commands make the switch yield with a notice', async () => {
  const { coordinator, claude, codex } = await exhaustion();
  const gate = new TurnGate();
  try {
    claude.gate = gate;
    claude.exhaust = (prompt) => prompt.includes('First');
    const sending = coordinator.send('First');
    await within(gate.entered, 2000, 'the exhausted turn');
    const release = coordinator.holdPromptDelivery();
    gate.open();
    await sending;
    release();
    assert.ok(
      notices(coordinator).includes(
        "claude is out of usage. Witch won't switch while commands are pending.",
      ),
    );
    assert.equal(coordinator.snapshot.conversation!.agent, 'claude');
    assert.equal(codex.sessions.length, 0);
  } finally {
    gate.open();
    await coordinator.close();
  }
});

test('a settlement error stays shown and nothing switches', async () => {
  const { coordinator, claude, codex, hook } = await exhaustion();
  try {
    claude.exhaust = (prompt) => {
      if (!prompt.includes('First')) return false;
      hook.current = async (command, run) => {
        if (command[0] !== 'merge-base') return run();
        hook.current = passThrough;
        throw new Error('memory is unreadable');
      };
      return true;
    };
    await coordinator.send('First');
    assert.match(coordinator.snapshot.error ?? '', /memory is unreadable/);
    assert.equal(coordinator.snapshot.conversation!.agent, 'claude');
    assert.equal(codex.sessions.length, 0);
  } finally {
    await coordinator.close();
  }
});

test('a destination connect failure ends without activating, and the send resolves', async () => {
  const { coordinator, claude, codex } = await exhaustion((_, codex) => {
    codex.failConnect = true;
  });
  const { gate, sending } = await exhaustWithQueue(coordinator, claude);
  try {
    gate.open();
    await sending;
    assert.equal(coordinator.snapshot.error, 'Destination unavailable');
    assert.equal(coordinator.snapshot.conversation!.agent, 'claude');
    assert.deepEqual(coordinator.snapshot.queue, ['Queued']);
    assert.equal(claude.inputs.length, 1);
    assert.equal(codex.inputs.length, 0);
  } finally {
    gate.open();
    await coordinator.close();
  }
});

test('Escape during the forced refresh settles at once, returns the queue and does not switch', async () => {
  let armed = false;
  const entered = Promise.withResolvers<void>();
  const held = Promise.withResolvers<AccountReading>();
  const { coordinator, claude, codex } = await exhaustion((_, codex) => {
    codex.accountRead = async () => {
      if (!armed) return reading(40)();
      entered.resolve();
      return held.promise;
    };
  });
  const { gate, sending } = await exhaustWithQueue(coordinator, claude);
  try {
    armed = true;
    gate.open();
    await within(entered.promise, 2000, 'the forced refresh');
    await coordinator.interrupt();
    await within(sending, 2000, 'the interrupted switch');
    assert.equal(coordinator.snapshot.phase, 'idle');
    assert.equal(coordinator.snapshot.conversation!.agent, 'claude');
    assert.deepEqual(coordinator.snapshot.queue, ['Queued']);
    assert.equal(codex.sessions.length, 0);
  } finally {
    held.resolve({ limits: [] });
    gate.open();
    await coordinator.close();
  }
});

test('after a restart before activation, the next exhausted prompt switches once', async () => {
  const { coordinator, claude, codex, reopen } = await exhaustion();
  const connecting = Promise.withResolvers<void>();
  let restarted: Coordinator | undefined;
  try {
    codex.beforeConnect = async (options) => {
      connecting.resolve();
      await new Promise((resolve) =>
        options.signal?.addEventListener('abort', resolve, { once: true }),
      );
    };
    claude.exhaust = (prompt) => /First|Second/.test(prompt);
    const sending = coordinator.send('First');
    await within(connecting.promise, 2000, 'the destination connect');
    await coordinator.close();
    await sending;
    codex.beforeConnect = undefined;
    restarted = await reopen();
    assert.equal(restarted.snapshot.conversation!.agent, 'claude');
    assert.equal(codex.inputs.length, 0);
    await restarted.send('Second');
    assert.equal(restarted.snapshot.conversation!.agent, 'codex');
    assert.deepEqual(
      codex.inputs.map(({ prompt }) => prompt),
      [continuation],
    );
    assert.equal(
      notices(restarted).filter((text) => text.includes('Continuing on'))
        .length,
      1,
    );
  } finally {
    await coordinator.close();
    await restarted?.close();
  }
});

test('the destination running out during the continuation stops at one hop, and a later send can switch again', async () => {
  const { coordinator, claude, codex } = await exhaustion();
  try {
    claude.exhaust = (prompt) => prompt.includes('First');
    codex.exhaust = (prompt) => /Continue the task|Later/.test(prompt);
    await coordinator.send('First');
    assert.ok(
      notices(coordinator).includes(
        'codex is also out of usage. The conversation stays on codex.',
      ),
    );
    assert.equal(coordinator.snapshot.conversation!.agent, 'codex');
    assert.equal(claude.inputs.length, 1);
    await coordinator.send('Later');
    assert.ok(
      notices(coordinator).includes(
        'codex is out of usage. Continuing on claude · claude-opus-5-5: claude 7D 10% has room',
      ),
    );
    assert.equal(coordinator.snapshot.conversation!.agent, 'claude');
    assert.equal(claude.inputs.at(-1)!.prompt, continuation);
  } finally {
    await coordinator.close();
  }
});

test('the destination running out during a continuation started by recovery stops at one hop', async () => {
  const { coordinator, claude, codex } = await exhaustion();
  try {
    claude.exhaust = (prompt) => prompt.includes('remember-port');
    codex.exhaust = (prompt) => prompt.includes('Continue the task');
    await coordinator.send('remember-port');
    await coordinator.recoverMemory('accept');
    assert.ok(
      notices(coordinator).includes(
        'codex is also out of usage. The conversation stays on codex.',
      ),
    );
    assert.equal(coordinator.snapshot.conversation!.agent, 'codex');
    assert.equal(claude.inputs.length, 1);
  } finally {
    await coordinator.close();
  }
});

const outOfUsage = (coordinator: Coordinator) =>
  notices(coordinator).filter((text) => text.includes('out of usage'));

test('an exhausted answer turn does not switch', async (t) => {
  pauseDiscovery(vi.spyOn);
  const f = await coordinationFixture(orderedCleanup(t.onTestFinished));
  const asker = await f.start('A');
  const owner = await f.start('B');
  const claimed = await owner.claim('task:b-work', 'b work');
  if (claimed.kind !== 'claimed') assert.fail(JSON.stringify(claimed));
  owner.a.exhaust = () => true;
  await callControl(await asker.binding(), {
    kind: 'ask',
    claim: claimed.claim.id,
    message: 'Which port?',
  });
  await owner.coordination.context();
  await until(
    'the answer turn',
    () =>
      owner.a.inputs.some(({ author }) => author === 'witch') &&
      owner.coordinator.snapshot.phase === 'idle' &&
      !owner.coordinator.snapshot.answering,
  );
  assert.deepEqual(outOfUsage(owner.coordinator), []);
  assert.equal(owner.coordinator.snapshot.conversation!.agent, 'a');
  assert.equal(owner.b.sessions.length, 0);
});

/** a conversation watching its open pull request for Copilot feedback, as the review tests set one up. */
async function watching(t: TestContext) {
  const register = orderedCleanup(t.onTestFinished);
  const source = reviewSource();
  vi.spyOn(github, 'readGitHubReviews').mockImplementation(async () =>
    structuredClone(source),
  );
  const f = await coordinationFixture(register, async (references) => ({
    assigned: references,
  }));
  const packets = await scratch('witch-review-packets-');
  vi.stubEnv('TMPDIR', packets);
  register(() => {
    vi.unstubAllEnvs();
  });
  const client = await f.start('A');
  const { coordinator } = client;
  const cwd = coordinator.snapshot.conversation!.cwd;
  await git('-C', cwd, 'symbolic-ref', 'HEAD', 'refs/heads/feat/reviews');
  const repository = {
    branch: 'feat/reviews',
    ahead: 0,
    behind: 0,
    staged: 0,
    modified: 0,
    conflicts: 0,
    untracked: 0,
    pullRequest: { ...source.pullRequest },
    pullRequestProject: (await f.memory.scopePaths(cwd)).project,
  };
  client.coordination.updateRepository(repository);
  coordinator.copilot.updateRepository(repository);
  await client.claim(source.closingIssues[0]!);
  return { ...client, source };
}

test('an exhausted Copilot review turn does not switch', async (t) => {
  const { coordinator, a, b, source } = await watching(t);
  a.exhaust = () => true;
  await coordinator.copilot.observe(structuredClone(source));
  await until(
    'the review turn',
    () =>
      a.inputs.some(({ author }) => author === 'witch') &&
      coordinator.snapshot.phase === 'idle' &&
      !coordinator.snapshot.reviewing,
  );
  assert.deepEqual(outOfUsage(coordinator), []);
  assert.equal(coordinator.snapshot.conversation!.agent, 'a');
  assert.equal(b.sessions.length, 0);
});
