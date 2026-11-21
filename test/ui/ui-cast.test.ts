import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import { tokenize } from '@alcalzone/ansi-tokenize';
import { Text } from 'ink';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import { test, vi } from 'vitest';
import type { DisplayItem } from '../../src/core/state.js';
import { App } from '../../src/ui/App.js';
import {
  castFrames,
  castRows,
  castTitle,
  useCasting,
} from '../../src/ui/status/cast.js';
import { tickMs } from '../../src/ui/useTick.js';
import { drag, fake, show } from '../fixtures/ui.js';
import { until } from '../fixtures/within.js';
import {
  long,
  first as firstRow,
  CMD_C,
  wheelUp,
} from '../fixtures/ui-transcript.js';

const castMs = castFrames * tickMs;

const cast = (id: string, at: number): DisplayItem => ({
  id,
  kind: 'notice',
  cast: true,
  text: `Cast \`${id}\``,
  cwd: '/work',
  at: new Date(at).toISOString(),
});

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

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function freeze(at = 100_000) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(at);
}

function cells(text: string): string[] {
  return [...graphemes.segment(stripAnsi(text))].flatMap(({ segment }) => [
    segment,
    ...Array<string>(stringWidth(segment) - 1).fill(''),
  ]);
}

const frame = (
  step: number,
  width = 120,
  seed = 'spell/demo-1',
  lift = false,
) => castRows(step, width, seed, lift);

test('live overlays fit their terminal cells without changing the anchored heading', () => {
  for (const seed of ['spell/0', 'spell/review', 'spell/demo-1'])
    for (const width of [7, 8, 9, 12, 28, 78, 120, 163])
      for (let step = 0; step < castFrames; step++)
        for (const lift of [false, true]) {
          const { heading, above } = frame(step, width, seed, lift);
          assert.ok(stripAnsi(heading).startsWith('✦ Spell'));
          assert.equal(above !== undefined, lift && width > 8);

          for (const row of [heading, above]) {
            if (row === undefined) continue;

            assert.equal(stringWidth(row), width > 8 ? width : 7);
            assert.ok(!row.includes('\n'));

            for (const { segment } of graphemes.segment(stripAnsi(row)))
              assert.ok(stringWidth(segment) <= 2, segment);
          }
        }

  assert.equal(stripAnsi(castTitle()), '✦ Spell');
});

test('the seeded chain advances one cell and keeps its identity through a resize', () => {
  const before = cells(frame(10).heading);
  const after = cells(frame(11).heading);
  assert.deepEqual(after.slice(17, 99), before.slice(16, 98));

  for (const seed of ['spell/0', 'spell/review', 'spell/demo-1']) {
    assert.deepEqual(frame(10, 120, seed), frame(10, 120, seed));

    assert.deepEqual(
      cells(frame(10, 160, seed).heading).slice(-88),
      cells(frame(10, 100, seed).heading).slice(-88),
    );
  }

  assert.notEqual(
    frame(10, 120, 'first').heading,
    frame(10, 120, 'second').heading,
  );
});

test('a local glitch restores the same moving chain after its burst', () => {
  const frames = Array.from({ length: castFrames }, (_, step) =>
    cells(frame(step).heading),
  );

  const glitched = frames.findIndex((row) =>
    row.some((cell) => /[░▒]/u.test(cell)),
  );

  assert.ok(glitched > 10 && glitched < 30);
  const baseline = frames[10]!;
  const shift = glitched - 10;
  const start = 12 + shift;

  const changed = frames[glitched]!.slice(start, 110).filter(
    (cell, index) => cell !== baseline[start + index - shift],
  );

  assert.ok(changed.length > 0 && changed.length <= 14, String(changed.length));
  const restored = glitched + 3;
  const later = restored - 10;

  assert.deepEqual(
    frames[restored]!.slice(12 + later, 110),
    baseline.slice(12, 110 - later),
  );
});

