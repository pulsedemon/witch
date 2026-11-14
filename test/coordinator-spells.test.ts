import assert from 'node:assert/strict';

import { setTimeout as delay } from 'node:timers/promises';

import { test } from 'vitest';

import type { Subagent } from '../src/agents/types.js';

import type { Coordinator } from '../src/core/coordinator.js';

import { unitFixture } from './fixtures/coordinator.js';

const tdd = { id: 's1', name: 'tdd' };

const review = { id: 's2', name: 'review' };

const casts = (coordinator: Coordinator) =>
  coordinator.snapshot.items.filter((item) => item.cast);

/** closes the session and selects another model, so the next events come from a new connection. */
async function reconnect(f: Awaited<ReturnType<typeof unitFixture>>) {
  const sessions = f.a.sessions.length;

  await f.a.sessions.at(-1)!.session.close();

  await f.coordinator.selectModel({ agent: 'a', id: 'a-big' });

  assert.equal(f.a.sessions.length, sessions + 1);

  return f.a.sessions.at(-1)!.options.onEvent;
}

test('a spell event shows one cast row, which reopening keeps', async () => {
  const { coordinator, a, project, reopen } = await unitFixture();

  let reopened: Coordinator | undefined;

  try {
    a.sessions[0]!.options.onEvent({ type: 'spell', cast: tdd });

    const rows = casts(coordinator);

    assert.deepEqual(
      rows.map(({ id, kind, cast, text, cwd }) => ({
        id,
        kind,
        cast,
        text,
        cwd,
      })),
      [
        {
          id: 'spell/s1',
          kind: 'notice',
          cast: true,
          text: 'Cast `tdd`',
          cwd: project,
        },
      ],
    );

    assert.ok(rows[0]!.at);

    await coordinator.close();

    reopened = await reopen();

    assert.deepEqual(casts(reopened), rows);
  } finally {
    await coordinator.close();

    await reopened?.close();
  }
});

test('a repeated cast keeps its one row and first time, before and after a reconnect', async () => {
  const f = await unitFixture();

  try {
    const emit = f.a.sessions[0]!.options.onEvent;

    emit({ type: 'spell', cast: tdd });

    const [row] = casts(f.coordinator);

    await delay(5);

    emit({ type: 'spell', cast: tdd });

    assert.deepEqual(casts(f.coordinator), [row]);

    (await reconnect(f))({ type: 'spell', cast: tdd });

    assert.deepEqual(casts(f.coordinator), [row]);
  } finally {
    await f.coordinator.close();
  }
});

test("a familiar's cumulative spells give one row per cast, which its replayed report after a reconnect does not repeat", async () => {
  const f = await unitFixture();

  try {
    const reader: Subagent = {
      id: 'reader',
      name: 'Reader',
      kind: '',
      runtime: 'claude',
      status: 'running',
    };

    const emit = f.a.sessions[0]!.options.onEvent;

    for (const spells of [undefined, [tdd], [tdd], [tdd, review]])
      emit({
        type: 'subagent',
        subagent: { ...reader, ...(spells ? { spells } : {}) },
      });

    const rows = casts(f.coordinator);

    assert.deepEqual(
      rows.map(({ text }) => text),
      ['Familiar Reader cast `tdd`', 'Familiar Reader cast `review`'],
    );

    (await reconnect(f))({
      type: 'subagent',
      subagent: { ...reader, id: 'reader-again', spells: [tdd, review] },
    });

    assert.deepEqual(casts(f.coordinator), rows);
  } finally {
    await f.coordinator.close();
  }
});
