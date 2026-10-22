import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdir, rm, writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Coordinator } from '../src/core/coordinator.js';
import type { Conversation, ConversationRecord } from '../src/core/state.js';
import { Memory } from '../src/memory/memory.js';
import { identifyProcess } from '../src/persistence/process.js';
import { StateStore } from '../src/persistence/store.js';
import { FixtureAgent } from './fixtures/agent.js';
import {
  record,
  activity,
  readRecord,
  fixture,
  stranded,
} from './fixtures/coordinator.js';
import { passThrough } from './fixtures/git.js';
import { scratch } from './fixtures/scratch.js';
import { within } from './fixtures/within.js';

await test('startup failures leave an exit-capable error state whose lookups reject rather than throw', async () => {
  const { coordinator: original, root, memory, a } = await fixture();
  await original.close();
  const coordinator = new Coordinator(
    await StateStore.open(join(root, 'state')),
    memory,
    [{ adapter: a, executable: 'a' }],
  );
  try {
    await assert.rejects(coordinator.initialize(join(root, 'missing')));
    assert.equal(coordinator.snapshot.phase, 'error');
    await assert.rejects(coordinator.conversations(), /No active conversation/);
    await assert.rejects(coordinator.projectFiles(), /No active conversation/);
  } finally {
    await coordinator.close();
  }
});

async function sweepFixture() {
  const root = await scratch('witch-sweep-');
  const project = join(root, 'project');
  const fresh = join(root, 'fresh');
  await mkdir(project);
  await mkdir(fresh);
  const store = await StateStore.open(join(root, 'state'));
  const memory = new Memory(join(root, 'state', 'memory.git'));
  const a = new FixtureAgent('a');
  const launch = async () => {
    const coordinator = new Coordinator(store, memory, [
      { adapter: a, executable: 'a' },
    ]);
    await coordinator.initialize(fresh);
    return coordinator;
  };
  const save = async (
    id: string,
    edit: (record: ConversationRecord) => void | Promise<void>,
  ) => {
    const files = await store.create(record(id, project));
    await edit(files.record);
    await files.save(files.record);
    await files.close();
  };
  return {
    memory,
    root,
    store,
    a,
    launch,
    save,
    directory: (id: string) => join(root, 'state', 'conversations', id),
  };
}

await test('the launch sweep stops a live orphan in an unlocked conversation', async () => {
  const { root, launch, save } = await sweepFixture();
  const orphan = spawn('/bin/sleep', ['20'], { stdio: 'ignore' });
  try {
    const exited = once(orphan, 'exit');
    const process = await identifyProcess(orphan.pid!);
    await save('orphan', (saved) => {
      saved.process = process;
    });
    const coordinator = await launch();
    try {
      await within(exited, 2000, 'the orphan exit');
      assert.equal((await readRecord(root, 'orphan')).process, undefined);
      assert.equal(coordinator.snapshot.error, undefined);
    } finally {
      await coordinator.close();
    }
  } finally {
    orphan.kill('SIGKILL');
  }
});

await test('the launch sweep skips a conversation another instance holds', async () => {
  const { store, launch } = await sweepFixture();
  const sleeper = spawn('/bin/sleep', ['20'], { stdio: 'ignore' });
  const held = await store.create(record('held', '/elsewhere'));
  try {
    held.record.activity = activity();
    held.record.process = await identifyProcess(sleeper.pid!);
    await held.save(held.record);
    const coordinator = await launch();
    try {
      assert.equal(sleeper.exitCode, null);
      assert.doesNotThrow(() => process.kill(sleeper.pid!, 0));
      assert.equal(coordinator.snapshot.error, undefined);
    } finally {
      await coordinator.close();
    }
  } finally {
    await held.close();
    sleeper.kill('SIGKILL');
  }
});

await test('one conversation the sweep fails on does not stop the launch', async () => {
  const { store, launch, save, directory } = await sweepFixture();
  await save('readonly', (saved) => {
    saved.activity = activity();
  });
  await chmod(directory('readonly'), 0o500);
  try {
    const coordinator = await launch();
    try {
      assert.equal(coordinator.snapshot.phase, 'idle');
      assert.match(coordinator.snapshot.error ?? '', /Title readonly/);
    } finally {
      await coordinator.close();
    }
  } finally {
    await chmod(directory('readonly'), 0o700);
  }
  await (await store.claim('readonly')).close();
});