function foreground(code: string): number[] | undefined {
  const prefix = '\u001b[38;2;';

  if (code.startsWith(prefix) && code.endsWith('m'))
    return code.slice(prefix.length, -1).split(';').map(Number);
}

function light(row: string, at: number): number {
  let column = 0;
  let level = 0;

  for (const token of tokenize(row)) {
    if (token.type === 'ansi') {
      const color = foreground(token.code);

      if (color) level = color.reduce((sum, value) => sum + value, 0);
      else if (token.code === '\u001b[39m') level = 0;

      continue;
    }

    if (token.type !== 'char') continue;

    const width = stringWidth(token.value);

    if (column <= at && at < column + width) return level;

    column += width;
  }

  return 0;
}

test('a complete face rises and lands on the same moving chain before the fade', () => {
  const face = '(@￣ρ￣@)';
  const airborne = frame(24, 160, 'spell/demo-1', true);
  const landed = frame(34, 160, 'spell/demo-1', true);
  const above = stripAnsi(airborne.above!);
  const ground = stripAnsi(landed.heading);
  const liftedIndex = above.indexOf(face);
  const landedIndex = ground.indexOf(face);
  assert.ok(liftedIndex >= 0 && landedIndex >= 0);
  const liftedColumn = stringWidth(above.slice(0, liftedIndex));
  const landedColumn = stringWidth(ground.slice(0, landedIndex));
  assert.equal(landedColumn, liftedColumn + 10);

  assert.ok(
    light(airborne.above!, liftedColumn) >
      light(airborne.heading, liftedColumn),
  );

  assert.ok(!stripAnsi(landed.above!).includes(face));

  assert.ok(
    light(landed.heading, landedColumn) > light(airborne.heading, liftedColumn),
  );

  assert.equal(
    stripAnsi(frame(0, 160, 'spell/demo-1', true).above!).trim(),
    '',
  );

  assert.equal(
    stripAnsi(frame(castFrames - 1, 160, 'spell/demo-1', true).above!).trim(),
    '',
  );

  assert.equal(stripAnsi(frame(castFrames - 1).heading).trim(), '✦ Spell');
});

test('glitch and sparkle highlights stay in the violet palette with or without room to hop', () => {
  for (const seed of ['spell/0', 'spell/demo-1'])
    for (const width of [9, 120])
      for (let step = 0; step < castFrames; step++)
        for (const lift of [false, true]) {
          const { heading, above } = frame(step, width, seed, lift);

          for (const row of [heading, above ?? ''])
            for (const token of tokenize(row)) {
              if (token.type !== 'ansi') continue;

              const color = foreground(token.code);

              if (!color) continue;

              const [red, green, blue] = color as [number, number, number];

              assert.ok(
                blue <= 255 && blue >= red && red >= green && green >= 0,
                token.code,
              );
            }
        }
});

test('a new cast animates its title, then settles on the final title and stays', async () => {
  freeze();
  const { ui } = render([cast('review', Date.now())]);

  try {
    await until('the animated title', () => animating(ui));
    vi.advanceTimersByTime(castMs);
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
  freeze();
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
    vi.advanceTimersByTime(castMs);
    await until('the live cast to settle', () => settled(published.ui));
    published.coordinator.publish({ items: [live, cast('review', old)] });
    vi.advanceTimersByTime(40);
    await until('both titles', () => titles(published.ui).length === 2);
    await staysFinal(published.ui);
  } finally {
    published.ui.unmount();
  }
});

test('selecting a live heading shows and copies its canonical text through settlement', async () => {
  freeze();
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
    ui.stdin.write(CMD_C);
    await until('the copied spell', () => copied.length === 1);
    assert.deepEqual(copied, ['✦ Spell\nCast review']);
    vi.advanceTimersByTime(castMs);
    await delay(60);
    assert.ok(selected());
    assert.ok(titles(ui)[0]!.includes('\u001b[7m'));
    ui.stdin.write(CMD_C);
    await until('the settled copy', () => copied.length === 2);
    assert.deepEqual(copied, ['✦ Spell\nCast review', '✦ Spell\nCast review']);
  } finally {
    ui.unmount();
  }
});

