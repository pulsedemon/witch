import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import { test } from 'vitest';
import type { DisplayItem } from '../src/core/state.js';
import { App } from '../src/ui/app.js';
import { castFrames, castMs, castTitle } from '../src/ui/cast.js';
import { colors, potion } from '../src/ui/theme.js';
import { fake, show } from './fixtures/ui.js';
import { until } from './fixtures/within.js';

const cast = (id: string, at: number): DisplayItem => ({
  id,
  kind: 'notice',
  cast: true,
  text: `Cast \`${id}\``,
  cwd: '/work',
  at: new Date(at).toISOString(),
});
const long: DisplayItem = {
  id: 'long',
  kind: 'assistant',
  text: Array.from({ length: 300 }, (_, n) => `row ${n + 1}`).join('\n'),
  cwd: '/work',
};
/** the escape that opens the highlighted letter; the final title has none. */
const lit = colors.hex(potion)('x').split('x')[0]!;
type View = ReturnType<typeof show>;
const titles = (ui: View) =>
  ui
    .frame()
    .split('\n')
    .filter((line) => stripAnsi(line).trim().endsWith('Spell'));
const final = (line: string) =>
  stripAnsi(line).trim() === '✦ Spell' && !line.includes(lit);
const settled = (ui: View) => {
  const shown = titles(ui);
  return shown.length > 0 && shown.every(final);
};
const animating = (ui: View) => titles(ui).some((line) => !final(line));
const render = (items: DisplayItem[]) => {
  const { app, coordinator } = fake({ items });
  return {
    coordinator,
    ui: show(createElement(App, { coordinator: app, onExit: () => {} })),
  };
};
/** five reads 100 ms apart, every one showing only final titles. */
async function staysFinal(ui: View) {
  for (let read = 0; read < 5; read++) {
    assert.ok(settled(ui), ui.frame());
    await delay(100);
  }
}

test('every cast frame keeps the final title width', () => {
  for (const frame of [...Array(castFrames).keys(), undefined])
    assert.equal(stringWidth(castTitle(frame)), 7, String(frame));
});

test('a new cast animates its title, then settles on the final title and stays', async () => {
  const { ui } = render([cast('review', Date.now())]);
  try {
    await until('the animated title', () => animating(ui));
    await until('the final title', () => settled(ui), 100);
    await delay(150);
    assert.ok(settled(ui));
    await delay(150);
    assert.ok(settled(ui));
  } finally {
    ui.unmount();
  }
});

test('a cast from history shows final and unanimated, at mount and when published after a live cast settles', async () => {
  const old = Date.now() - 60_000;
  const mounted = render([cast('review', old)]);
  try {
    await until('the transcript', () => titles(mounted.ui).length > 0);
    await staysFinal(mounted.ui);
    assert.ok(mounted.ui.text().includes('✦ Spell'));
    assert.ok(mounted.ui.text().includes('Cast review'));
  } finally {
    mounted.ui.unmount();
  }
  const live = cast('tdd', Date.now());
  const published = render([live]);
  try {
    await until('the animated title', () => animating(published.ui));
    await until('the live cast to settle', () => settled(published.ui), 100);
    published.coordinator.publish({ items: [live, cast('review', old)] });
    await until('both titles', () => titles(published.ui).length === 2);
    await staysFinal(published.ui);
  } finally {
    published.ui.unmount();
  }
});

test('a cast published again after its window, while hidden, shows final from its first frame', async () => {
  const live = cast('review', Date.now());
  const { ui, coordinator } = render([live]);
  try {
    await until('the animated title', () => animating(ui));
    coordinator.publish({ items: [] });
    await until('the hidden title', () => titles(ui).length === 0);
    await delay(castMs + 300 - (Date.now() - Date.parse(live.at!)));
    coordinator.publish({ items: [live] });
    let seen = 0;
    for (const started = Date.now(); Date.now() - started < 400;) {
      if (titles(ui).length) {
        seen++;
        assert.ok(settled(ui), ui.frame());
      }
      await delay(10);
    }
    assert.ok(seen > 0);
  } finally {
    ui.unmount();
  }
});

test('typing and scrolling take effect while a cast animates', async () => {
  const at = Date.now();
  const { ui } = render([long, cast('review', at)]);
  const first = () => Number(/row (\d+)/.exec(ui.text())?.[1]);
  try {
    await until('the animated title', () => animating(ui));
    ui.stdin.write('abc');
    await until('the typed draft', () => ui.text().includes('abc'));
    const bottom = first();
    ui.stdin.write('\u001b[<64;10;10M'.repeat(3));
    await until('three rows up', () => first() === bottom - 3);
    assert.ok(Date.now() - at < castMs, `${Date.now() - at} ms`);
  } finally {
    ui.unmount();
  }
});
