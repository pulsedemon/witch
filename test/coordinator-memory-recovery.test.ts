import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import { promisify } from 'node:util';
import { Coordinator } from '../src/core/coordinator.js';
import { main } from '../src/memory/memory.js';
import { FixtureAgent, TurnGate } from './fixtures/agent.js';
import {
  activity,
  fixture,
  readRecord,
  stranded,
} from './fixtures/coordinator.js';
import { passThrough } from './fixtures/git.js';
import { within } from './fixtures/within.js';
import {
  assertMemoryBaseline,
  publishOutside,
} from './fixtures/coordinator-memory.js';

test('an agent-created nested repository is refused on accept and removed on discard', async () => {
  const { coordinator, a, workspace, note } = await fixture();

  try {
    a.interruptNext = true;

    await coordinator.send('remember-port');

    const nested = join(workspace().root, await note(), '..', 'nested');

    await mkdir(nested);

    await promisify(execFile)('git', ['init', '--quiet', nested]);

    await assert.rejects(
      coordinator.recoverMemory('accept'),
      /regular file: .*nested/,
    );

    assert.equal(coordinator.snapshot.recovery?.kind, 'pending');

    await coordinator.recoverMemory('discard');

    assert.equal(coordinator.snapshot.phase, 'idle');

    assert.equal(await workspace().isDirty(), false);
  } finally {
    await coordinator.close();
  }
});

test('a publish failure in settle is reported and the phase goes idle', async () => {
  const { coordinator, hook, memory } = await fixture();

  try {
    const before = await memory.resolve(main);

    hook.current = async (command, run) => {
      if (command[0] !== 'update-ref') return run();

      hook.current = passThrough;

      return { stdout: Buffer.alloc(0), stderr: 'cannot lock ref', code: 1 };
    };

    await coordinator.send('remember-port');

    assert.equal(coordinator.snapshot.phase, 'idle');

    assert.match(coordinator.snapshot.error ?? '', /cannot lock ref/);

    assert.equal(await memory.resolve(main), before);
  } finally {
    await coordinator.close();
  }
});

test('a failed rebase abort stops in the error phase until restart', async () => {
  const context = await fixture();
  const { coordinator, hook } = context;

  try {
    const target = await stranded(context, { 'global/one.md': 'Mine.\n' });

    await target.files.close();

    await publishOutside(context, { 'global/one.md': 'Theirs.\n' });

    hook.current = async (command, run) => {
      if (command.join(' ') !== 'rebase --abort') return run();

      hook.current = passThrough;

      throw new Error('abort failed');
    };

    await assert.rejects(
      coordinator.selectConversation(target.id),
      /Restart Witch/,
    );

    assert.equal(coordinator.snapshot.phase, 'error');

    await assert.rejects(coordinator.recoverMemory('accept'), /Restart Witch/);
  } finally {
    await coordinator.close().catch(() => {});
  }
});

for (const decision of ['keep', 'discard'] as const) {
  test(`recovery shows the blocked commit after a later local revert (${decision})`, async () => {
    const f = await fixture();

    try {
      await publishOutside(f, { 'global/n.md': 'one\n' });

      const target = await stranded(f, { 'global/n.md': 'a-change\n' });

      try {
        await writeFile(join(target.memory.root, 'global/n.md'), 'one\n');

        await target.memory.commit('revert');
      } finally {
        await target.files.close();
      }

      await publishOutside(f, { 'global/n.md': 'b-change\n' });

      await f.coordinator.selectConversation(target.id);

      const recovery = f.coordinator.snapshot.recovery;

      assert.equal(recovery?.kind, 'conflict');

      assert.deepEqual(recovery.paths, ['global/n.md']);

      assert.match(recovery.diff, /^-one$/m);

      assert.match(recovery.diff, /^\+a-change$/m);

      await f.coordinator.recoverMemory(decision);

      assert.equal(f.coordinator.snapshot.phase, 'idle');

      assert.equal(await f.memory.read(main, 'global/n.md'), 'b-change\n');
    } finally {
      await f.coordinator.close();
    }
  });
}

test('keep mine publishes with the attribution of the conversation that kept its side', async () => {
  const context = await fixture();
  const { coordinator, a, memory, notes } = context;
  const gate = new TurnGate();

  try {
    await coordinator.send('Start');

    a.gate = gate;
    const sending = coordinator.send('remember:mine');

    await within(gate.entered, 2000, 'the gated turn');

    await publishOutside(context, { [await notes()]: 'theirs' });

    gate.open();

    await sending;

    assert.equal(coordinator.snapshot.recovery?.kind, 'conflict');

    await coordinator.recoverMemory('keep');

    assert.equal(coordinator.snapshot.phase, 'idle');

    assert.equal(await memory.read(main, await notes()), 'mine');

    assert.match(
      await memory.git(memory.root, ['log', '-1', '--format=%b', main]),
      new RegExp(`conversation: ${coordinator.snapshot.conversation!.id}`),
    );
  } finally {
    gate.open();

    await coordinator.close();
  }
});