await test("the launch sweep clears a clean conversation's stale activity", async () => {
  const { root, launch, save, memory } = await sweepFixture();
  await save('stale', (saved) => {
    saved.activity = activity();
  });
  const coordinator = await launch();
  await coordinator.close();
  assert.equal((await readRecord(root, 'stale')).activity, undefined);
  assert.equal(
    await memory.git(memory.root, [
      'for-each-ref',
      'refs/heads/conversations/stale',
    ]),
    '',
  );
});

await test('an unreadable state file is named by its full path in the launch report and skipped', async () => {
  const { launch, directory } = await sweepFixture();
  await mkdir(directory('broken'));
  await writeFile(join(directory('broken'), 'state.json'), '{"id":');
  const coordinator = await launch();
  try {
    assert.equal(coordinator.snapshot.phase, 'idle');
    assert.ok(
      coordinator.snapshot.error?.includes(
        `- ${join(directory('broken'), 'state.json')} can't be read`,
      ),
    );
  } finally {
    await coordinator.close();
  }
});

await test('a claim that fails for a reason other than a held lock is reported', async () => {
  const { launch, save, directory } = await sweepFixture();
  await save('blocked', (saved) => {
    saved.activity = activity();
  });
  await rm(join(directory('blocked'), 'lock'));
  await mkdir(join(directory('blocked'), 'lock'));
  const coordinator = await launch();
  try {
    assert.match(coordinator.snapshot.error ?? '', /Title blocked/);
  } finally {
    await coordinator.close();
  }
});

/** a conversation with history, last used at `seconds`. */
async function used(
  store: StateStore,
  root: string,
  conversation: Conversation,
  seconds?: number,
) {
  const files = await store.create(conversation);
  if (seconds !== undefined)
    await files.append({ id: 'n', kind: 'notice', text: 'used', cwd: '/' });
  await files.close();
  if (seconds !== undefined)
    await utimes(
      join(root, 'state', 'conversations', conversation.id, 'history.jsonl'),
      seconds,
      seconds,
    );
}

await test('continue opens the newest conversation in this directory, ignoring newer ones elsewhere', async () => {
  const { coordinator: first, store, root, project, a } = await fixture();
  await first.close();
  const elsewhere = join(root, 'elsewhere');
  await mkdir(elsewhere);
  await used(store, root, record('a1', project), 1000);
  await used(store, root, record('a2', project), 3000);
  await used(store, root, record('a3', project), 2000);
  await used(store, root, record('b1', elsewhere), 4000);
  const coordinator = new Coordinator(store, first.memory, [
    { adapter: a, executable: 'a' },
  ]);
  try {
    await coordinator.initialize(project, { continue: true });
    assert.equal(coordinator.snapshot.conversation!.id, 'a2');
  } finally {
    await coordinator.close();
  }
});

await test('a conversation id opens that conversation, even one with nothing sent', async () => {
  const { coordinator: first, store, root, project, a } = await fixture();
  await first.close();
  await used(store, root, record('fresh', project));
  const coordinator = new Coordinator(store, first.memory, [
    { adapter: a, executable: 'a' },
  ]);
  try {
    await coordinator.initialize(project, { conversation: 'fresh' });
    assert.equal(coordinator.snapshot.conversation!.id, 'fresh');
    assert.equal(coordinator.snapshot.phase, 'idle');
  } finally {
    await coordinator.close();
  }
});

await test('continue with nothing in this directory starts a new conversation here', async () => {
  const { coordinator: first, store, root, project, a } = await fixture();
  await first.close();
  const elsewhere = join(root, 'elsewhere');
  await mkdir(elsewhere);
  await used(store, root, record('b1', elsewhere), 1000);
  const coordinator = new Coordinator(store, first.memory, [
    { adapter: a, executable: 'a' },
  ]);
  try {
    await coordinator.initialize(project, { continue: true });
    assert.equal(coordinator.snapshot.phase, 'idle');
    assert.notEqual(coordinator.snapshot.conversation!.id, 'b1');
    assert.equal(coordinator.snapshot.conversation!.cwd, project);
  } finally {
    await coordinator.close();
  }
});

await test('a plain launch starts a new conversation even when this directory has one', async () => {
  const { coordinator: first, store, root, project, a } = await fixture();
  await first.close();
  await used(store, root, record('earlier', project), 1000);
  const coordinator = new Coordinator(store, first.memory, [
    { adapter: a, executable: 'a' },
  ]);
  try {
    await coordinator.initialize(project);
    assert.notEqual(coordinator.snapshot.conversation!.id, 'earlier');
  } finally {
    await coordinator.close();
  }
});

