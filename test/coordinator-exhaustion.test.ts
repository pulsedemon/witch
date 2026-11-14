import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import type { AccountReading } from '../src/agents/types.js';
import { Workspace } from '../src/memory/workspace.js';
import { Coordinator } from '../src/core/coordinator.js';
import { Attachments } from '../src/core/attachments.js';
import { callControl } from '../src/persistence/control.js';
import { ConversationStore, StateStore } from '../src/persistence/store.js';
import { FixtureAgent, holdConnect, TurnGate } from './fixtures/agent.js';
import { orderedCleanup } from './fixtures/cleanup.js';
import {
  unitCoordinationFixture,
  pauseDiscovery,
} from './fixtures/coordination.js';
import { hookedGit, passThrough } from './fixtures/git.js';
import { png } from './fixtures/png.js';
import { scratch } from './fixtures/scratch.js';
import { seededMemory } from './fixtures/seeded-memory.js';
import { until, within } from './fixtures/within.js';
import { setup } from './fixtures/copilot-reviews.js';
import { notices } from './fixtures/coordinator.js';

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

test('an exhausted turn whose source process died continues on another runtime', async () => {
  const { coordinator, claude, codex } = await exhaustion();
  try {
    claude.exhaust = (prompt) => {
      if (!prompt.includes('Migrate the store')) return false;
      void claude.sessions.at(-1)!.session.close();
      return true;
    };
    await coordinator.send('Migrate the store');
    assert.equal(claude.sessions.at(-1)!.session.closed, true);
    assert.deepEqual(
      codex.inputs.map(({ prompt }) => prompt),
      [continuation],
    );
    assert.equal(coordinator.snapshot.conversation!.agent, 'codex');
    assert.equal(coordinator.snapshot.error, undefined);
  } finally {
    await coordinator.close();
  }
});

