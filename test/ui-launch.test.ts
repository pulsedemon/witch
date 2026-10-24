import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import { join } from 'node:path';
import { Coordinator } from '../src/core/coordinator.js';
import type { Snapshot } from '../src/core/coordinator.js';
import { App } from '../src/ui/app.js';
import { show, fake } from './fixtures/ui.js';
import { until } from './fixtures/within.js';
import { fixture, record } from './fixtures/coordinator.js';

await test('startup reports missing conversation directories without blocking the initial prompt', async () => {
  const f = await fixture();
  await f.coordinator.close();
  const missing = join(f.root, 'missing checkout');
  for (const id of ['old-one', 'old-two'])
    await (await f.store.create(record(id, missing))).close();
  const coordinator = new Coordinator(f.store, f.memory, [
    { adapter: f.a, executable: 'a' },
  ]);
  const ui = show(
    createElement(App, {
      coordinator,
      store: f.store,
      initialPrompt: 'start once',
      onExit: () => {},
    }),
  );
  try {
    await coordinator.initialize(f.project);
    await until(
      'the completed initial prompt',
      () => f.a.inputs.length === 1 && coordinator.snapshot.phase === 'idle',
    );
    const notices = coordinator.snapshot.items.filter(
      (item) =>
        item.kind === 'notice' && item.text.includes('--recover-directory'),
    );
    assert.equal(notices.length, 1);
    assert.ok(notices[0]!.text.includes(missing));
    assert.match(notices[0]!.text, /2 conversation\(s\)/);
    assert.ok(!notices[0]!.text.includes(f.project));
    assert.equal(coordinator.snapshot.error, undefined);
    assert.equal(
      f.a.inputs.filter(({ prompt }) => prompt.endsWith('start once')).length,
      1,
    );
    ui.stdin.write('still typing');
    await until('the usable composer', () =>
      ui.text().includes('still typing'),
    );
    assert.equal(f.a.inputs.length, 1);
  } finally {
    ui.unmount();
    await coordinator.close();
  }
});

for (const cleanup of [false, true]) {
  await test(`an initial prompt is sent once when ${cleanup ? 'merge cleanup' : 'the load'} ends idle with nothing reported`, async () => {
    const { app, coordinator, calls } = fake({ phase: 'starting' });
    const ui = show(
      createElement(App, {
        coordinator: app,
        onExit: () => {},
        initialPrompt: 'say hello',
      }),
    );
    try {
      await delay(60);
      if (cleanup) {
        coordinator.publish({ phase: 'cleaning' });
        await until('cleanup', () => ui.text().startsWith('CLEANING'));
        await delay(60);
        assert.deepEqual(calls, []);
        assert.ok(!ui.text().includes('say hello'));
      }
      coordinator.publish({ phase: 'idle' });
      await until('the send', () => calls.some(([name]) => name === 'send'));
      assert.ok(ui.text().includes('Ask the agent, or type /help'));
      assert.ok(!ui.text().includes('say hello'));
      coordinator.publish({ phase: 'running' });
      await delay(60);
      coordinator.publish({ phase: 'idle' });
      await delay(60);
      assert.deepEqual(
        calls.filter(([name]) => name === 'send'),
        [['send', 'say hello']],
      );
    } finally {
      ui.unmount();
    }
  });
}

await test('a prompt sent while the load connects goes after the initial prompt, which stays out of the draft', async () => {
  const { app, coordinator, calls } = fake({ phase: 'starting' });
  const ui = show(
    createElement(App, {
      coordinator: app,
      onExit: () => {},
      initialPrompt: 'say hello',
    }),
  );
  try {
    await delay(60);
    ui.stdin.write('and then this');
    await delay(30);
    ui.stdin.write('\r');
    await until('the sends', () => calls.length > 1);
    coordinator.publish({ phase: 'running' });
    await delay(60);
    assert.deepEqual(calls, [
      ['send', 'say hello'],
      ['send', 'and then this'],
    ]);
    assert.ok(!ui.text().includes('say hello'));
  } finally {
    ui.unmount();
  }
});

