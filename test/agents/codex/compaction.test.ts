import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import type { AgentEvent } from '../../../src/agents/types.js';
import type { RpcMessage } from '../../../src/agents/codex/json-rpc.js';
import { close, fixture, frameWriter } from '../../fixtures/codex-adapter.js';
import { settled, until, within } from '../../fixtures/within.js';

async function scripted() {
  const events: AgentEvent[] = [];
  const f = await fixture((e) => events.push(e), { mode: 'compaction' });

  const emit = frameWriter(f.cwd, (text) =>
    events.some((e) => e.type === 'notice' && e.text === text),
  );

  const compact = async () => {
    const result = f.session.compact();
    const isSettled = settled(result);

    await until('compact request', async () =>
      readFile(join(f.cwd, 'compact.json'), 'utf8').then(
        (s) => {
          assert.deepEqual(JSON.parse(s), { threadId: 'native-thread' });

          return true;
        },
        () => false,
      ),
    );

    await emit();

    return { result, settled: isSettled };
  };

  return { ...f, events, emit, compact };
}

const turn = (
  method: string,
  id: string,
  status = 'completed',
): RpcMessage => ({
  method,
  params: { threadId: 'native-thread', turn: { id, status, error: null } },
});

const item = (
  method: string,
  id: string,
  turnId = 'compact-1',
  threadId = 'native-thread',
): RpcMessage => ({
  method,
  params: { threadId, turnId, item: { id, type: 'contextCompaction' } },
});

test('Codex compaction waits for its matching item and turn after acknowledgement', async () => {
  const f = await scripted();

  try {
    const pending = await f.compact();
    assert.equal(pending.settled(), false);

    await f.emit(
      turn('turn/started', 'compact-1', 'inProgress'),
      item('item/started', 'summary'),
    );

    assert.equal(await f.session.steer('must wait'), false);

    await f.emit(
      item('item/completed', 'foreign', 'child-turn', 'child-thread'),
      turn('turn/completed', 'earlier-turn'),
    );

    assert.equal(pending.settled(), false);
    assert.equal(f.events.filter((e) => e.type === 'compacted').length, 0);
    await f.emit(item('item/completed', 'summary'));
    assert.equal(pending.settled(), false);
    await f.emit(turn('turn/completed', 'compact-1'));

    assert.deepEqual(await within(pending.result, 2000, 'compaction'), {
      status: 'completed',
      text: '',
    });

    assert.equal(f.events.filter((e) => e.type === 'compacted').length, 1);
    assert.equal(f.events.filter((e) => e.type === 'tool').length, 0);

    assert.deepEqual(
      f.events.filter((e) => e.type === 'compacting').map((e) => e.compacting),
      [true, false],
    );
  } finally {
    await writeFile(join(f.cwd, 'exit'), '');
    await close(f.session, f.cwd);
  }
});

test('Codex does not accept another compaction item as its own completion', async () => {
  const f = await scripted();

  try {
    const pending = await f.compact();

    await f.emit(
      turn('turn/started', 'compact-1', 'inProgress'),
      item('item/started', 'expected'),
      item('item/completed', 'other'),
      turn('turn/completed', 'compact-1'),
    );

    assert.equal((await pending.result).status, 'failed');
  } finally {
    await writeFile(join(f.cwd, 'exit'), '');
    await close(f.session, f.cwd);
  }
});

test('Codex compaction that runs out of usage reports exhaustion', async () => {
  const f = await scripted();

  try {
    const pending = await f.compact();

    const error = {
      message: 'Error running remote compact task: usage limit reached',
      codexErrorInfo: 'usageLimitExceeded',
    };

    await f.emit(turn('turn/started', 'compact-1', 'inProgress'), {
      method: 'turn/completed',
      params: {
        threadId: 'native-thread',
        turn: { id: 'compact-1', status: 'failed', error },
      },
    });

    assert.deepEqual(await within(pending.result, 2000, 'compaction'), {
      status: 'failed',
      text: '',
      error: error.message,
      exhausted: true,
    });
  } finally {
    await writeFile(join(f.cwd, 'exit'), '');
    await close(f.session, f.cwd);
  }
});

