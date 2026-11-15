import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import type { AgentSession } from '../../../src/agents/types.js';
import type { Coordinator } from '../../../src/core/coordinator.js';
import {
  fixture,
  unitFixture,
  readRecord,
} from '../../fixtures/coordinator.js';
import { holdConnect, TurnGate } from '../../fixtures/agent.js';
import { until, within } from '../../fixtures/within.js';

test('clear starts a new native session while retaining the conversation, settings, transcript and memory workspace', async () => {
  const f = await fixture();
  const c = f.coordinator;

  try {
    await c.send('remember-port');
    await c.selectModel({ agent: 'a', id: 'a-big', effort: 'high' });
    const before = structuredClone(c.snapshot);
    const old = f.a.sessions.at(-1)!;
    const workspace = f.workspace();

    const branch = await f.memory.git(workspace.root, [
      'branch',
      '--show-current',
    ]);

    const revision = await f.memory.resolve('main');
    await c.clear();
    const native = f.a.sessions.at(-1)!;
    const record = await readRecord(f.root, before.conversation!.id);
    assert.equal(old.session.closed, true);
    assert.notEqual(native.session.info.id, old.session.info.id);
    assert.equal(native.options.resume, undefined);
    assert.equal(native.session.info.model, 'a-big');
    assert.equal(native.session.info.effort, 'high');
    assert.equal(c.snapshot.conversation!.id, before.conversation!.id);
    assert.equal(c.snapshot.conversation!.title, before.conversation!.title);
    assert.equal(c.snapshot.conversation!.cwd, before.conversation!.cwd);
    assert.equal(c.snapshot.openedAt, before.openedAt);
    assert.equal(c.snapshot.completedTurn, undefined);

    assert.deepEqual(
      c.snapshot.items.slice(0, before.items.length),
      before.items,
    );

    assert.equal(c.snapshot.items.at(-1)!.contextCleared, true);
    assert.equal(f.workspace().root, workspace.root);

    assert.equal(
      await f.memory.git(workspace.root, ['branch', '--show-current']),
      branch,
    );

    assert.equal(await f.memory.resolve('main'), revision);

    assert.deepEqual(
      native.options.memoryDirectories,
      old.options.memoryDirectories,
    );

    assert.equal(record.sessions.a!.deliveredRevision, undefined);
    assert.equal(record.sessions.a!.deliveredInstructionsRevision, undefined);
    assert.equal(record.sessions.a!.deliveredMerges, undefined);
    await c.send('first fresh turn');
    assert.equal(f.a.inputs.at(-1)!.session, native.session.info.id);
    assert.match(f.a.inputs.at(-1)!.context!, /Use port 4567/);
    assert.match(f.a.inputs.at(-1)!.context!, /You are running inside Witch/);
    await c.send('second fresh turn');
    assert.equal(f.a.inputs.at(-1)!.context, undefined);
  } finally {
    await c.close();
  }
});

test('clear reapplies reported default model and effort before the next turn', async () => {
  const f = await unitFixture(undefined, (a) => {
    const connect = a.connect.bind(a);

    a.connect = async (options) => {
      const session = await connect(options);

      let info = {
        ...session.info,
        model: options.model ?? 'a-big',
        nativeEffort: a.sessions.length === 1 ? 'high' : 'low',
      };

      Object.defineProperty(session, 'info', { get: () => info });
      const select = session.selectModel;

      session.selectModel = async (model, effort) => {
        await select(model, effort);
        info = { ...info, model, nativeEffort: effort ?? info.nativeEffort };
        options.onEvent({ type: 'info', info });
      };

      options.onEvent({ type: 'info', info });

      return session;
    };
  });

  try {
    assert.equal(f.coordinator.snapshot.native!.nativeEffort, 'high');
    await f.coordinator.clear();
    assert.equal(f.coordinator.snapshot.native!.model, 'a-big');
    assert.equal(f.coordinator.snapshot.native!.nativeEffort, 'high');
    assert.equal(f.a.inputs.length, 0);
  } finally {
    await f.coordinator.close();
  }
});

