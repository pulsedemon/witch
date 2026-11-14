import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import { Text } from 'ink';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import { test, vi } from 'vitest';
import type { DisplayItem } from '../../src/core/state.js';
import { App } from '../../src/ui/App.js';
import {
  castFrames,
  castMs,
  castTitle,
  useCasting,
} from '../../src/ui/status/cast.js';
import { drag, fake, show } from '../fixtures/ui.js';
import { until } from '../fixtures/within.js';

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

type View = ReturnType<typeof show>;

const titles = (ui: View) =>
  ui
    .frame()
    .split('\n')
    .filter((line) => stripAnsi(line).trim().startsWith('✦ Spell'));

const final = (line: string) =>
  stripAnsi(line).trim() === '✦ Spell' && line.includes(castTitle());

const settled = (ui: View) => {
  const shown = titles(ui);

  return shown.length > 0 && shown.every(final);
};

const animating = (ui: View) => titles(ui).some((line) => !final(line));

const render = (items: DisplayItem[], columns = 100, rows = 40) => {
  const { app, coordinator } = fake({ items });
  const copied: string[] = [];

  return {
    coordinator,
    copied,
    ui: show(
      createElement(App, {
        coordinator: app,
        onExit: () => {},
        copy: (text: string) => copied.push(text),
      }),
      columns,
      rows,
    ),
  };
};

/** five reads 100 ms apart, every one showing only final titles. */
async function staysFinal(ui: View) {
  for (let read = 0; read < 5; read++) {
    assert.ok(settled(ui), ui.frame());

    await delay(100);
  }
}

test('every live cast frame fills the available width with the title anchored on one row', () => {
  for (const width of [7, 28, 78, 120]) {
    for (const frame of [...Array(castFrames).keys(), undefined]) {
      const line = castTitle(frame, width);

      assert.ok(stripAnsi(line).startsWith('✦ Spell'));

      assert.equal(stringWidth(line), frame === undefined ? 7 : width);

      assert.ok(!line.includes('\n'));
    }

    if (width > 7) {
      assert.equal(stripAnsi(castTitle(0, width)).lastIndexOf('*'), width - 1);

      assert.equal(stripAnsi(castTitle(12, width)).lastIndexOf('*'), width - 1);
    }
  }

  assert.equal(stripAnsi(castTitle()), '✦ Spell');

  assert.equal(stringWidth(castTitle()), 7);
});

test('sparks gather, ignite, travel outward and thin into embers before the static title returns', () => {
  const plain = (frame: number) => stripAnsi(castTitle(frame, 48));

  assert.equal(plain(0).indexOf('*'), 47);

  assert.equal(plain(3).indexOf('*'), 8);

  assert.ok(castTitle(4, 48).includes('\u001b[48;2;154;52;18m'));

  assert.equal(plain(4).slice(8, 13), '*:+:*');

  assert.equal(plain(6).indexOf('*'), 8);

  assert.equal(plain(9).indexOf('*'), 37);

  assert.equal(plain(12).indexOf('*'), 47);

  assert.ok(!castTitle(13, 48).includes('\u001b[48;'));

  assert.equal(plain(19).slice(8).trim(), '.          .          .          .');

  assert.ok(castTitle(19, 48).includes('\u001b[38;2;91;33;182m'));

  assert.ok(!castTitle().includes('\u001b[48;'));
});

test('a new cast animates its title, then settles on the final title and stays', async () => {
  const { ui } = render([cast('review', Date.now())]);

  try {
    await until('the animated title', () => animating(ui));

    await until('the final title', () => settled(ui));

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

    await until('the live cast to settle', () => settled(published.ui));

    published.coordinator.publish({ items: [live, cast('review', old)] });

    await until('both titles', () => titles(published.ui).length === 2);

    await staysFinal(published.ui);
  } finally {
    published.ui.unmount();
  }
});

test('selecting a live heading shows and copies its canonical text through settlement', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

  const { ui, copied } = render([cast('review', Date.now())], 60, 24);

  try {
    await until('the animated title', () => animating(ui));

    const rows = ui.text().split('\n');
    const heading = rows.findIndex((line) => line.includes('✦ Spell'));
    const body = rows.findIndex((line) => line.includes('Cast review'));

    drag(ui, [1, heading], [58, body]);

    const selected = () => stripAnsi(titles(ui)[0] ?? '').trim() === '✦ Spell';

    await until('the selected canonical heading', selected);

    assert.ok(titles(ui)[0]!.includes('\u001b[7m'));

    ui.stdin.write('\u001b[99;9u');

    await until('the copied spell', () => copied.length === 1);

    assert.deepEqual(copied, ['✦ Spell\nCast review']);

    vi.advanceTimersByTime(2000);

    await delay(60);

    assert.ok(selected());

    assert.ok(titles(ui)[0]!.includes('\u001b[7m'));

    ui.stdin.write('\u001b[99;9u');

    await until('the settled copy', () => copied.length === 2);

    assert.deepEqual(copied, ['✦ Spell\nCast review', '✦ Spell\nCast review']);
  } finally {
    ui.unmount();
  }
});

test('resizing a live cast preserves its rows and original expiry', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

  const { ui } = render([cast('review', Date.now())]);

  const bodyRow = () =>
    ui
      .text()
      .split('\n')
      .findIndex((line) => line.includes('Cast review'));

  try {
    await until('the animated title', () => animating(ui));

    assert.equal(stripAnsi(titles(ui)[0]!).lastIndexOf('*'), 98);

    const original = bodyRow();

    vi.advanceTimersByTime(1000);

    ui.resize(30);

    await until(
      'the narrow frame',
      () => stringWidth(titles(ui)[0] ?? '') === 29,
    );

    assert.ok(animating(ui));

    assert.equal(bodyRow(), original);

    ui.resize(100);

    await until(
      'the full-width frame again',
      () => stringWidth(titles(ui)[0] ?? '') === 99,
    );

    assert.ok(animating(ui));

    assert.equal(bodyRow(), original);

    vi.advanceTimersByTime(1000);

    await until('expiry at the original time', () => settled(ui));

    assert.equal(bodyRow(), original);
  } finally {
    ui.unmount();
  }
});

test('staggered casts settle by their own timestamps', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

  const now = Date.now();
  const { ui } = render([cast('first', now - 1000), cast('second', now)]);

  try {
    await until(
      'both casts',
      () => titles(ui).length === 2 && titles(ui).every((line) => !final(line)),
    );

    vi.advanceTimersByTime(1000);

    await until(
      'only the second cast animates',
      () => final(titles(ui)[0]!) && !final(titles(ui)[1]!),
    );

    vi.advanceTimersByTime(1000);

    await until('both casts settle', () => settled(ui));
  } finally {
    ui.unmount();
  }
});

function Casting({ items }: { items: DisplayItem[] }) {
  const active = useCasting(items);

  return createElement(Text, null, active.size ? 'casting' : 'settled');
}

test('the cast interval stops after expiry and on unmount', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

  for (const expire of [true, false]) {
    const ui = show(
      createElement(Casting, { items: [cast('review', Date.now())] }),
    );

    try {
      await until('the live hook', () => ui.text() === 'casting');

      assert.equal(vi.getTimerCount(), 1);

      if (expire) {
        vi.advanceTimersByTime(2000);

        await until('the settled hook', () => ui.text() === 'settled');

        assert.equal(vi.getTimerCount(), 0);
      }
    } finally {
      ui.unmount();
    }

    await until('interval cleanup', () => vi.getTimerCount() === 0);
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
