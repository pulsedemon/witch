import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'vitest';
import type { RpcMessage } from '../src/agents/json-rpc.js';
import {
  controlledFixture,
  close,
  commandFrame,
  turnFrame,
} from './fixtures/codex-adapter.js';
import { appears, settled, within } from './fixtures/within.js';

test('child model observations survive delayed reads and restarts', async () => {
  const f = await controlledFixture('identity');

  const current = () =>
    f.events
      .flatMap((event) =>
        event.type === 'subagent' && event.subagent.id === 'child'
          ? [event.subagent]
          : [],
      )
      .at(-1)!;

  const start = (id: string) => turnFrame(id, 'inProgress', 'child');

  const settings = (model: string): RpcMessage => ({
    method: 'thread/settings/updated',
    params: { threadId: 'child', threadSettings: { model } },
  });

  const reroute = (turnId: string, toModel: string): RpcMessage => ({
    method: 'model/rerouted',
    params: { threadId: 'child', turnId, toModel },
  });

  const metadata = (model: string | null) => ({
    result: {
      thread: {
        parentThreadId: 'native-thread',
        agentRole: 'explorer',
        model,
        source: {
          subAgent: { thread_spawn: { agent_path: '/root/inspect_source' } },
        },
      },
    },
  });

  try {
    await f.emit(start('one'));

    assert.equal(current().runtime, 'codex');

    assert.equal(current().model, undefined);

    await f.emit(
      commandFrame('read-a', 'one', 'child'),
      commandFrame('read-b', 'one', 'child'),
      reroute('one', 'child-rerouted'),
      {
        method: 'item/completed',
        params: {
          threadId: 'child',
          turnId: 'one',
          item: { type: 'agentMessage', id: 'report', text: 'Child complete.' },
        },
      },
      turnFrame('one', 'completed', 'child'),
    );

    await f.reply(1, metadata('child-configured'), 'read');

    assert.deepEqual(current(), {
      id: 'child',
      name: 'inspect source',
      parent: undefined,
      kind: 'explorer',
      runtime: 'codex',
      model: 'child-rerouted',
      status: 'completed',
      run: 'one',
      activity: 'provisional read-b',
      tools: 2,
      report: 'Child complete.',
    });

    assert.equal(f.session.info.model, 'model-a');

    await f.emit(start('two'), settings('child-next'), reroute('one', 'stale'));

    await f.reply(2, metadata('stale-read'), 'read');

    assert.equal(current().model, 'child-next');

    assert.equal(current().tools, undefined);

    assert.equal(current().report, undefined);

    await f.emit(reroute('two', 'second-reroute'), settings('third-model'));

    assert.equal(current().model, 'second-reroute');

    await f.emit(start('three'));

    assert.equal(current().model, 'third-model');

    const refreshed = f.events.filter(
      (event) => event.type === 'subagent',
    ).length;

    await f.reply(3, metadata('third-model'), 'read');

    assert.equal(
      f.events.filter((event) => event.type === 'subagent').length,
      refreshed,
    );

    await f.emit(start('four'), start('five'));

    await f.reply(5, metadata('fifth-model'), 'read');

    await f.reply(4, metadata('old-run'), 'read');

    assert.equal(current().model, 'fifth-model');

    await f.emit(start('six'));

    await f.reply(6, metadata(null), 'read');

    assert.equal(current().name, 'inspect source');

    assert.equal(current().model, 'fifth-model');

    await f.emit(start('seven'));

    const count = f.events.filter((event) => event.type === 'subagent').length;

    await f.session.close();

    assert.equal(
      f.events.filter((event) => event.type === 'subagent').length,
      count,
    );
  } finally {
    await close(f.session, f.cwd);
  }
});

test('child settings cannot settle parent settings', async () => {
  const f = await controlledFixture('identity');

  try {
    await f.emit(turnFrame('child-run', 'inProgress', 'child'));

    const selection = f.session.selectModel('parent-next');
    const done = settled(selection);

    await appears(join(f.cwd, 'settings.json'));

    await f.emit(
      {
        method: 'thread/settings/updated',
        params: { threadId: 'child', threadSettings: { model: null } },
      },
      {
        method: 'thread/settings/updated',
        params: { threadId: 'child', threadSettings: { model: 'child-next' } },
      },
    );

    assert.equal(done(), false);

    assert.equal(f.session.info.model, 'model-a');

    assert.ok(
      f.events.some(
        (event) =>
          event.type === 'notice' &&
          event.text.startsWith(
            "Witch could not read Codex's thread/settings/updated",
          ),
      ),
    );

    await f.emit({
      method: 'thread/settings/updated',
      params: {
        threadId: 'native-thread',
        threadSettings: { model: 'parent-next' },
      },
    });

    await within(selection, 2000, 'parent model change');

    assert.equal(f.session.info.model, 'parent-next');
  } finally {
    await close(f.session, f.cwd);
  }
});
