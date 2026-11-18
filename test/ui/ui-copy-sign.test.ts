import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { setImmediate } from 'node:timers/promises';
import { createElement } from 'react';
import { App } from '../../src/ui/App.js';
import { drag, fake, show } from '../fixtures/ui.js';
import { CMD_C } from '../fixtures/ui-transcript.js';
import { until } from '../fixtures/within.js';

const words =
  'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi';

test('a copy the clipboard took shows COPIED in the top row for a second from the latest one, without moving a row under it, and a copy still unconfirmed shows none', async () => {
  const { app } = fake({
    items: [{ id: 'u', kind: 'user', text: words, cwd: '/work' }],
  });

  const texts: string[] = [];
  const confirm: (() => void)[] = [];

  const ui = show(
    createElement(App, {
      coordinator: app,
      onExit: () => {},
      copy: (text, done) => {
        texts.push(text);
        confirm.push(done);
      },
    }),
    60,
    24,
  );

  const sign = () => ui.text().split('\n')[0]!.includes('COPIED');
  const under = () => ui.text().split('\n').slice(1).join('\n');

  // React renders on immediates, which stay real, so a few of them draw what the last key or timer changed
  const drawn = async () => {
    for (let turn = 0; turn < 5; turn++) await setImmediate();
  };

  try {
    await until('the wrapped message', () => ui.text().includes(' omicron pi'));
    drag(ui, [1, 2], [58, 3]);
    await until('the highlight', () => ui.frame().includes('\u001b[7malpha'));
    const before = under();
    // the sign's second runs on this clock, so no stalled runner can make it lapse unseen
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    ui.stdin.write(CMD_C);
    await drawn();
    assert.deepEqual(texts, [words]);
    assert.ok(!sign());
    confirm[0]!();
    await drawn();
    assert.ok(sign());
    assert.equal(under(), before);
    await vi.advanceTimersByTimeAsync(900);
    ui.stdin.write(CMD_C);
    await drawn();
    confirm[1]!();
    await vi.advanceTimersByTimeAsync(999);
    await drawn();
    assert.ok(sign());
    await vi.advanceTimersByTimeAsync(1);
    await drawn();
    assert.ok(!sign());
    assert.equal(under(), before);
  } finally {
    vi.useRealTimers();
    ui.unmount();
  }
});