test('Codex replacement is reported even when a later hook interrupts the compact turn', async () => {
  const f = await scripted();

  try {
    const pending = await f.compact();

    await f.emit(
      turn('turn/started', 'compact-1', 'inProgress'),
      item('item/started', 'summary'),
      item('item/completed', 'summary'),
      turn('turn/completed', 'compact-1', 'interrupted'),
    );

    assert.equal((await pending.result).status, 'interrupted');
    assert.equal(f.events.filter((e) => e.type === 'compacted').length, 1);
  } finally {
    await writeFile(join(f.cwd, 'exit'), '');
    await close(f.session, f.cwd);
  }
});

test('Codex reports automatic replacement and drops context sampled for another model', async () => {
  const f = await scripted();

  try {
    await f.emit(item('item/completed', 'auto', 'ordinary-turn'), {
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'native-thread',
        tokenUsage: {
          last: { totalTokens: 80 },
          total: { totalTokens: 80 },
          modelContextWindow: 100,
        },
      },
    });

    assert.equal(f.events.filter((e) => e.type === 'compacted').length, 1);
    assert.equal(await f.session.contextUsage(), 80);
    await f.session.selectModel('model-b');
    assert.equal(await f.session.contextUsage(), undefined);
    assert.equal(f.session.usage.contextWindow, undefined);
  } finally {
    await writeFile(join(f.cwd, 'exit'), '');
    await close(f.session, f.cwd);
  }
});

test('Codex process closure settles a compact request that never started', async () => {
  const f = await scripted();
  const pending = await f.compact();
  await writeFile(join(f.cwd, 'exit'), '');

  assert.equal(
    (await within(pending.result, 2000, 'closed compaction')).status,
    'failed',
  );

  await close(f.session, f.cwd);
});

test('Codex automatic compaction ignores other threads, items and turns when clearing its activity', async () => {
  const f = await scripted();

  try {
    await f.emit(item('item/started', 'child', 'child-turn', 'child-thread'));
    assert.ok(!f.events.some((e) => e.type === 'compacting'));
    await f.emit(item('item/started', 'auto', 'ordinary-turn'));

    for (const other of [
      item('item/completed', 'auto', 'ordinary-turn', 'child-thread'),
      item('item/completed', 'other', 'ordinary-turn'),
      item('item/completed', 'auto', 'other-turn'),
      turn('turn/completed', 'other-turn'),
    ]) {
      await f.emit(other);

      assert.deepEqual(
        f.events
          .filter((e) => e.type === 'compacting')
          .map((e) => e.compacting),
        [true],
      );
    }

    await f.emit(item('item/completed', 'auto', 'ordinary-turn'));

    assert.deepEqual(
      f.events.filter((e) => e.type === 'compacting').map((e) => e.compacting),
      [true, false],
    );

    assert.equal(f.events.filter((e) => e.type === 'tool').length, 0);
  } finally {
    await writeFile(join(f.cwd, 'exit'), '');
    await close(f.session, f.cwd);
  }
});

for (const status of ['completed', 'interrupted', 'failed']) {
  test(`Codex clears automatic compaction when its turn ${status} without a completion item`, async () => {
    const f = await scripted();

    try {
      await f.emit(
        item('item/started', 'auto', 'ordinary-turn'),
        turn('turn/completed', 'ordinary-turn', status),
      );

      assert.deepEqual(
        f.events
          .filter((e) => e.type === 'compacting')
          .map((e) => e.compacting),
        [true, false],
      );

      assert.ok(!f.events.some((e) => e.type === 'compacted'));
    } finally {
      await writeFile(join(f.cwd, 'exit'), '');
      await close(f.session, f.cwd);
    }
  });
}

test('Codex clears automatic compaction when its process closes without a turn end', async () => {
  const f = await scripted();

  try {
    await f.emit(item('item/started', 'auto', 'ordinary-turn'));
    await writeFile(join(f.cwd, 'exit'), '');
    await until('native process closed', () => f.session.closed);

    assert.deepEqual(
      f.events.filter((e) => e.type === 'compacting').map((e) => e.compacting),
      [true, false],
    );

    assert.ok(!f.events.some((e) => e.type === 'compacted'));
  } finally {
    await close(f.session, f.cwd);
  }
});