await test("/sessions lists only this directory's conversations", async () => {
  const { coordinator, store, root, project } = await fixture();
  try {
    const elsewhere = join(root, 'elsewhere');
    await mkdir(elsewhere);
    await used(store, root, record('here', project), 1000);
    await used(store, root, record('there', elsewhere), 1000);
    assert.deepEqual(
      (await coordinator.conversations()).map(({ id }) => id),
      ['here'],
    );
  } finally {
    await coordinator.close();
  }
});

await test('continue into a held conversation shows the lock error with the launch report', async () => {
  const context = await fixture();
  const { coordinator: first, store, root, project, a, memory } = context;
  await first.close();
  await used(store, root, record('held', project), 1000);
  const holder = await store.claim('held');
  const elsewhere = join(root, 'elsewhere');
  await mkdir(elsewhere);
  const dirty = await stranded(context, {}, elsewhere);
  dirty.files.record.activity = activity();
  await dirty.files.save(dirty.files.record);
  await dirty.files.close();
  await writeFile(join(dirty.memory.root, 'global', 'pending.md'), 'Pending.');
  const coordinator = new Coordinator(store, memory, [
    { adapter: a, executable: 'a' },
  ]);
  try {
    await assert.rejects(coordinator.initialize(project, { continue: true }));
    assert.equal(coordinator.snapshot.phase, 'error');
    assert.match(
      coordinator.snapshot.error ?? '',
      /open in another Witch instance/,
    );
    assert.doesNotMatch(coordinator.snapshot.error ?? '', /^Restart Witch/);
    assert.match(
      coordinator.snapshot.error ?? '',
      new RegExp(`Title ${dirty.id}`),
    );
  } finally {
    await holder.close();
    await coordinator.close();
  }
});

await test('a publish failure while settling the launch is added to its report', async () => {
  const context = await fixture();
  const { coordinator: first, store, root, memory, hook, a } = context;
  await first.close();
  const elsewhere = join(root, 'elsewhere');
  await mkdir(elsewhere);
  const dirty = await stranded(context, {}, elsewhere);
  dirty.files.record.activity = activity();
  await dirty.files.save(dirty.files.record);
  await dirty.files.close();
  await writeFile(join(dirty.memory.root, 'global', 'pending.md'), 'Pending.');
  const own = await stranded(context, { 'global/own.md': 'Own.' });
  await own.files.close();
  hook.current = async (command, run, options) => {
    if (command[0] !== 'update-ref' || options.cwd !== own.memory.root)
      return run();
    hook.current = passThrough;
    return { stdout: Buffer.alloc(0), stderr: 'cannot lock ref', code: 1 };
  };
  const coordinator = new Coordinator(store, memory, [
    { adapter: a, executable: 'a' },
  ]);
  try {
    await coordinator.initialize(context.project, { continue: true });
    assert.equal(coordinator.snapshot.conversation!.id, own.id);
    assert.match(
      coordinator.snapshot.error ?? '',
      new RegExp(`Title ${dirty.id}`),
    );
    assert.match(coordinator.snapshot.error ?? '', /cannot lock ref/);
  } finally {
    await coordinator.close();
  }
});

await test('opening a conversation connects its agent, at launch, on /new and from /sessions', async () => {
  const { coordinator, a, store, project } = await fixture();
  try {
    assert.equal(a.sessions.length, 1);
    await coordinator.newConversation();
    assert.equal(a.sessions.length, 2);
    const other = await store.create(record(randomUUID(), project));
    await other.close();
    await coordinator.selectConversation(other.record.id);
    assert.equal(a.sessions.length, 3);
  } finally {
    await coordinator.close();
  }
});

await test('a connect failure at launch joins the launch report and leaves the conversation open', async () => {
  const { launch, directory, a } = await sweepFixture();
  await mkdir(directory('broken'));
  await writeFile(join(directory('broken'), 'state.json'), '{"id":');
  a.failConnect = true;
  const coordinator = await launch();
  try {
    assert.equal(coordinator.snapshot.phase, 'idle');
    assert.ok(coordinator.snapshot.conversation);
    assert.match(
      coordinator.snapshot.error ?? '',
      /conversations\/broken\/state\.json[\s\S]*Destination unavailable/,
    );
  } finally {
    await coordinator.close();
  }
});

const chosen = (agent: string, model: string, effort?: string) => ({
  [agent]: {
    id: `${agent}-native`,
    model,
    requestedModel: model,
    hasHistory: true,
    ...(effort ? { effort } : {}),
  },
});

