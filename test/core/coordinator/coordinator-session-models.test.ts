import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentSession } from '../../../src/agents/types.js';
import { Coordinator } from '../../../src/core/coordinator.js';
import { StateStore } from '../../../src/persistence/store.js';
import { TurnGate } from '../../fixtures/agent.js';
import { jsonLines, launcher } from '../../fixtures/claude-adapter.js';
import {
  unitFixture as fixture,
  readRecord,
} from '../../fixtures/coordinator.js';
import { seededMemory } from '../../fixtures/seeded-memory.js';
import { until, within } from '../../fixtures/within.js';

test('a model chosen to keep the current effort stores the effort in force', async () => {
  const { coordinator, root } = await fixture();

  try {
    await coordinator.selectModel({ agent: 'a', id: 'first', effort: 'high' });
    await coordinator.selectModel({ agent: 'a', id: 'second' });
    await coordinator.selectModel({ agent: 'a', id: 'a-big' });

    const record = await readRecord(
      root,
      coordinator.snapshot.conversation!.id,
    );

    assert.equal(record.sessions.a?.effort, 'high');
  } finally {
    await coordinator.close();
  }
});

test('catalog refresh preserves the active session, process, transcript, usage and skills and reports each failed runtime', async () => {
  const { coordinator, a, b, root } = await fixture(undefined, (a) => {
    a.connectUsage = { context: 0.75 };
    a.skills = [{ name: 'spell', description: 'Current spell' }];
  });

  try {
    await coordinator.send('Keep this conversation');
    const before = structuredClone(coordinator.snapshot);
    const saved = await readRecord(root, before.conversation!.id);
    assert.equal(await coordinator.refreshModels(), true);

    assert.deepEqual(
      coordinator.snapshot.models.map(({ agent, id }) => [agent, id]),
      [
        ['a', 'a-model'],
        ['a', 'a-big'],
        ['b', 'b-model'],
        ['b', 'b-big'],
      ],
    );

    assert.deepEqual(coordinator.snapshot.native, before.native);
    assert.deepEqual(coordinator.snapshot.items, before.items);
    assert.deepEqual(coordinator.snapshot.usage, before.usage);
    assert.deepEqual(coordinator.snapshot.skills, before.skills);
    const after = await readRecord(root, before.conversation!.id);
    assert.deepEqual(after.sessions, saved.sessions);
    assert.deepEqual(after.process, saved.process);
    assert.equal(a.sessions.length, 1);
    assert.equal(a.sessions[0]!.session.closed, false);
    assert.equal(b.sessions.length, 0);
    b.failDiscovery = true;
    assert.equal(await coordinator.refreshModels(), true);

    assert.deepEqual(
      coordinator.snapshot.models.map((model) => model.agent),
      ['a', 'a'],
    );

    assert.equal(coordinator.snapshot.error, undefined);

    assert.equal(
      coordinator.snapshot.items.at(-1)?.text,
      'b: Discovery failed',
    );

    assert.equal(coordinator.snapshot.native!.id, before.native!.id);
    a.failModels = true;
    assert.equal(await coordinator.refreshModels(), true);
    assert.deepEqual(coordinator.snapshot.models, []);

    assert.equal(
      coordinator.snapshot.items.at(-1)?.text,
      'a: model/list failed\nb: Discovery failed',
    );

    assert.equal(coordinator.snapshot.error, undefined);
  } finally {
    await coordinator.close();
  }
});

test('standalone catalogs recover from a failed active startup without reconnecting it', async () => {
  const { coordinator, a, b } = await fixture(undefined, (a) => {
    a.failConnect = true;
  });

  try {
    assert.match(coordinator.snapshot.error!, /Destination unavailable/);
    await coordinator.refreshModels();

    assert.deepEqual(
      coordinator.snapshot.models.map((model) => model.agent),
      ['a', 'a', 'b', 'b'],
    );

    assert.equal(a.sessions.length, 0);
    assert.equal(b.sessions.length, 0);
    await coordinator.selectModel({ agent: 'b', id: 'b-big', effort: 'high' });
    assert.equal(coordinator.snapshot.conversation!.agent, 'b');
    assert.equal(coordinator.snapshot.native!.model, 'b-big');
    assert.equal(coordinator.snapshot.native!.effort, 'high');
    assert.deepEqual(b.inputs, []);
  } finally {
    await coordinator.close();
  }
});