test('two coordinators in two directories run turns at once and both publish', async () => {
  const context = await fixture();
  const { root, store, memory } = context;
  const other = join(root, 'other');

  await mkdir(other);

  const agents = [context.a, new FixtureAgent('a')];
  const gates = agents.map((agent) => (agent.gate = new TurnGate()));

  const coordinators = [
    context.coordinator,
    new Coordinator(store, memory, [{ adapter: agents[1]!, executable: 'a' }]),
  ];

  try {
    await coordinators[1]!.initialize(other);

    const sends = coordinators.map((coordinator, index) =>
      coordinator.send(`remember:note-${index}`),
    );

    await within(
      Promise.all(gates.map((gate) => gate.entered)),
      5000,
      'both turns',
    );

    for (const coordinator of coordinators)
      assert.equal(coordinator.snapshot.phase, 'running');

    for (const gate of gates) gate.open();

    await Promise.all(sends);

    for (const [index, cwd] of [context.project, other].entries()) {
      const path = `${(await memory.scopePaths(cwd)).project}/notes.md`;

      assert.equal(await memory.read(main, path), `note-${index}`);

      assert.match(
        await memory.git(memory.root, [
          'log',
          '-1',
          '--format=%b',
          main,
          '--',
          path,
        ]),
        new RegExp(
          `conversation: ${coordinators[index]!.snapshot.conversation!.id}`,
        ),
      );
    }
  } finally {
    for (const gate of gates) gate.open();

    for (const coordinator of coordinators) await coordinator.close();
  }
});

test('discard mine after a conflict between two coordinators keeps the other side', async () => {
  const context = await fixture();
  const { store, memory, project, notes } = context;
  const agents = [context.a, new FixtureAgent('a')];
  const gates = agents.map(() => new TurnGate());

  const coordinators = [
    context.coordinator,
    new Coordinator(store, memory, [{ adapter: agents[1]!, executable: 'a' }]),
  ];

  try {
    await coordinators[1]!.initialize(project);

    const note = await context.note();

    await publishOutside(context, {
      'global/MEMORY.md': 'Global preference 17.',
      [note]: 'Project preference 29.',
    });

    await Promise.all(
      coordinators.map((coordinator) => coordinator.send('Initial task')),
    );

    for (const [index, agent] of agents.entries()) agent.gate = gates[index];

    const sends = coordinators.map((coordinator, index) =>
      coordinator.send(`remember:text-${index}`),
    );

    await within(
      Promise.all(gates.map((gate) => gate.entered)),
      5000,
      'both turns',
    );

    const second = coordinators[1]!;
    const losing = context.workspace(second.snapshot.conversation!.id);

    for (const [path, text] of Object.entries({
      'global/MEMORY.md': 'Rejected global preference 71.',
      [note]: 'Rejected project preference 83.',
      'global/discarded.md': 'Rejected new note 109.',
    }))
      await writeFile(join(losing.root, path), text);

    gates[0]!.open();

    await sends[0];

    gates[1]!.open();

    await sends[1];

    assert.equal(second.snapshot.recovery?.kind, 'conflict');

    await second.recoverMemory('discard');

    assert.equal(second.snapshot.phase, 'idle');

    assert.equal(await memory.read(main, await notes()), 'text-0');

    assert.equal(
      await context.workspace(second.snapshot.conversation!.id).revision(),
      await memory.resolve(main),
    );

    await assert.rejects(readFile(join(losing.root, 'global/discarded.md')), {
      code: 'ENOENT',
    });

    await second.send('Continue after discard');

    const prompt = agents[1]!.inputs.at(-1)!.context!;

    assertMemoryBaseline(prompt);

    assert.match(prompt, /Global preference 17/);

    assert.match(prompt, /Project preference 29/);

    assert.doesNotMatch(prompt, /Rejected/);
  } finally {
    for (const gate of gates) gate.open();

    for (const coordinator of coordinators) await coordinator.close();
  }
});

