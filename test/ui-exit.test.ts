import assert from 'node:assert/strict';
import { test } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import { App } from '../src/ui/app.js';
import { show, fake, approval } from './fixtures/ui.js';
import { until } from './fixtures/within.js';

// /ex runs from the list; a trailing space opens no list, so /quit resolves as an alias in submit
for (const typed of ['/ex', '/quit '])
  test(`${typed.trim()} exits without sending a prompt`, async () => {
    const { app, calls } = fake({});
    let exits = 0;

    const ui = show(
      createElement(App, {
        coordinator: app,
        onExit: () => {
          exits++;
        },
      }),
    );

    try {
      await delay(60);

      ui.stdin.write(typed);

      await delay(30);

      ui.stdin.write('\r');

      await until('the exit', () => exits === 1);

      assert.deepEqual(calls, []);
    } finally {
      ui.unmount();
    }
  });

test('/restart restarts without exiting or sending a prompt', async () => {
  const { app, calls } = fake({});
  let exits = 0;
  let restarts = 0;

  const ui = show(
    createElement(App, {
      coordinator: app,
      onExit: () => {
        exits++;
      },
      onRestart: () => {
        restarts++;
      },
    }),
  );

  try {
    await delay(60);

    ui.stdin.write('/restart');

    await delay(30);

    ui.stdin.write('\r');

    await until('the restart', () => restarts === 1);

    assert.equal(exits, 0);

    assert.deepEqual(calls, []);
  } finally {
    ui.unmount();
  }
});

/** renders App, counting exits. */
function exiting(snapshot: Parameters<typeof fake>[0]) {
  const { app, calls } = fake(snapshot);
  const state = { exits: 0 };

  const ui = show(
    createElement(App, {
      coordinator: app,
      onExit: () => {
        state.exits++;
      },
    }),
  );

  return { ui, calls, state };
}

const hint = 'PRESS CTRL+C AGAIN TO EXIT';

for (const phase of ['idle', 'cleaning'] as const)
  test(`Ctrl+C while ${phase} asks for a second press, which exits`, async () => {
    const { ui, calls, state } = exiting({ phase });

    try {
      await delay(60);

      ui.stdin.write('\u0003');

      await until('the exit hint', () => ui.text().includes(hint));

      assert.equal(state.exits, 0);

      ui.stdin.write('\u0003');

      await until('the exit', () => state.exits === 1);

      assert.ok(!calls.some(([call]) => call === 'interrupt'));
    } finally {
      ui.unmount();
    }
  });

test('Ctrl+C while running interrupts and keeps the composer text', async () => {
  const { ui, calls, state } = exiting({ phase: 'running' });

  try {
    await delay(60);

    ui.stdin.write('draft text');

    await until('the draft', () => ui.text().includes('draft text'));

    ui.stdin.write('\u0003');

    await until('the interrupt', () => calls.length > 0);

    assert.deepEqual(
      calls.filter(([call]) => call === 'interrupt'),
      [['interrupt']],
    );

    assert.ok(ui.text().includes('draft text'));

    assert.equal(state.exits, 0);
  } finally {
    ui.unmount();
  }
});

test('Ctrl+C with text in the composer clears it without exiting', async () => {
  const { ui, state } = exiting({});

  try {
    await delay(60);

    ui.stdin.write('draft text');

    await until('the draft', () => ui.text().includes('draft text'));

    ui.stdin.write('\u0003');

    await until(
      'the cleared composer',
      () => !ui.text().includes('draft text'),
    );

    assert.ok(!ui.text().includes(hint));

    assert.equal(state.exits, 0);
  } finally {
    ui.unmount();
  }
});

test('Ctrl+C in the error phase keeps the recovered prompts', async () => {
  const { ui, state } = exiting({ phase: 'error', draft: 'recovered prompt' });

  try {
    await until('the recovered prompt', () =>
      ui.text().includes('recovered prompt'),
    );

    ui.stdin.write('\u0003');

    await until('the exit hint', () => ui.text().includes(hint));

    assert.ok(ui.text().includes('recovered prompt'));

    assert.equal(state.exits, 0);
  } finally {
    ui.unmount();
  }
});

test('Ctrl+C in memory recovery quits at once, even with a request open', async () => {
  const { ui, calls, state } = exiting({
    phase: 'recovery',
    recovery: { kind: 'pending', paths: [], diff: 'changed', root: '/memory' },
    requests: [approval],
  });

  try {
    await delay(60);

    ui.stdin.write('\u0003');

    await until('the exit', () => state.exits === 1);

    assert.ok(!calls.some(([call]) => call === 'interrupt'));
  } finally {
    ui.unmount();
  }
});

test('a second Ctrl+C after the window arms again instead of exiting', async () => {
  const { ui, state } = exiting({});

  try {
    await delay(60);

    ui.stdin.write('\u0003');

    await until('the exit hint', () => ui.text().includes(hint));

    await until('the hint expires', () => !ui.text().includes(hint));

    ui.stdin.write('\u0003');

    await until('the hint again', () => ui.text().includes(hint));

    assert.equal(state.exits, 0);
  } finally {
    ui.unmount();
  }
});

test('Ctrl+C while closing quits instead of interrupting again', async () => {
  const { app, coordinator, calls } = fake({});
  let exits = 0;

  const ui = show(
    createElement(App, {
      coordinator: app,
      onExit: () => {
        exits++;
      },
    }),
  );

  try {
    await delay(60);

    coordinator.publish({ phase: 'closing' });

    await until('the closing frame', () => ui.text().includes('CLOSING'));

    ui.stdin.write('\u0003');

    await delay(60);

    assert.equal(exits, 1);

    assert.ok(!calls.some(([call]) => call === 'interrupt'));
  } finally {
    ui.unmount();
  }
});

test('Escape interrupts merge cleanup without exiting', async () => {
  const { app, calls } = fake({ phase: 'cleaning' });
  let exits = 0;

  const ui = show(
    createElement(App, {
      coordinator: app,
      onExit: () => {
        exits++;
      },
    }),
  );

  try {
    await delay(60);

    ui.stdin.write('\u001b');

    await until('the cleanup interrupt', () => calls.length > 0);

    assert.deepEqual(calls, [['interrupt']]);

    assert.equal(exits, 0);
  } finally {
    ui.unmount();
  }
});