test('closing during catalog discovery cancels and joins its cleanup', async () => {
  const { coordinator, a, b } = await fixture();
  const entered = Promise.withResolvers<AbortSignal>();
  const aborted = Promise.withResolvers<void>();
  const cleaned = Promise.withResolvers<void>();

  b.models = async (options) => {
    entered.resolve(options.signal!);

    options.signal!.addEventListener('abort', () => aborted.resolve(), {
      once: true,
    });

    await aborted.promise;
    await cleaned.promise;
    options.signal!.throwIfAborted();

    return b.catalog;
  };

  const refreshing = coordinator.refreshModels();
  const rejected = assert.rejects(refreshing, { name: 'AbortError' });
  let closing: Promise<void> | undefined;

  try {
    const signal = await within(entered.promise, 2000, 'inactive discovery');
    let closed = false;

    closing = coordinator.close().then(() => {
      closed = true;
    });

    assert.equal(signal.aborted, true);
    await until('active shutdown', () => a.sessions.at(-1)!.session.closed);
    assert.equal(closed, false);
    cleaned.resolve();
    await within(Promise.all([closing, rejected]), 2000, 'catalog shutdown');
    assert.equal(b.sessions.length, 0);
  } finally {
    aborted.resolve();
    cleaned.resolve();
    await Promise.allSettled([refreshing, rejected, closing]);
    await coordinator.close();
  }
});

test('an effort the agent rejects while disconnected keeps the stored one, so the next turn still connects', async () => {
  const { coordinator, a, root } = await fixture();

  try {
    await coordinator.selectModel({ agent: 'a', id: 'a-big', effort: 'high' });
    a.invalidEffort = 'hgih';
    await a.sessions.at(-1)!.session.close();

    await assert.rejects(
      coordinator.selectModel({ agent: 'a', id: 'a-big', effort: 'hgih' }),
      /Invalid effort/,
    );

    const id = coordinator.snapshot.conversation!.id;
    assert.equal((await readRecord(root, id)).sessions.a?.effort, 'high');
    await a.sessions.at(-1)!.session.close();
    const opened = a.sessions.length;
    await coordinator.send('Continue');
    assert.equal(a.sessions.length, opened + 1);
    assert.equal(a.sessions.at(-1)!.options.effort, 'high');
  } finally {
    await coordinator.close();
  }
});

test('a model that lists no efforts resets the effort', async () => {
  const { coordinator, a, root } = await fixture();

  try {
    await coordinator.selectModel({ agent: 'a', id: 'first', effort: 'high' });
    await coordinator.selectModel({ agent: 'a', id: 'a-model' });
    assert.deepEqual(a.selections.at(-1), ['a-model', null]);

    const record = await readRecord(
      root,
      coordinator.snapshot.conversation!.id,
    );

    assert.equal(record.sessions.a?.effort, undefined);
  } finally {
    await coordinator.close();
  }
});

test('the live session publishes its skills, and a failed connect after /new shows none', async () => {
  const review = { name: 'review', description: 'Review changes' };

  const { coordinator, b } = await fixture(undefined, (a) => {
    a.skills = [review];
  });

  try {
    assert.deepEqual(coordinator.snapshot.skills, [review]);
    b.failConnect = true;
    await assert.rejects(coordinator.newConversation('b'));
    assert.equal(coordinator.snapshot.conversation!.agent, 'b');
    assert.deepEqual(coordinator.snapshot.skills, []);
  } finally {
    await coordinator.close();
  }
});

test('a skills failure while connecting is reported and keeps the session', async () => {
  const { coordinator, a } = await fixture();

  try {
    a.failSkills = true;
    await coordinator.newConversation();
    assert.equal(coordinator.snapshot.error, undefined);

    assert.deepEqual(
      coordinator.snapshot.items.map(({ kind, text }) => [kind, text]),
      [['notice', 'Skills unavailable']],
    );

    assert.deepEqual(coordinator.snapshot.skills, []);
    await coordinator.send('Start');
    assert.equal(a.sessions.length, 2);
  } finally {
    await coordinator.close();
  }
});