test('discard after an activated handoff corrects both native sessions', async () => {
  const f = await fixture();

  try {
    await publishOutside(f, {
      'global/MEMORY.md': 'Global preference 17.',
      [await f.note()]: 'Project preference 29.',
      'global/reference.md': 'Reference detail 53.',
    });

    f.a.interruptNext = true;

    await f.coordinator.send('Initial task');

    const source = f.a.sessions.at(-1)!;
    const sourceId = source.session.info.id;
    const send = source.session.send.bind(source.session);

    const writing = vi
      .spyOn(source.session, 'send')
      .mockImplementation(async (...args: Parameters<typeof send>) => {
        await writeFile(
          join(f.workspace().root, 'global/MEMORY.md'),
          'Rejected global preference 71.',
        );

        await writeFile(
          join(f.workspace().root, 'global/reference.md'),
          'Rejected reference detail 97.',
        );

        await publishOutside(f, {
          'global/reference.md': 'Winning reference detail 127.',
        });

        return send(...args);
      });

    await assert.rejects(
      f.coordinator.selectModel({ agent: 'b', id: 'b-model' }),
      /memory changes conflict/,
    );

    writing.mockRestore();

    assert.equal(f.coordinator.snapshot.conversation?.agent, 'b');

    assert.equal(f.coordinator.snapshot.recovery?.kind, 'conflict');

    assert.equal(f.b.inputs.length, 0);

    const destinationId = f.b.sessions.at(-1)!.session.info.id;

    await f.coordinator.recoverMemory('discard');

    await f.coordinator.send('Continue after discard');

    assert.equal(f.b.inputs.at(-1)!.session, destinationId);

    const destinationPrompt = f.b.inputs.at(-1)!.context!;

    await f.coordinator.selectModel({ agent: 'a', id: 'a-model' });

    await f.coordinator.send('Continue on the original runtime');

    assert.equal(f.a.inputs.at(-1)!.session, sourceId);

    for (const prompt of [destinationPrompt, f.a.inputs.at(-1)!.context!]) {
      assertMemoryBaseline(prompt);

      assert.match(prompt, /Global preference 17/);

      assert.match(prompt, /Project preference 29/);

      assert.doesNotMatch(prompt, /Rejected/);
    }
  } finally {
    vi.restoreAllMocks();

    await f.coordinator.close();
  }
});

for (const kind of ['pending', 'conflict'] as const) {
  test(`a failed ${kind} discard preserves memory delivery until retry`, async () => {
    const f = await fixture();
    const gate = new TurnGate();

    try {
      await publishOutside(f, {
        'global/MEMORY.md': 'Global preference 17.',
        [await f.note()]: 'Project preference 29.',
      });

      await f.coordinator.send('Initial task');

      const id = f.coordinator.snapshot.conversation!.id;
      f.a.failNext = kind === 'pending';
      f.a.gate = gate;
      const sending = f.coordinator.send('remember:mine');

      await within(gate.entered, 3000, 'the writing turn');

      if (kind === 'conflict')
        await publishOutside(f, { [await f.notes()]: 'theirs' });

      gate.open();

      await sending;

      assert.equal(f.coordinator.snapshot.recovery?.kind, kind);

      const before = (await readRecord(f.root, id)).sessions;

      f.hook.current = (command, run) => {
        if (command[0] === 'reset') throw new Error('Discard reset failed');

        return run();
      };

      await assert.rejects(
        f.coordinator.recoverMemory('discard'),
        /Discard reset failed/,
      );

      assert.equal(f.coordinator.snapshot.recovery?.kind, kind);

      assert.deepEqual((await readRecord(f.root, id)).sessions, before);

      f.hook.current = passThrough;

      await f.coordinator.recoverMemory('discard');

      await f.coordinator.send('Continue after retry');

      const prompt = f.a.inputs.at(-1)!.context!;

      assertMemoryBaseline(prompt);

      assert.match(prompt, /Global preference 17/);

      assert.match(prompt, /Project preference 29/);
    } finally {
      f.hook.current = passThrough;

      gate.open();

      await f.coordinator.close();
    }
  });
}

test('the launch sweep publishes what it can and reports the rest in one message', async () => {
  const context = await fixture();
  const { root, memory, store } = context;

  await context.coordinator.close();

  const conflict = await stranded(
    context,
    { 'global/one.md': 'Mine.\n' },
    join(root, 'deleted-project'),
  );

  await conflict.files.close();

  await publishOutside(context, { 'global/one.md': 'Theirs.\n' });

  const unpublished = await stranded(
    context,
    { 'global/two.md': 'Two.' },
    join(root, 'deleted-project'),
  );

  await unpublished.files.close();

  const dirty = await stranded(context, {});
  dirty.files.record.activity = activity();

  await dirty.files.save(dirty.files.record);

  await dirty.files.close();

  await writeFile(join(dirty.memory.root, 'global', 'three.md'), 'Three.');

  const stateless = randomUUID();
  const orphan = await context.outsider(stateless);

  await writeFile(join(orphan.root, 'global', 'four.md'), 'Four.');

  await orphan.commit('chore(memory): save outside notes');

  const fresh = join(root, 'fresh');

  await mkdir(fresh);

  for (const launch of [1, 2]) {
    const coordinator = new Coordinator(store, memory, [
      { adapter: context.a, executable: 'a' },
    ]);

    const reports: (string | undefined)[] = [];

    coordinator.subscribe(() => {
      if (coordinator.snapshot.phase !== 'starting')
        reports.push(coordinator.snapshot.error);
    });

    try {
      await coordinator.initialize(fresh);

      if (launch === 1)
        assert.equal(await memory.read(main, 'global/two.md'), 'Two.');

      assert.ok(reports.length > 0);

      for (const report of reports) {
        assert.match(report ?? '', /Open each from \/sessions/);

        assert.match(
          report ?? '',
          new RegExp(
            `Title ${conflict.id} in .*deleted-project \\(start Witch in its new location\\): memory conflicts`,
          ),
        );

        assert.match(
          report ?? '',
          new RegExp(`Title ${dirty.id} in [^(\n]*: unfinished`),
        );

        assert.doesNotMatch(
          report ?? '',
          new RegExp(`Title ${unpublished.id}`),
        );

        assert.match(
          report ?? '',
          new RegExp(`conversations/${stateless} has unpublished memory`),
        );
      }
    } finally {
      await coordinator.close();
    }
  }
});