test("clear preserves the resolved model, even one the agent wouldn't offer, without replacing its saved alias", async () => {
  const f = await unitFixture();

  try {
    await f.coordinator.selectModel({
      agent: 'a',
      id: 'a-alias',
      effort: 'high',
    });

    const native = f.a.sessions.at(-1)!;
    const resolved = { ...native.session.info, model: 'a-big' };
    Object.defineProperty(native.session, 'info', { get: () => resolved });
    native.options.onEvent({ type: 'info', info: resolved });
    // as a Codex reroute reports a model its catalog lacks
    f.a.invalidModel = 'a-big';
    await f.coordinator.clear();
    assert.equal(f.coordinator.snapshot.native!.model, 'a-big');

    const saved = await readRecord(
      f.root,
      f.coordinator.snapshot.conversation!.id,
    );

    assert.equal(saved.sessions.a!.requestedModel, 'a-alias');
    assert.equal(f.a.sessions.at(-1)!.options.model, 'a-alias');
  } finally {
    await f.coordinator.close();
  }
});

test('clear survives reopening and discards both runtime histories and unfinished handoff state', async () => {
  const f = await unitFixture();
  let c = f.coordinator;

  try {
    await c.send('old a history');
    await c.selectModel({ agent: 'b', id: 'b-big', effort: 'high' });
    await c.send('old b history');
    await c.selectModel({ agent: 'a', id: 'a-big', effort: 'high' });
    const id = c.snapshot.conversation!.id;
    await c.close();
    const stored = await readRecord(f.root, id);
    stored.lastTurn = { id: 'failed-before-clear', status: 'failed' };

    stored.handoff = {
      from: 'b',
      to: 'a',
      activated: true,
      summary: 'discard this pending summary',
    };

    await writeFile(
      join(f.root, 'state', 'conversations', id, 'state.json'),
      JSON.stringify(stored),
    );

    c = await f.reopen();
    await c.clear();
    const cleared = await readRecord(f.root, id);
    assert.equal(cleared.sessions.b, undefined);
    assert.equal(cleared.handoff, undefined);
    assert.equal(cleared.lastTurn, undefined);
    const items = c.snapshot.items;
    await c.close();
    c = await f.reopen();
    assert.deepEqual(c.snapshot.items, items);
    const counts = [f.a.inputs.length, f.b.inputs.length];
    await c.selectModel({ agent: 'b', id: 'b-model' });
    assert.deepEqual([f.a.inputs.length, f.b.inputs.length], counts);
    assert.equal(f.b.sessions.at(-1)!.options.resume, undefined);
    assert.notEqual(c.snapshot.native!.id, stored.sessions.b!.id);
    await c.send('new b history');

    assert.doesNotMatch(
      f.b.inputs.at(-1)!.context!,
      /discard this pending summary/,
    );

    const newSession = c.snapshot.native!.id;
    await c.selectModel({ agent: 'a', id: 'a-model' });
    assert.match(f.b.inputs.at(-1)!.prompt, /handoff summary/);
    assert.equal(f.b.inputs.at(-1)!.session, newSession);
    assert.equal(f.a.inputs.length, counts[0]);
  } finally {
    await c.close();
  }
});

async function recoverOutput(
  c: Coordinator,
  session: AgentSession,
  output: string,
) {
  const send = session.send;

  session.send = async () => ({
    status: 'interrupted',
    text: '',
    unreadContext: [output],
  });

  try {
    await c.send('recover command output');
  } finally {
    session.send = send;
  }
}

test('clear drops recovered and close-time output only for its own conversation', async () => {
  const f = await unitFixture();
  const c = f.coordinator;

  try {
    const original = c.snapshot.conversation!.id;

    await recoverOutput(
      c,
      f.a.sessions.at(-1)!.session,
      'original-recovered-output',
    );

    await c.newConversation();
    const other = c.snapshot.conversation!.id;

    await recoverOutput(
      c,
      f.a.sessions.at(-1)!.session,
      'other-recovered-output',
    );

    await c.selectConversation(original);

    f.a.sessions.at(-1)!.session.takeUnreadContext = () => [
      'original-close-output',
    ];

    await c.clear();
    await c.send('fresh original');

    assert.doesNotMatch(
      f.a.inputs.at(-1)!.context!,
      /original-recovered-output|original-close-output|other-recovered-output/,
    );

    await c.selectConversation(other);
    await c.send('other continues');
    assert.match(f.a.inputs.at(-1)!.context!, /other-recovered-output/);
  } finally {
    await c.close();
  }
});