test('a listed /skill reaches the agent as a skill call, and an unlisted one stays a prompt', async () => {
  const { coordinator, a } = await fixture(undefined, (a) => {
    a.skills = [{ name: 'review', description: 'Review changes' }];
  });

  try {
    await coordinator.send(' /review  the\ndiff ');

    assert.deepEqual(a.inputs.at(-1)!.skill, {
      name: 'review',
      args: 'the\ndiff',
    });

    assert.match(a.inputs.at(-1)!.prompt, /^ \/review {2}the/);
    await coordinator.send('/review');
    assert.deepEqual(a.inputs.at(-1)!.skill, { name: 'review', args: '' });
    await coordinator.send('/reviewer x');
    assert.equal(a.inputs.at(-1)!.skill, undefined);
  } finally {
    await coordinator.close();
  }
});

test("a model list that fails at connect is reported, and the session's skills and usage still reach the snapshot", async () => {
  const { coordinator, a, store, project } = await fixture(undefined, (a) => {
    a.skills = [{ name: 'review', description: 'Review changes' }];
    a.connectUsage = { context: 5 };
    a.failModels = true;
  });

  try {
    assert.equal(coordinator.snapshot.error, undefined);

    assert.deepEqual(
      coordinator.snapshot.items.map(({ kind, text }) => [kind, text]),
      [['notice', 'a: model/list failed']],
    );

    assert.deepEqual(await store.conversations(project), []);

    assert.deepEqual(
      coordinator.snapshot.skills.map((skill) => skill.name),
      ['review'],
    );

    assert.deepEqual(coordinator.snapshot.usage, { context: 5 });
    await coordinator.send('/review now');
    assert.deepEqual(a.inputs.at(-1)!.skill, { name: 'review', args: 'now' });
  } finally {
    await coordinator.close();
  }
});

for (const stop of ['interrupt', 'close'] as const)
  test(`${stop}() during a model change closes the session that holds it`, async () => {
    const { coordinator, a } = await fixture();

    try {
      const { session } = a.sessions.at(-1)!;
      const entered = Promise.withResolvers<void>();

      // as Codex's does, the change ends only when its session closes
      session.selectModel = async () => {
        entered.resolve();

        for (let wait = 0; wait < 100 && !session.closed; wait++)
          await delay(10);

        throw new Error(session.closed ? 'Session closed' : 'Still open');
      };

      const selecting = coordinator.selectModel({ agent: 'a', id: 'next' });
      await within(entered.promise, 2000, 'the model change');
      // close() awaits the change, so its rejection needs a handler first
      const rejected = assert.rejects(selecting, /Session closed/);
      await coordinator[stop]();
      await rejected;
    } finally {
      await coordinator.close();
    }
  });

