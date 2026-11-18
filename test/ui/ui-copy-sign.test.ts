import assert from 'node:assert/strict';
import { test } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import { App } from '../../src/ui/App.js';
import { drag, fake, show } from '../fixtures/ui.js';
import { CMD_C } from '../fixtures/ui-transcript.js';
import { until } from '../fixtures/within.js';

const words =
  'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi';

test('a copy the clipboard took shows COPIED in the top row until it lapses, without moving a row under it, and a copy still unconfirmed shows none', async () => {
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

  try {
    await until('the wrapped message', () => ui.text().includes(' omicron pi'));
    drag(ui, [1, 2], [58, 3]);
    await until('the highlight', () => ui.frame().includes('\u001b[7malpha'));
    const before = under();
    ui.stdin.write(CMD_C);
    await until('the copy', () => texts.length === 1);
    await delay(60);
    assert.deepEqual(texts, [words]);
    assert.ok(!sign());
    confirm[0]!();
    await until('the copy sign', sign);
    assert.equal(under(), before);
    await until('the sign lapsed', () => !sign());
    assert.equal(under(), before);
  } finally {
    ui.unmount();
  }
});