for (const replied of [false, true]) {
  test(`clear refuses a ${replied ? 'replied held' : 'running'} turn without changing sessions`, async () => {
    const f = await unitFixture();
    const gate = new TurnGate();
    let sending: Promise<void> | undefined;

    try {
      f.a.gate = gate;
      f.a.replied = replied;
      sending = f.coordinator.send('held');
      await within(gate.entered, 3000, 'the held turn');
      const id = f.coordinator.snapshot.native!.id;

      await assert.rejects(
        f.coordinator.clear(),
        replied ? /running familiars/ : /Stop the current operation/,
      );

      assert.equal(f.coordinator.snapshot.native!.id, id);

      assert.equal(
        f.coordinator.snapshot.items.some((i) => i.contextCleared),
        false,
      );

      assert.equal(f.a.sessions.length, 1);
    } finally {
      gate.open();
      await sending;
      await f.coordinator.close();
    }
  });
}

test('clear refuses pending memory recovery without dropping its queued input', async () => {
  const f = await fixture();

  try {
    f.a.interruptNext = true;
    await f.coordinator.send('remember-port');
    assert.equal(f.coordinator.snapshot.phase, 'recovery');
    await assert.rejects(f.coordinator.clear(), /Resolve pending memory/);
    await f.coordinator.send('retained input');
    await assert.rejects(f.coordinator.clear(), /Resolve pending memory/);
    assert.deepEqual(f.coordinator.snapshot.queue, ['retained input']);

    assert.equal(
      f.coordinator.snapshot.items.some((i) => i.contextCleared),
      false,
    );
  } finally {
    await f.coordinator.close();
  }
});

test('clear refuses already queued input after a failed turn', async () => {
  const f = await unitFixture();
  const gate = new TurnGate();
  let sending: Promise<void> | undefined;

  try {
    f.a.gate = gate;
    f.a.failNext = true;
    f.a.refuseSteer = true;
    sending = f.coordinator.send('fail');
    await within(gate.entered, 3000, 'the failing turn');
    await f.coordinator.send('retained input');
    gate.open();
    await sending;
    assert.equal(f.coordinator.snapshot.phase, 'idle');
    await assert.rejects(f.coordinator.clear(), /Prompts are still queued/);
    assert.deepEqual(f.coordinator.snapshot.queue, ['retained input']);

    assert.equal(
      f.coordinator.snapshot.items.some((i) => i.contextCleared),
      false,
    );
  } finally {
    gate.open();
    await sending;
    await f.coordinator.close();
  }
});

test('input sent during a clear reconnect runs once in the new session', async () => {
  const f = await unitFixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let clearing: Promise<void> | undefined;

  try {
    const previous = f.coordinator.snapshot.native!.id;
    f.a.beforeConnect = holdConnect(entered, release);
    clearing = f.coordinator.clear();
    await within(entered.promise, 3000, 'the clear reconnect');
    await f.coordinator.send('during reconnect');
    assert.equal(f.a.inputs.length, 0);
    release.resolve();
    await clearing;

    await until(
      'the queued turn to finish',
      () => f.coordinator.snapshot.phase === 'idle' && f.a.inputs.length === 1,
    );

    assert.equal(f.a.inputs[0]!.prompt, 'during reconnect');
    assert.notEqual(f.a.inputs[0]!.session, previous);
    assert.deepEqual(f.coordinator.snapshot.queue, []);
  } finally {
    release.resolve();
    await clearing;
    await f.coordinator.close();
  }
});

for (const stage of ['close', 'connect'] as const) {
  test(`a clear ${stage} failure ${stage === 'close' ? 'keeps the old context' : 'cannot restore the old context'}`, async () => {
    const f = await unitFixture();
    const c = f.coordinator;

    try {
      await c.send('old history');
      const old = c.snapshot.native!.id;
      const id = c.snapshot.conversation!.id;

      f.a.sessions.at(-1)!.session.takeUnreadContext = () => [
        'close-time-output',
      ];

      f.a.failClose = stage === 'close';
      f.a.failConnect = stage === 'connect';

      await assert.rejects(
        c.clear(),
        stage === 'close' ? /Close failed/ : /Destination unavailable/,
      );

      const saved = await readRecord(f.root, id);
      assert.equal(saved.sessions.a!.id, stage === 'close' ? old : '');

      assert.equal(
        c.snapshot.items.some((i) => i.contextCleared),
        stage === 'connect',
      );

      f.a.failClose = false;
      f.a.failConnect = false;
      await c.send('retry');

      assert.equal(
        f.a.sessions.at(-1)!.options.resume,
        stage === 'close' ? old : undefined,
      );

      assert.equal(
        f.a.inputs.at(-1)!.context?.includes('close-time-output') ?? false,
        stage === 'close',
      );
    } finally {
      f.a.failClose = false;
      f.a.failConnect = false;
      await c.close();
    }
  });
}