for (const stop of ['interrupt', 'close'] as const)
  for (const ended of [false, true])
    test(`${stop}() cancels a replied model change ${ended ? 'after native idle' : 'during the native turn'}`, async () => {
      const { coordinator, a, store } = await fixture();
      const { session } = a.sessions.at(-1)!;
      const gate = new TurnGate();
      const entered = Promise.withResolvers<void>();
      const closed = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const order: string[] = [];
      let selecting: Promise<void> | undefined;
      let sending: Promise<void> | undefined;
      let stopping: Promise<void> | undefined;

      try {
        session.selectModel = async () => {
          entered.resolve();
          await closed.promise;
          await release.promise;

          throw new Error('Selection cancelled');
        };

        const interrupt = session.interrupt.bind(session);

        session.interrupt = async () => {
          if (!order.includes('interrupt entered'))
            order.push('interrupt entered');

          await interrupt();
        };

        const close = session.close.bind(session);

        session.close = async () => {
          if (!session.closed) order.push('session close entered');

          await close();
          closed.resolve();
        };

        a.gate = gate;
        sending = coordinator.send('Start');
        await within(gate.entered, 2000, 'the first turn');
        a.replied = true;

        selecting = assert
          .rejects(
            coordinator.selectModel({
              agent: 'a',
              id: 'a-big',
              effort: 'high',
            }),
            {
              message: 'Selection cancelled',
            },
          )
          .then(() => {
            order.push('selection settled');
          });

        await within(entered.promise, 2000, 'the model change');

        if (ended) {
          gate.open();
          await within(gate.result, 2000, 'the native turn');
        }

        stopping = coordinator[stop]().then(() => {
          if (stop === 'close') order.push('coordinator closed');
        });

        await within(closed.promise, 2000, 'the cancelled native session');

        if (stop === 'close') {
          // keep the rejection pending beyond the native close, which alone must not release the conversation
          await delay(400);
          assert.ok(!order.includes('coordinator closed'));
        }

        release.resolve();

        await within(
          Promise.all([selecting, sending, stopping]),
          3000,
          'the cancelled model change',
        );

        assert.deepEqual(order, [
          'interrupt entered',
          'session close entered',
          'selection settled',
          ...(stop === 'close' ? ['coordinator closed'] : []),
        ]);

        assert.equal(
          (await gate.result).status,
          ended ? 'completed' : 'interrupted',
        );

        if (stop === 'close') {
          const reclaimed = await store.claim(
            coordinator.snapshot.conversation!.id,
          );

          await reclaimed.close();
        } else {
          gate.open();
          const before = a.sessions.length;
          await within(coordinator.send('After'), 3000, 'the resumed turn');
          assert.equal(a.sessions.length, before + 1);
          assert.equal(a.sessions.at(-1)!.session.info.id, session.info.id);
          assert.ok(a.inputs.at(-1)!.prompt === 'After');
        }
      } finally {
        release.resolve();
        gate.open();
        await session.close();
        await Promise.allSettled([selecting, sending, stopping]);
        await coordinator.close();
      }
    });

test('interrupting a pending replied model change preserves unread Claude prompts', async () => {
  const { cwd, children, connect, adapter } = await launcher('pending-model');
  const store = await StateStore.open(join(cwd, 'state'));
  const memory = await seededMemory(join(cwd, 'state', 'memory.git'));
  let session: AgentSession | undefined;

  const coordinator = new Coordinator(store, memory, [
    {
      adapter: {
        id: 'claude',
        label: 'Claude',
        models: (options) => adapter.models(options),
        accountUsage: async () => ({ limits: [] }),
        connect: async (options) => (session = await connect(options)),
      },
      executable: '/fake/claude',
    },
  ]);

  let sending: Promise<void> | undefined;
  let selecting: Promise<void> | undefined;

  try {
    await coordinator.initialize(cwd);
    assert.equal(coordinator.snapshot.error, undefined);
    sending = coordinator.send('reporting familiar');
    await until('the replied turn', () => !!session?.replied);

    selecting = assert.rejects(
      coordinator.selectModel({
        agent: 'claude',
        id: 'claude-next',
        effort: 'high',
      }),
      /Query closed/,
    );

    await until('the held model request', () =>
      readFile(join(cwd, 'model-entered')).then(
        () => true,
        () => false,
      ),
    );

    await coordinator.send('keep this unread prompt');

    await until('the unread prompt', async () =>
      (await jsonLines(join(cwd, 'steered.jsonl'))).includes(
        'keep this unread prompt',
      ),
    );

    await within(coordinator.interrupt(), 3000, 'the interrupt receipt');

    await within(
      Promise.all([sending, selecting]),
      3000,
      'the interrupted operation',
    );

    assert.deepEqual(coordinator.snapshot.queue, ['keep this unread prompt']);

    assert.ok(
      coordinator.snapshot.items.some(
        ({ kind, text }) => kind === 'notice' && text === 'Turn interrupted',
      ),
    );
  } finally {
    await coordinator.close();
    await Promise.allSettled([sending, selecting]);

    assert.ok(
      children.every(
        (child) => child.exitCode !== null || child.signalCode !== null,
      ),
    );
  }
});
