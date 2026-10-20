import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import { App } from '../src/ui/app.js';
import { show, fake } from './fixtures/ui.js';
import { until } from './fixtures/within.js';

// /ex runs from the list; a trailing space opens no list, so /quit resolves as an alias in submit
for (const typed of ['/ex', '/quit '])
  await test(`${typed.trim()} exits without sending a prompt`, async () => {
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

await test('/restart restarts without exiting or sending a prompt', async () => {
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

for (const [phase, outcome, exits, interrupts] of [
  ['idle', 'exits', 1, 0],
  ['running', 'interrupts', 0, 1],
] as const)
  await test(`Ctrl+C while ${phase} ${outcome}`, async () => {
    const { app, calls } = fake({ phase });
    let exited = 0;
    const ui = show(
      createElement(App, {
        coordinator: app,
        onExit: () => {
          exited++;
        },
      }),
    );
    try {
      await delay(60);
      ui.stdin.write('\u0003');
      await delay(60);
      assert.equal(exited, exits);
      assert.equal(
        calls.filter(([call]) => call === 'interrupt').length,
        interrupts,
      );
    } finally {
      ui.unmount();
    }
  });

await test('Ctrl+C while closing quits instead of interrupting again', async () => {
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