for (const [name, update, focusTools] of [
  [
    'recovery',
    {
      phase: 'recovery',
      recovery: { kind: 'pending', paths: [], diff: 'x', root: '/m' },
    },
    false,
  ],
  [
    'a launch report',
    { phase: 'idle', error: 'These conversations need attention.' },
    false,
  ],
  [
    'a failed open',
    { phase: 'error', error: 'Open failed.', conversation: undefined },
    false,
  ],
  ['a load that ends with tools focused', { phase: 'idle' }, true],
] as const) {
  await test(`an initial prompt stays in the composer after ${name}`, async () => {
    const { app, coordinator, calls } = fake({ phase: 'starting' });
    const ui = show(
      createElement(App, {
        coordinator: app,
        onExit: () => {},
        initialPrompt: 'say hello',
      }),
    );
    try {
      await delay(60);
      if (focusTools) {
        ui.stdin.write('\t');
        await until('tool focus', () => ui.text().includes('ESC LEAVE TOOLS'));
      }
      coordinator.publish(update as Partial<Snapshot>);
      if (update.phase === 'recovery') {
        await delay(60);
        coordinator.publish({ phase: 'idle', recovery: undefined });
      }
      await until('the seeded composer', () =>
        ui.text().includes('┃ say hello'),
      );
      await delay(60);
      assert.deepEqual(
        calls.filter(([call]) => call === 'send'),
        [],
      );
    } finally {
      ui.unmount();
    }
  });
}

await test('an initial prompt that comes back to the composer goes ahead of a draft typed while connecting', async () => {
  const { app, coordinator } = fake({ phase: 'starting' });
  const ui = show(
    createElement(App, {
      coordinator: app,
      onExit: () => {},
      initialPrompt: 'say hello',
    }),
  );
  try {
    await delay(60);
    ui.stdin.write('typed');
    await until('the draft', () => ui.text().includes('┃ typed'));
    coordinator.publish({
      phase: 'idle',
      error: 'These conversations need attention.',
    });
    await until('the seeded composer', () => ui.text().includes('┃ say hello'));
    const text = ui.text();
    assert.ok(text.indexOf('┃ say hello') < text.indexOf('┃ typed'));
  } finally {
    ui.unmount();
  }
});

await test('queued prompts left at idle or in an error come back ahead of the draft, also while a view covers the composer', async () => {
  for (const [phase, covered] of [
    ['idle', false],
    ['idle', true],
    ['error', false],
  ] as const) {
    const { app, coordinator, calls } = fake({ phase: 'running' });
    const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
    try {
      await delay(60);
      ui.stdin.write('newer');
      await until('the draft', () => ui.text().includes('┃ newer'));
      if (covered) {
        ui.stdin.write('\u0010');
        await until('the picker', () => ui.text().includes('Commands'));
      }
      coordinator.publish({
        phase,
        queue: ['hello'],
        ...(phase === 'error' ? { error: 'Restart Witch.' } : {}),
      });
      await until('the queue taken back', () => calls.length > 0);
      if (covered) ui.stdin.write('\u001b');
      await until('the queued prompt', () => ui.text().includes('┃ hello'));
      assert.ok(ui.text().indexOf('┃ hello') < ui.text().indexOf('┃ newer'));
      assert.deepEqual(calls, [['unqueue']]);
    } finally {
      ui.unmount();
    }
  }
});

await test('the composer takes typing while an open conversation connects, and none before the load opens one', async () => {
  for (const open of [true, false]) {
    const { app } = fake({
      phase: 'starting',
      ...(open ? {} : { conversation: undefined }),
    });
    const ui = show(createElement(App, { coordinator: app, onExit: () => {} }));
    try {
      await delay(60);
      ui.stdin.write('hello');
      await delay(60);
      assert.equal(ui.text().includes('┃ hello'), open);
    } finally {
      ui.unmount();
    }
  }
});