test('a sweep failure after the claim is reported and releases the claim', async () => {
  const context = await fixture();
  const { root, store, memory } = context;

  await context.coordinator.close();

  const broken = await stranded(context, { 'global/x.md': 'X.' });
  broken.files.record.activity = activity();

  await broken.files.save(broken.files.record);

  await broken.files.close();

  await writeFile(join(broken.memory.root, '.git'), 'not a worktree\n');

  const fresh = join(root, 'fresh');

  await mkdir(fresh);

  const coordinator = new Coordinator(store, memory, [
    { adapter: context.a, executable: 'a' },
  ]);

  try {
    await coordinator.initialize(fresh);

    assert.match(
      coordinator.snapshot.error ?? '',
      new RegExp(`Title ${broken.id}`),
    );

    await (await store.claim(broken.id)).close();
  } finally {
    await coordinator.close();
  }
});

test('a switch target with a broken worktree leaves the current conversation untouched', async () => {
  const context = await fixture();
  const { coordinator, store, a } = context;

  try {
    await coordinator.send('Start');

    const current = coordinator.snapshot.conversation!.id;
    const target = await stranded(context, { 'global/x.md': 'X.' });

    await target.files.close();

    await writeFile(join(target.memory.root, '.git'), 'not a worktree\n');

    await assert.rejects(coordinator.selectConversation(target.id));

    assert.equal(coordinator.snapshot.conversation!.id, current);

    assert.equal(a.sessions.at(-1)!.session.closed, false);

    await assert.rejects(
      store.claim(current),
      /open in another Witch instance/,
    );
  } finally {
    await coordinator.close();
  }
});

test('opening a conversation aborts its stopped rebase before classifying it', async () => {
  const context = await fixture();
  const { coordinator } = context;

  try {
    const target = await stranded(context, { 'global/one.md': 'Mine.\n' });

    await target.files.close();

    await publishOutside(context, { 'global/one.md': 'Theirs.\n' });

    await promisify(execFile)(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'rebase', main],
      { cwd: target.memory.root },
    ).catch(() => {});

    assert.equal(await target.memory.rebaseStopped(), true);

    await coordinator.selectConversation(target.id);

    assert.equal(await target.memory.rebaseStopped(), false);

    assert.equal(coordinator.snapshot.recovery?.kind, 'conflict');
  } finally {
    await coordinator.close();
  }
});

test('a native session that replaces the stored one gets the memory snapshot again', async () => {
  const { coordinator, a } = await fixture();

  try {
    await coordinator.send('remember-port');

    await coordinator.send('Again');

    const previousSession = a.inputs.at(-1)!.session;

    // the native agent starts a fresh session instead of resuming
    a.beforeConnect = async (options) => {
      options.resume = undefined;
    };

    await a.sessions.at(-1)!.session.close();

    await coordinator.send('Next');

    assert.match(a.inputs.at(-1)!.context!, /Use port 4567/);

    assert.match(a.inputs.at(-1)!.context!, /You are running inside Witch/);

    assert.notEqual(a.inputs.at(-1)!.session, previousSession);
  } finally {
    await coordinator.close();
  }
});

test('the memory view reads accepted memory, and links into the worktree only while it holds that revision', async () => {
  const { coordinator, memory, workspace, notes, outsider } = await fixture();

  try {
    const other = await outsider();

    await writeFile(join(other.root, await notes()), 'Published elsewhere.');

    await other.commit('save elsewhere');

    await other.publish();

    const behind = await coordinator.memoryView();

    assert.equal(behind.revision, await memory.resolve(main));

    assert.equal(behind.root, undefined);

    await coordinator.send('Next');

    assert.equal((await coordinator.memoryView()).root, workspace().root);
  } finally {
    await coordinator.close();
  }
});