test('resizing a live cast preserves its rows and original expiry', async () => {
  freeze();
  const { ui } = render([cast('review', Date.now())]);

  const bodyRow = () =>
    ui
      .text()
      .split('\n')
      .findIndex((line) => line.includes('Cast review'));

  try {
    await until('the animated title', () => animating(ui));

    assert.equal(
      stripAnsi(titles(ui)[0]!).trim(),
      stripAnsi(frame(0, 98, 'review').heading).trim(),
    );

    const original = bodyRow();
    vi.advanceTimersByTime(1000);
    ui.resize(30);

    await until(
      'the narrow frame',
      () =>
        stripAnsi(titles(ui)[0] ?? '').trim() ===
        stripAnsi(frame(20, 28, 'review').heading).trim(),
    );

    assert.ok(animating(ui));
    assert.equal(bodyRow(), original);
    ui.resize(100);

    await until(
      'the full-width frame again',
      () =>
        stripAnsi(titles(ui)[0] ?? '').trim() ===
        stripAnsi(frame(20, 98, 'review').heading).trim(),
    );

    assert.ok(animating(ui));
    assert.equal(bodyRow(), original);
    vi.advanceTimersByTime(castMs - 1000);
    await until('expiry at the original time', () => settled(ui));
    assert.equal(bodyRow(), original);
  } finally {
    ui.unmount();
  }
});

test('staggered casts settle by their own timestamps', async () => {
  freeze();
  const now = Date.now();
  const half = castMs / 2;
  const { ui } = render([cast('first', now - half), cast('second', now)]);

  try {
    await until(
      'both casts',
      () => titles(ui).length === 2 && titles(ui).every((line) => !final(line)),
    );

    vi.advanceTimersByTime(half);

    await until(
      'only the second cast animates',
      () => final(titles(ui)[0]!) && !final(titles(ui)[1]!),
    );

    vi.advanceTimersByTime(half);
    await until('both casts settle', () => settled(ui));
  } finally {
    ui.unmount();
  }
});

function Casting({ items }: { items: DisplayItem[] }) {
  const active = useCasting(items);

  return createElement(Text, null, active.size ? 'casting' : 'settled');
}

test('a spell remains live for the approved 3.6 seconds', async () => {
  freeze();
  const items = [cast('duration', Date.now())];

  function Duration() {
    const active = useCasting(items);

    return createElement(
      Text,
      null,
      `${active.size ? 'casting' : 'settled'} at ${Date.now()}`,
    );
  }

  const ui = show(createElement(Duration));

  try {
    await until('cast begins', () => ui.text() === 'casting at 100000');
    vi.advanceTimersByTime(3550);
    await until('cast remains live', () => ui.text() === 'casting at 103550');
    vi.advanceTimersByTime(50);

    await until(
      'cast expires at 3600 ms',
      () => ui.text() === 'settled at 103600',
    );
  } finally {
    ui.unmount();
  }
});