test("the continuation after an exhausted turn sends the saved images of that turn's prompt and accepted steers, not of earlier turns or unread steers", async () => {
  const { coordinator, claude, codex } = await exhaustion();
  const gate = new TurnGate();
  try {
    const directory = await scratch('witch-exhaustion-image-');
    const paste = async (name: string) => {
      const path = join(directory, `${name}.png`);
      await writeFile(path, png(2, 2));
      return coordinator.paste(path, '')!;
    };
    await coordinator.send(`Earlier ${await paste('earlier')}`);
    const { session } = claude.sessions.at(-1)!;
    const send = session.send.bind(session);
    const unread = await paste('unread');
    vi.spyOn(session, 'send').mockImplementation(async (...args) => {
      const result = await send(...args);
      return result.exhausted
        ? { ...result, unread: [`Unread ${unread}`] }
        : result;
    });
    claude.gate = gate;
    claude.exhaust = (prompt) => prompt.includes('Describe');
    const sending = coordinator.send(`Describe ${await paste('prompt')}`);
    await within(gate.entered, 2000, 'the exhausted turn');
    await coordinator.send('Text only');
    await coordinator.send(`Also ${await paste('steer')}`);
    await coordinator.send(`Unread ${unread}`);
    gate.open();
    await sending;
    const prompt = claude.inputs.at(-1)!.images!;
    const [, steer] = claude.steerImages;
    assert.equal(prompt.length, 1);
    assert.equal(steer!.length, 1);
    assert.deepEqual(codex.inputs[0], {
      ...codex.inputs[0],
      prompt: continuation,
      images: [...prompt, ...steer!],
    });
  } finally {
    gate.open();
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

test('a prompt whose pre-turn compaction runs out of usage continues on the destination and reaches it once', async () => {
  const { coordinator, claude, codex } = await exhaustion();
  try {
    claude.turnUsage = { context: 80 };
    await coordinator.send('Seed');
    claude.exhaustCompaction = true;
    await coordinator.send('Migrate the store');
    assert.equal(claude.compactions.length, 1);
    assert.deepEqual(
      claude.inputs.map(({ prompt }) => prompt),
      ['Seed'],
    );
    // Seed completed, so the handoff sends no continuation and the held prompt carries its context
    assert.deepEqual(
      codex.inputs.map(({ prompt }) => prompt),
      ['Migrate the store'],
    );
    assert.match(codex.inputs[0]!.context!, /could not summarize/);
    assert.match(codex.inputs[0]!.context!, /User: Seed/);
    assert.doesNotMatch(codex.inputs[0]!.context!, /User: Migrate the store/);
    assert.deepEqual(codex.compactions, []);
    assert.equal(coordinator.snapshot.conversation!.agent, 'codex');
    assert.deepEqual(coordinator.snapshot.queue, []);
    assert.ok(notices(coordinator).includes('Usage limit reached'));
    assert.ok(
      notices(coordinator).includes(
        'claude is out of usage. Continuing on codex · gpt-6.1-astra: codex 7D 40% has room',
      ),
    );
  } finally {
    await coordinator.close();
  }
});

test('a pre-turn compaction that fails without exhaustion stays on the source and returns the prompt to the composer', async () => {
  const { coordinator, claude, codex } = await exhaustion();
  try {
    claude.turnUsage = { context: 80 };
    await coordinator.send('Seed');
    claude.failNext = true;
    await coordinator.send('Migrate the store');
    assert.equal(coordinator.snapshot.conversation!.agent, 'claude');
    assert.deepEqual(codex.inputs, []);
    assert.deepEqual(
      claude.inputs.map(({ prompt }) => prompt),
      ['Seed'],
    );
    assert.deepEqual(coordinator.snapshot.queue, ['Migrate the store']);
  } finally {
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

test('Escape while recovery applies stops the switch it was holding', async () => {
  const { coordinator, claude, codex, hook } = await exhaustion();
  try {
    claude.exhaust = (prompt) => prompt.includes('remember-port');
    await coordinator.send('remember-port');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    hook.current = async (_, run) => {
      hook.current = passThrough;
      entered.resolve();
      await release.promise;
      return run();
    };
    const recovering = coordinator.recoverMemory('accept');
    await within(entered.promise, 2000, 'the recovery');
    await coordinator.interrupt();
    release.resolve();
    await recovering;
    assert.equal(coordinator.snapshot.conversation!.agent, 'claude');
    assert.equal(codex.sessions.length, 0);
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
  const { coordinator, claude, codex, memory, hook } = await exhaustion();
  try {
    claude.exhaust = (prompt) => {
      if (!prompt.includes('First')) return false;
      let unpublished = false;
      hook.current = async (command, run, { cwd }) => {
        // a commit the failed turn leaves behind gives settlement something to publish
        if (command[0] === 'status' && !unpublished) {
          unpublished = true;
          await memory.git(cwd, ['commit', '--allow-empty', '-qm', 'mine']);
        }
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
    codex.beforeConnect = holdConnect(connecting, undefined, {
      onAbort: 'resolve',
    });
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
  const f = await unitCoordinationFixture(orderedCleanup(t.onTestFinished));
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

test('an exhausted Copilot review turn does not switch', async (t) => {
  const { a: client, source } = await setup(t);
  const { coordinator, a, b } = client;
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

async function completedForBackground(
  prepare?: (claude: FixtureAgent, codex: FixtureAgent) => void,
) {
  const f = await exhaustion(prepare);
  await f.coordinator.send('Review schema changes');
  return { ...f, emit: f.claude.sessions.at(-1)!.options.onEvent };
}

test('background exhaustion continues completed work with reports before queued input, once', async () => {
  const { coordinator, claude, codex, emit } = await completedForBackground();
  try {
    const before = coordinator.snapshot.conversation!;
    emit({ type: 'running', running: true });
    emit({
      type: 'tool',
      id: 'review',
      title: 'Review completed',
      done: true,
      text: 'Keep the unique index.',
    });
    emit({ type: 'exhausted' });
    emit({ type: 'exhausted' });
    await coordinator.send('Queued separately');
    assert.equal(codex.inputs.length, 0);
    emit({ type: 'running', running: false });
    await until(
      'background continuation and queued input',
      () => codex.inputs.length === 2 && coordinator.snapshot.phase === 'idle',
    );
    assert.equal(coordinator.snapshot.conversation!.id, before.id);
    assert.equal(
      coordinator.snapshot.conversation!.sessions.codex!.model,
      'gpt-6.1-astra',
    );
    assert.deepEqual(
      codex.inputs.map(({ prompt }) => prompt),
      [continuation, 'Queued separately'],
    );
    assert.match(codex.inputs[0]!.context!, /Keep the unique index/);
    assert.match(codex.inputs[0]!.context!, /Review schema changes/);
    assert.ok(!codex.inputs[0]!.context!.includes('User: Queued separately'));
    assert.equal(claude.inputs.length, 1);
    emit({ type: 'exhausted' });
    await coordinator.send('Still on destination');
    assert.equal(codex.inputs.length, 3);
    assert.equal(claude.inputs.length, 1);
  } finally {
    await coordinator.close();
  }
});

test('a pending compact runs on the destination after background continuation', async () => {
  const { coordinator, claude, codex, emit } = await completedForBackground();
  try {
    emit({ type: 'running', running: true });
    emit({ type: 'exhausted' });
    const compacting = coordinator.compact();
    await coordinator.send('After compact');
    emit({ type: 'running', running: false });
    assert.equal(await within(compacting, 5000, 'destination compact'), true);
    await until(
      'queued prompt after compact',
      () => codex.inputs.length === 2 && coordinator.snapshot.phase === 'idle',
    );
    assert.equal(claude.compactions.length, 0);
    assert.equal(codex.compactions.length, 1);
    assert.deepEqual(
      codex.inputs.map(({ prompt }) => prompt),
      [continuation, 'After compact'],
    );
  } finally {
    await coordinator.close();
  }
});

test('background exhaustion blocked by a command leaves the queue for the composer', async () => {
  const { coordinator, claude, codex, emit } = await completedForBackground();
  const release = coordinator.holdPromptDelivery();
  try {
    emit({ type: 'running', running: true });
    emit({ type: 'exhausted' });
    await coordinator.send('Queued');
    emit({ type: 'running', running: false });
    await until('command blocker', () =>
      notices(coordinator).includes(
        "claude is out of usage. Witch won't switch while commands are pending.",
      ),
    );
    release();
    assert.equal(codex.inputs.length, 0);
    assert.equal(claude.inputs.length, 1);
    assert.deepEqual(coordinator.snapshot.queue, ['Queued']);
  } finally {
    release();
    await coordinator.close();
  }
});

test('Escape cancels a pending background switch and late events cannot revive it', async () => {
  const { coordinator, claude, codex, emit } = await completedForBackground();
  try {
    emit({ type: 'running', running: true });
    emit({ type: 'exhausted' });
    await coordinator.interrupt();
    emit({ type: 'running', running: false });
    emit({ type: 'exhausted' });
    assert.equal(coordinator.snapshot.conversation!.agent, 'claude');
    assert.equal(codex.inputs.length, 0);
    await coordinator.send('User resumed');
    assert.equal(claude.inputs.length, 2);
    assert.equal(codex.inputs.length, 0);
  } finally {
    await coordinator.close();
  }
});

test('background memory waits for recovery, then continues completed work on the destination', async () => {
  const { coordinator, claude, codex, emit, store } =
    await completedForBackground();
  try {
    emit({ type: 'running', running: true });
    await writeFile(
      join(claude.sessions.at(-1)!.options.memoryDirectories[1]!, 'MEMORY.md'),
      'Background note.',
    );
    emit({ type: 'exhausted' });
    emit({ type: 'running', running: false });
    await until(
      'background memory recovery',
      () => coordinator.snapshot.phase === 'recovery',
    );
    assert.equal(codex.inputs.length, 0);
    assert.equal(
      (await store.records()).records.find(
        ({ id }) => id === coordinator.snapshot.conversation!.id,
      )!.lastTurn!.status,
      'completed',
    );
    await assert.rejects(
      coordinator.recoverMemory('keep'),
      /Accept these memory changes/,
    );
    await coordinator.send('Queued during recovery');
    await coordinator.recoverMemory('accept');
    await until(
      'recovered background continuation',
      () => codex.inputs.length === 2 && coordinator.snapshot.phase === 'idle',
    );
    assert.deepEqual(
      codex.inputs.map(({ prompt }) => prompt),
      [continuation, 'Queued during recovery'],
    );
    assert.match(codex.inputs[0]!.context!, /Background note/);
    assert.equal(claude.inputs.length, 1);
  } finally {
    await coordinator.close();
  }
});

for (const stage of ['add', 'commit'] as const)
  test(`background exhaustion during memory ${stage} retains dirty notes without changing the completed outcome`, async () => {
    const { coordinator, claude, codex, hook, store } = await exhaustion();
    let armed = false;
    const emit = claude.sessions.at(-1)!.options.onEvent;
    claude.onSend = async () => {
      armed = true;
    };
    hook.current = async (command, run) => {
      const result = await run();
      if (armed && command[0] === stage) {
        armed = false;
        emit({ type: 'running', running: true });
        emit({ type: 'exhausted' });
        emit({ type: 'running', running: false });
      }
      return result;
    };
    try {
      await coordinator.send('remember-port');
      assert.equal(coordinator.snapshot.phase, 'recovery');
      assert.equal(
        (await store.records()).records.find(
          ({ id }) => id === coordinator.snapshot.conversation!.id,
        )!.lastTurn!.status,
        'completed',
      );
      assert.match(coordinator.snapshot.recovery!.diff, /4567/);
      assert.equal(codex.inputs.length, 0);
      assert.ok(
        (await store.records()).records.find(
          ({ id }) => id === coordinator.snapshot.conversation!.id,
        )!.activity,
      );
      hook.current = passThrough;
      await coordinator.recoverMemory('discard');
      await until(
        'continuation after discarding background memory',
        () =>
          codex.inputs.length === 1 && coordinator.snapshot.phase === 'idle',
      );
      assert.deepEqual(
        codex.inputs.map(({ prompt }) => prompt),
        [continuation],
      );
    } finally {
      hook.current = passThrough;
      await coordinator.close();
    }
  });

test('a background switch with no destination reports a blocker and retains queued input', async () => {
  const { coordinator, claude, codex, emit } = await completedForBackground(
    (_, codex) => {
      codex.accountRead = reading(100);
    },
  );
  try {
    emit({ type: 'running', running: true });
    emit({ type: 'exhausted' });
    await coordinator.send('Retain this');
    emit({ type: 'running', running: false });
    await until('background capacity blocker', () =>
      notices(coordinator).some((text) =>
        text.includes('no other runtime can continue'),
      ),
    );
    assert.equal(coordinator.snapshot.conversation!.agent, 'claude');
    assert.equal(claude.inputs.length, 1);
    assert.equal(codex.inputs.length, 0);
    assert.deepEqual(coordinator.snapshot.queue, ['Retain this']);
  } finally {
    await coordinator.close();
  }
});

test('a background continuation that exhausts the destination stops after one hop', async () => {
  const { coordinator, claude, codex, emit } = await completedForBackground(
    (_, codex) => {
      codex.exhaust = () => true;
    },
  );
  try {
    emit({ type: 'exhausted' });
    await until('destination exhaustion', () =>
      notices(coordinator).some((text) => text.includes('also out of usage')),
    );
    assert.equal(coordinator.snapshot.conversation!.agent, 'codex');
    assert.equal(claude.inputs.length, 1);
    assert.equal(codex.inputs.length, 1);
  } finally {
    await coordinator.close();
  }
});

test('a peer pause cancels background switching and a later continuation preserves the claim', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  pauseDiscovery(vi.spyOn);
  const f = await unitCoordinationFixture(cleanup);
  const initiator = await f.start('A');
  const claude = new FixtureAgent('claude');
  const codex = new FixtureAgent('codex');
  claude.catalog.splice(0, Infinity, ...models(['claude-fable-5-2']));
  codex.catalog.splice(0, Infinity, ...models(['gpt-6-astra']));
  for (const adapter of [claude, codex]) adapter.accountRead = reading(10);
  const target = await f.start(
    'B',
    {},
    [claude, codex].map((adapter) => ({ adapter, executable: adapter.id })),
  );
  await target.coordinator.selectModel({
    agent: 'claude',
    id: 'claude-fable-5-2',
  });
  const claim = await target.claim('task:background-work', 'background task');
  if (claim.kind !== 'claimed') assert.fail(JSON.stringify(claim));
  await target.coordinator.send('Work on the task');
  const emit = claude.sessions.at(-1)!.options.onEvent;
  emit({ type: 'running', running: true });
  emit({ type: 'exhausted' });
  const pause = await callControl(await initiator.binding(), {
    kind: 'pause',
    to: [target.coordinator.snapshot.conversation!.id],
  });
  if (pause.kind !== 'pause') assert.fail(JSON.stringify(pause));
  await target.coordination.context();
  await until('pause interrupt', () =>
    claude.stops.some(({ operation }) => operation === 'interrupt'),
  );
  emit({ type: 'running', running: false });
  emit({ type: 'exhausted' });
  assert.equal(codex.inputs.length, 0);
  await callControl(await initiator.binding(), {
    kind: 'resume',
    pause: pause.pause.id,
  });
  await target.coordination.context();
  await target.coordinator.send('Resume the task');
  emit({ type: 'running', running: true });
  emit({ type: 'exhausted' });
  emit({ type: 'running', running: false });
  await until(
    'resumed background continuation',
    () =>
      codex.inputs.length === 1 && target.coordinator.snapshot.phase === 'idle',
  );
  assert.equal((await target.query()).ownClaim?.id, claim.claim.id);
  assert.equal(claude.inputs.length, 2);
  assert.equal(target.coordinator.snapshot.conversation!.agent, 'codex');
});

test('background settlement failure releases pending compaction and keeps the source', async () => {
  const { coordinator, codex, emit, hook } = await completedForBackground();
  try {
    emit({ type: 'running', running: true });
    emit({ type: 'exhausted' });
    hook.current = async (command, run) => {
      if (command[0] === 'status') {
        hook.current = passThrough;
        throw new Error('background memory unavailable');
      }
      return run();
    };
    const compacting = coordinator.compact();
    emit({ type: 'running', running: false });
    assert.equal(
      await within(compacting, 5000, 'failed background settlement'),
      false,
    );
    assert.match(coordinator.snapshot.error!, /background memory unavailable/);
    assert.equal(codex.inputs.length, 0);
    assert.equal(coordinator.snapshot.conversation!.agent, 'claude');
  } finally {
    hook.current = passThrough;
    await coordinator.close();
  }
});

for (const blocked of ['capacity', 'command'] as const)
  test(`background recovery attempts a ${blocked}-blocked switch only once`, async () => {
    const { coordinator, claude, codex, emit } = await completedForBackground();
    let release = () => {};
    try {
      await writeFile(
        join(
          claude.sessions.at(-1)!.options.memoryDirectories[1]!,
          'MEMORY.md',
        ),
        'Unfinished background note.',
      );
      emit({ type: 'exhausted' });
      await until(
        'memory decision',
        () => coordinator.snapshot.phase === 'recovery',
      );
      let attempts = 0;
      codex.accountRead = async () => {
        attempts++;
        return reading(100)();
      };
      if (blocked === 'command') release = coordinator.holdPromptDelivery();
      await coordinator.send('Retained input');
      await coordinator.recoverMemory('accept');
      await until(
        'single blocker',
        () =>
          coordinator.snapshot.phase === 'idle' &&
          notices(coordinator).some((text) =>
            text.includes(
              blocked === 'capacity'
                ? 'no other runtime can continue'
                : 'commands are pending',
            ),
          ),
      );
      const count = notices(coordinator).filter((text) =>
        text.includes(
          blocked === 'capacity'
            ? 'no other runtime can continue'
            : 'commands are pending',
        ),
      ).length;
      assert.equal(count, 1);
      assert.equal(attempts, blocked === 'capacity' ? 1 : 0);
      assert.deepEqual(coordinator.snapshot.queue, ['Retained input']);
      assert.equal(claude.inputs.length, 1);
      assert.equal(codex.inputs.length, 0);
    } finally {
      release();
      await coordinator.close();
    }
  });

for (const preparing of ['context', 'images'] as const)
  test(`background exhaustion stops a queued prompt during ${preparing} preparation`, async () => {
    const { coordinator, claude, codex, emit } = await completedForBackground();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    try {
      if (preparing === 'context') {
        const session = claude.sessions.at(-1)!.session;
        const context = session.contextUsage.bind(session);
        vi.spyOn(session, 'contextUsage').mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return context();
        });
      } else {
        const prepare = Attachments.prototype.prepare;
        vi.spyOn(Attachments.prototype, 'prepare').mockImplementationOnce(
          async function (this: Attachments, ...args) {
            entered.resolve();
            await release.promise;
            return prepare.apply(this, args);
          },
        );
      }
      const sending = coordinator.send('Prepared follow-up');
      await within(entered.promise, 3000, 'input preparation');
      emit({ type: 'exhausted' });
      release.resolve();
      await sending;
      await until(
        'destination receives prepared input',
        () =>
          codex.inputs.length === 2 && coordinator.snapshot.phase === 'idle',
      );
      assert.equal(claude.inputs.length, 1);
      assert.deepEqual(
        codex.inputs.map(({ prompt }) => prompt),
        [continuation, 'Prepared follow-up'],
      );
    } finally {
      release.resolve();
      await coordinator.close();
    }
  });

test('a steering image prepared across exhaustion stays queued for the destination', async () => {
  const { coordinator, claude, codex, emit } = await completedForBackground();
  const gate = new TurnGate();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    claude.gate = gate;
    const active = coordinator.send('Continue working');
    await gate.entered;
    const image = join(await scratch('witch-exhaustion-steer-'), 'image.png');
    await writeFile(image, png(2, 2));
    const marker = coordinator.paste(image, '')!;
    const prepare = Attachments.prototype.prepare;
    vi.spyOn(Attachments.prototype, 'prepare').mockImplementationOnce(
      async function (this: Attachments, ...args) {
        entered.resolve();
        await release.promise;
        return prepare.apply(this, args);
      },
    );
    const steering = coordinator.send(`Follow-up ${marker}`);
    await entered.promise;
    emit({ type: 'exhausted' });
    release.resolve();
    await steering;
    gate.open();
    await active;
    await until(
      'image reaches destination',
      () => codex.inputs.length === 2 && coordinator.snapshot.phase === 'idle',
    );
    assert.deepEqual(claude.steerImages, []);
    assert.equal(codex.inputs[1]!.images!.length, 1);
    assert.equal(claude.inputs.length, 2);
  } finally {
    gate.open();
    release.resolve();
    await coordinator.close();
  }
});

test('background rejection during transcript flush keeps dirty memory for recovery', async () => {
  const { coordinator, claude, codex, emit, store } =
    await completedForBackground();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const flush = ConversationStore.prototype.flush;
  let armed = false;
  const send = claude.sessions
    .at(-1)!
    .session.send.bind(claude.sessions.at(-1)!.session);
  vi.spyOn(claude.sessions.at(-1)!.session, 'send').mockImplementation(
    async (...args) => {
      const result = await send(...args);
      armed = true;
      return result;
    },
  );
  vi.spyOn(ConversationStore.prototype, 'flush').mockImplementation(
    async function (this: ConversationStore) {
      if (armed) {
        armed = false;
        entered.resolve();
        await release.promise;
      }
      return flush.call(this);
    },
  );
  try {
    const sending = coordinator.send('remember-port');
    await entered.promise;
    emit({ type: 'exhausted' });
    release.resolve();
    await sending;
    assert.equal(coordinator.snapshot.phase, 'recovery');
    assert.match(coordinator.snapshot.recovery!.diff, /4567/);
    assert.equal(
      (await store.records()).records[0]!.lastTurn!.status,
      'completed',
    );
    assert.equal(codex.inputs.length, 0);
  } finally {
    release.resolve();
    await coordinator.close();
  }
});

test('an old connection cannot exhaust a reconnected session with the same native id', async () => {
  const { coordinator, claude, codex, emit } = await completedForBackground();
  try {
    const old = claude.sessions.at(-1)!.session;
    await old.close();
    await coordinator.send('Reconnect');
    const current = claude.sessions.at(-1)!;
    assert.notEqual(current.session, old);
    assert.equal(current.session.info.id, old.info.id);
    emit({ type: 'exhausted' });
    await coordinator.send('Stay on the current connection');
    assert.equal(codex.inputs.length, 0);
    assert.equal(claude.inputs.length, 3);
    current.options.onEvent({ type: 'exhausted' });
    await until(
      'current connection exhaustion',
      () => codex.inputs.length === 1 && coordinator.snapshot.phase === 'idle',
    );
  } finally {
    await coordinator.close();
  }
});

for (const stage of [
  'settlement',
  'refresh',
  'save',
  'connection',
  'task',
] as const)
  test(`background work restarted during ${stage} waits for its final report`, async () => {
    const { coordinator, claude, codex, emit, hook } =
      await completedForBackground();
    let restarted = false;
    const restart = () => {
      if (restarted) return;
      restarted = true;
      emit({ type: 'running', running: true });
      emit({
        type: 'subagent',
        subagent: {
          id: 'late',
          name: 'late review',
          kind: 'review',
          status: 'running',
        },
      });
    };
    const save = ConversationStore.prototype.save;
    const scope = Workspace.prototype.scope;
    if (stage === 'settlement')
      hook.current = async (command, run) => {
        if (command[0] === 'status') restart();
        return run();
      };
    if (stage === 'refresh')
      codex.accountRead = async () => {
        restart();
        return reading(40)();
      };
    if (stage === 'save')
      vi.spyOn(ConversationStore.prototype, 'save').mockImplementation(
        async function (this: ConversationStore, record) {
          await save.call(this, record);
          if (record.handoff?.to === 'codex' && !record.handoff.activated)
            restart();
        },
      );
    if (stage === 'connection')
      vi.spyOn(Workspace.prototype, 'scope').mockImplementation(async function (
        this: Workspace,
        cwd,
      ) {
        const result = await scope.call(this, cwd);
        if (coordinator.snapshot.conversation?.handoff?.to === 'codex')
          restart();
        return result;
      });
    try {
      emit({ type: 'running', running: true });
      if (stage === 'task') restart();
      emit({ type: 'exhausted' });
      await coordinator.send('Queued after report');
      emit({ type: 'running', running: false });
      await until(
        'deferred background switch',
        () => restarted && coordinator.snapshot.phase === 'idle',
      );
      assert.equal(coordinator.snapshot.conversation!.agent, 'claude');
      assert.equal(claude.sessions.at(-1)!.session.closed, false);
      assert.equal(codex.inputs.length, 0);
      emit({ type: 'running', running: false });
      assert.equal(codex.inputs.length, 0);
      emit({
        type: 'subagent',
        subagent: {
          id: 'late',
          name: 'late review',
          kind: 'review',
          status: 'completed',
          report: 'Keep the foreign key.',
        },
      });
      await until(
        'report then queued input',
        () =>
          codex.inputs.length === 2 && coordinator.snapshot.phase === 'idle',
      );
      assert.deepEqual(
        codex.inputs.map(({ prompt }) => prompt),
        [continuation, 'Queued after report'],
      );
      assert.match(codex.inputs[0]!.context!, /Keep the foreign key/);
      assert.equal(claude.inputs.length, 1);
    } finally {
      hook.current = passThrough;
      await coordinator.close();
    }
  });