/** a second launch in a new directory, sharing the first one's state. */
async function relaunch(
  installed: string[],
  prepare?: (a: FixtureAgent) => void,
) {
  const context = await fixture();
  await context.coordinator.close();
  const a = new FixtureAgent('a');
  const b = new FixtureAgent('b');
  prepare?.(a);
  const launch = async (cwd: string) => {
    await mkdir(cwd, { recursive: true });
    const coordinator = new Coordinator(
      context.store,
      context.coordinator.memory,
      [a, b].map((adapter) => ({
        adapter,
        executable: installed.includes(adapter.id) ? adapter.id : undefined,
      })),
    );
    await coordinator.initialize(cwd);
    return coordinator;
  };
  return { ...context, a, b, launch };
}

await test('a launch takes the agent, model and effort of the newest used conversation in any directory', async () => {
  const { store, root, project, b, launch } = await relaunch(['a', 'b']);
  await used(
    store,
    root,
    { ...record('older', project), sessions: chosen('a', 'a-old') },
    1000,
  );
  await used(
    store,
    root,
    {
      ...record('newest', join(root, 'elsewhere'), 'b'),
      sessions: chosen('b', 'b-big', 'high'),
    },
    3000,
  );
  await used(store, root, {
    ...record('unused', project, 'a'),
    sessions: chosen('a', 'a-unused'),
  });
  const coordinator = await launch(join(root, 'third'));
  try {
    assert.equal(coordinator.snapshot.conversation!.agent, 'b');
    const { options } = b.sessions.at(-1)!;
    assert.deepEqual(
      [options.model, options.effort, options.resume],
      ['b-big', 'high', undefined],
    );
  } finally {
    await coordinator.close();
  }
});

await test('a launch whose newest agent is uninstalled starts the first installed one on its default', async () => {
  const { store, root, a, launch } = await relaunch(['a']);
  await used(
    store,
    root,
    { ...record('newest', root, 'b'), sessions: chosen('b', 'b-big') },
    3000,
  );
  const coordinator = await launch(join(root, 'next'));
  try {
    assert.equal(coordinator.snapshot.conversation!.agent, 'a');
    assert.equal(a.sessions.at(-1)!.options.model, undefined);
  } finally {
    await coordinator.close();
  }
});

await test('a failed first connect keeps the remembered model, and a model chosen next connects with it', async () => {
  const { store, root, a, launch } = await relaunch(['a', 'b'], (a) => {
    a.failConnect = true;
  });
  await used(
    store,
    root,
    { ...record('newest', root), sessions: chosen('a', 'a-big', 'high') },
    3000,
  );
  const coordinator = await launch(join(root, 'next'));
  try {
    assert.match(coordinator.snapshot.error ?? '', /Destination unavailable/);
    const id = coordinator.snapshot.conversation!.id;
    assert.equal(
      (await readRecord(root, id)).sessions.a?.requestedModel,
      'a-big',
    );
    a.failConnect = false;
    await coordinator.selectModel({ agent: 'a', id: 'a-new' });
    const { options } = a.sessions.at(-1)!;
    assert.deepEqual([options.model, options.effort], ['a-new', 'high']);
  } finally {
    await coordinator.close();
  }
});

await test('/new copies this conversation for its own agent, starts another agent on its default, and refuses an uninstalled one', async () => {
  const { coordinator, a, b, store, project } = await fixture();
  try {
    const source = await store.create({
      ...record(randomUUID(), project),
      sessions: { ...chosen('a', 'a-big', 'high'), ...chosen('b', 'b-big') },
    });
    await source.close();
    await coordinator.selectConversation(source.record.id);
    await coordinator.newConversation('b');
    assert.equal(b.sessions.at(-1)!.options.model, undefined);
    const started = b.sessions.length;
    await coordinator.newConversation();
    assert.equal(coordinator.snapshot.conversation!.agent, 'b');
    assert.equal(b.sessions.length, started + 1);
    assert.equal(b.sessions.at(-1)!.options.model, undefined);
    await coordinator.selectConversation(source.record.id);
    const opened = a.sessions.at(-1)!.session.info.id;
    await coordinator.newConversation();
    const { options, session } = a.sessions.at(-1)!;
    assert.deepEqual(
      [options.model, options.effort, options.resume],
      ['a-big', 'high', undefined],
    );
    assert.notEqual(session.info.id, opened);
    const current = coordinator.snapshot.conversation!.id;
    await assert.rejects(
      coordinator.newConversation('c'),
      /c is not installed/,
    );
    assert.equal(coordinator.snapshot.conversation!.id, current);
  } finally {
    await coordinator.close();
  }
});