test('the shared clock releases cast subscriptions after expiry and on unmount', async () => {
  freeze();

  for (const expire of [true, false]) {
    const ui = show(
      createElement(Casting, { items: [cast('review', Date.now())] }),
    );

    try {
      await until('the live hook', () => ui.text() === 'casting');
      await until('the cast subscription', () => vi.getTimerCount() === 1);

      if (expire) {
        vi.advanceTimersByTime(castMs);
        await until('the settled hook', () => ui.text() === 'settled');

        await until(
          'the expired subscription stops',
          () => vi.getTimerCount() === 0,
        );
      }
    } finally {
      ui.unmount();
    }

    await until('clock cleanup', () => vi.getTimerCount() === 0);
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
  const first = () => firstRow(ui);

  try {
    await until('the animated title', () => animating(ui));
    ui.stdin.write('abc');
    await until('the typed draft', () => ui.text().includes('abc'));
    const bottom = first();
    ui.stdin.write(wheelUp.repeat(3));
    await until('three rows up', () => first() === bottom - 3);
    assert.ok(Date.now() - at < castMs, `${Date.now() - at} ms`);
  } finally {
    ui.unmount();
  }
});

test('simultaneous casts render the chains belonging to their own ids', async () => {
  freeze();

  const { ui } = render([
    cast('first', Date.now()),
    cast('second', Date.now()),
  ]);

  try {
    await until('both casts', () => titles(ui).length === 2);

    assert.deepEqual(
      titles(ui).map((line) => stripAnsi(line).trim()),
      ['first', 'second'].map((id) =>
        stripAnsi(frame(0, 98, id).heading).trim(),
      ),
    );
  } finally {
    ui.unmount();
  }
});

test('selecting the upper blank row suppresses hops without hiding the heading animation', async () => {
  freeze();

  const before: DisplayItem = {
    id: 'before',
    kind: 'assistant',
    text: 'keep this text',
    cwd: '/work',
  };

  const { ui } = render([before, cast('spell/demo-1', Date.now())], 100, 24);

  try {
    await until('the cast', () => animating(ui));
    vi.advanceTimersByTime(900);

    const heading = () =>
      ui
        .text()
        .split('\n')
        .findIndex((line) => line.includes('✦ Spell'));

    const upper = () => ui.text().split('\n')[heading() - 1]?.trim();
    await until('a lifted face', () => !!upper());
    drag(ui, [1, heading() - 1], [98, heading() - 1]);
    await until('the selected blank row', () => upper() === '');
    assert.ok(animating(ui));
    assert.ok(ui.text().includes('keep this text'));
  } finally {
    ui.unmount();
  }
});

test('a cast at the top of the viewport keeps the phase row intact', async () => {
  freeze();
  const { ui } = render([long, cast('review', Date.now())], 60, 14);

  try {
    await until('the top cast', () => animating(ui));
    vi.advanceTimersByTime(900);
    await delay(40);
    const rows = ui.text().split('\n');
    assert.equal(rows[0]?.trim(), 'IDLE');
    assert.ok(rows[1]?.includes('✦ Spell'), ui.text());
  } finally {
    ui.unmount();
  }
});

test('a cast between clock boundaries stays live until its actual expiry', async () => {
  freeze(100_023);

  const ui = show(
    createElement(Casting, { items: [cast('boundary', Date.now())] }),
  );

  try {
    vi.advanceTimersByTime(27);
    await until('the live hook', () => ui.text() === 'casting');
    vi.advanceTimersByTime(castMs - 28);
    await delay(20);
    assert.equal(ui.text(), 'casting');
    vi.advanceTimersByTime(tickMs);
    await until('settlement on the next tick', () => ui.text() === 'settled');
  } finally {
    ui.unmount();
  }
});

test('a live cast too narrow for its heading preserves the canonical wrapped rows', async () => {
  freeze();
  const old = render([cast('narrow', Date.now() - 60_000)], 8, 30);
  const live = render([cast('narrow', Date.now())], 8, 30);

  try {
    await until(
      'both wrapped headings',
      () => old.ui.text().includes('Spell') && live.ui.text().includes('Spell'),
    );

    vi.advanceTimersByTime(900);
    await delay(20);
    assert.equal(live.ui.text().match(/Spell/gu)?.length, 1);
    assert.equal(live.ui.text(), old.ui.text());
    live.ui.stdin.write('x');
    await until('the narrow draft', () => live.ui.text().includes('x'));
  } finally {
    live.ui.unmount();
    old.ui.unmount();
  }
});
