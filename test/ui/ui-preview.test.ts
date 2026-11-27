import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement, useState } from 'react';
import stringWidth from 'string-width';
import * as wrapping from 'wrap-ansi';
import { test, vi } from 'vitest';
import { Preview as PreviewOwner } from '../../src/core/preview.js';
import { Preview } from '../../src/ui/Preview.js';
import { App } from '../../src/ui/App.js';
import { show, fake, ENTER, openCommand } from '../fixtures/ui.js';
import { until } from '../fixtures/within.js';

vi.mock('wrap-ansi', { spy: true });

const question = {
  id: 'q',
  kind: 'question' as const,
  title: 'Question',
  detail: '',
  questions: [
    {
      id: 'choice',
      title: 'Keep the current preview?',
      options: ['Keep it', 'Change it'],
    },
  ],
};

function fixture(
  rows = 30,
  snapshot: Parameters<typeof fake>[0] = {
    items: [
      {
        id: 'text',
        kind: 'assistant',
        text: 'Transcript remains readable',
        cwd: '/work',
      },
    ],
  },
) {
  const f = fake(snapshot);
  const owner = new PreviewOwner();

  Object.assign(f.coordinator, {
    coordination: {
      preview: owner,
      subscribe: () => () => {},
      snapshot: undefined,
    },
  });

  const ui = show(
    createElement(App, { coordinator: f.app, onExit() {} }),
    80,
    rows,
  );

  return { ...f, owner, ui };
}

const reply = {
  id: 'reply',
  kind: 'assistant' as const,
  text: 'Reply opens here\nQ1 does it look right?\nQ2 is it readable?\nQ3 should I continue?',
  cwd: '/work',
};

function tall(rows: number) {
  return {
    title: 'Tall',
    frames: [Array.from({ length: rows }, (_, i) => `frame row ${i}`)],
  };
}

const placed = (owner: PreviewOwner) =>
  owner.snapshot?.status.placement?.rows ?? 0;

const range = (ui: { text(): string }) =>
  /rows \d+–\d+ of \d+/u.exec(ui.text())?.[0];

/** a one-based SGR wheel report at column 5 of a zero-based screen row. */
const wheel = (button: 64 | 65, row: number) =>
  `\u001b[<${button};5;${row + 1}M`;

test('a tall preview preserves question text, options and typed answers, and tracks request placement', async () => {
  const f = fixture();

  try {
    f.owner.show({
      title: 'Current preview',
      frames: [Array.from({ length: 24 }, (_, i) => `current row ${i}`)],
    });

    await until('chat preview', () => f.ui.text().includes('current row 0'));
    f.coordinator.publish({ requests: [question] });

    await until(
      'request placement',
      () => f.owner.snapshot?.status.placement?.request === 'q',
    );

    for (const text of [
      'Keep the current preview?',
      'Keep it',
      'Change it',
      'current row 0',
    ])
      assert.ok(f.ui.text().includes(text), f.ui.text());

    await delay(550);
    f.ui.stdin.write('Keep this version');
    await until('draft', () => f.ui.text().includes('Keep this version'));
    f.ui.stdin.write(ENTER);
    await until('answer', () => f.calls.some(([name]) => name === 'respond'));

    assert.deepEqual(
      f.calls.find(([name]) => name === 'respond'),
      [
        'respond',
        'q',
        { decision: 'accept', answers: { choice: ['Keep this version'] } },
      ],
    );

    f.coordinator.publish({ requests: [] });

    await until(
      'chat placement restored',
      () => f.owner.snapshot?.status.placement?.request === undefined,
    );

    const previous = f.owner.snapshot!.status;
    f.owner.show({ title: 'Replacement', frames: [['LATEST']] });
    assert.equal(f.owner.close(previous.id), false);
    await until('replacement', () => f.ui.text().includes('LATEST'));
    assert.ok(!f.ui.text().includes('current row'));
    const before = f.owner.snapshot!.status.placement!;
    f.coordinator.publish({ requests: [question] });

    await until(
      'same-size question placement',
      () => f.owner.snapshot?.status.placement?.request === 'q',
    );

    assert.equal(f.owner.snapshot!.status.placement!.rows, before.rows);
    assert.equal(f.owner.snapshot!.status.placement!.columns, before.columns);
    f.coordinator.publish({ requests: [] });

    await until(
      'request clears at same dimensions',
      () => f.owner.snapshot?.status.placement?.request === undefined,
    );

    f.ui.resize(20, 7);

    await until(
      'hidden in short terminal',
      () => f.owner.snapshot?.status.placement?.rows === 0,
    );

    assert.ok(!f.ui.text().includes('LATEST'));
    f.ui.resize(80, 30);
    await until('restored on resize', () => f.ui.text().includes('LATEST'));
    await openCommand(f.ui, '/help', 'Keyboard');

    await until(
      'hidden in another view',
      () => f.owner.snapshot?.status.placement === undefined,
    );
  } finally {
    f.ui.unmount();
  }
});

test('a long question keeps its existing scrollable viewport before a preview', async () => {
  const f = fixture();

  const visible = () =>
    [...f.ui.text().matchAll(/Read question line (\d+)/gu)].map((match) =>
      Number(match[1]),
    );

  try {
    f.coordinator.publish({
      requests: [
        {
          ...question,
          questions: [
            {
              ...question.questions[0]!,
              title: Array.from(
                { length: 40 },
                (_, index) => `Read question line ${index}`,
              ).join('\n'),
            },
          ],
        },
      ],
    });

    await until('selected option', () => f.ui.text().includes('Keep it'));
    f.ui.stdin.write('\u001b[5~'.repeat(3));
    await until('question start', () => visible()[0] === 0);
    const before = visible();
    f.owner.show({ title: 'Tall preview', frames: [Array(24).fill('FRAME')] });

    await until(
      'question layout',
      () => f.owner.snapshot?.status.placement?.request === 'q',
    );

    assert.equal(f.owner.snapshot!.status.placement!.rows, 0);
    assert.deepEqual(visible(), before);
    assert.ok(!f.ui.text().includes('FRAME'));
    const seen = new Set(before);

    for (let page = 0; page < 3 && !seen.has(39); page++) {
      const first = visible()[0];
      f.ui.stdin.write('\u001b[6~');
      await until('next question page', () => visible()[0] !== first);

      for (const line of visible()) seen.add(line);
    }

    assert.deepEqual(
      [...seen].sort((a, b) => a - b),
      Array.from({ length: 40 }, (_, index) => index),
    );
  } finally {
    f.ui.unmount();
  }
});

// idle chat rows: one phase row, a two-row footer, then from the body a bordered
// one-row composer (3), the tool window (4) and the gap (1); half of the rest goes to the transcript
for (const [rows, shared] of [
  [24, 24 - 1 - 2 - 3 - 4 - 1],
  [60, 60 - 1 - 2 - 3 - 4 - 1],
] as const)
  test(`a tall chat preview leaves the reply readable at ${rows} rows`, async () => {
    const f = fixture(rows, { items: [reply] });

    try {
      f.owner.show(tall(rows * 2));
      // the preview keeps floor(shared / 2) rows, one of them its title
      const expected = Math.floor(shared / 2) - 1;
      await until('placement', () => placed(f.owner) === expected);

      for (const text of [
        'Reply opens here',
        'Q1 does it look right?',
        'Q2 is it readable?',
        'Q3 should I continue?',
        'frame row 0',
        `rows 1–${expected} of ${rows * 2} · Tall`,
      ])
        assert.ok(f.ui.text().includes(text), f.ui.text());
    } finally {
      f.ui.unmount();
    }
  });

test('queued prompts come out of the rows a preview leaves before the transcript takes half', async () => {
  const f = fixture(24, {
    phase: 'running',
    queue: ['queued 0', 'queued 1', 'queued 2', 'queued 3'],
    items: [{ ...reply, text: 'Short reply' }],
  });

  try {
    f.owner.show(tall(48));
    // 24 rows less the phase row, footer (2), composer (3), working row, tools (4), gap and message row leave 11;
    // the queue takes 4, the transcript ceil(7 / 2) = 4, and the preview 3 with its title
    await until('placement', () => placed(f.owner) === 2);

    for (const text of ['Short reply', 'queued 0', 'queued 3', 'frame row 1'])
      assert.ok(f.ui.text().includes(text), f.ui.text());
  } finally {
    f.ui.unmount();
  }
});

test('the wheel scrolls a cropped chat preview over its frame and the transcript elsewhere', async () => {
  const f = fixture(24, {
    items: [
      {
        id: 'history',
        kind: 'assistant',
        text: Array.from({ length: 60 }, (_, i) => `history ${i}`).join('\n'),
        cwd: '/work',
      },
      reply,
    ],
  });

  try {
    f.owner.show(tall(48));
    await until('placement', () => placed(f.owner) === 5);
    // 7 transcript rows below the phase row put the title on row 8 and the frame on rows 9 to 13
    f.ui.stdin.write(wheel(65, 10));
    await until('one step', () => range(f.ui) === 'rows 2–6 of 48');
    assert.equal(f.ui.text().split('\n')[9]?.trim(), 'frame row 1');
    f.ui.stdin.write(wheel(65, 10).repeat(2));

    await until(
      'two steps in one read',
      () => range(f.ui) === 'rows 4–8 of 48',
    );

    f.ui.stdin.write(wheel(65, 10).repeat(60));
    await until('end', () => range(f.ui) === 'rows 44–48 of 48');
    assert.ok(f.ui.text().includes('frame row 47'));
    assert.ok(f.ui.text().includes('Q3 should I continue?'));
    f.ui.resize(80, 60);
    // 49 shared rows at 60 give the preview 23 frame rows, so the offset clamps to 48 - 23
    await until('clamped on resize', () => range(f.ui) === 'rows 26–48 of 48');
    // 25 transcript rows put the title on row 26 and the frame on rows 27 to 49
    f.ui.stdin.write(wheel(64, 30));
    await until('up at once', () => range(f.ui) === 'rows 25–47 of 48');

    const reading = () =>
      f.ui.text().split('\n')[0]!.includes('READING EARLIER OUTPUT');

    assert.ok(!reading());
    f.ui.stdin.write(wheel(64, 5).repeat(3));
    await until('transcript scrolled', reading);
    assert.equal(range(f.ui), 'rows 25–47 of 48');
    const top = () => /history (\d+)/u.exec(f.ui.text())?.[1];
    const above = top();
    f.ui.stdin.write(wheel(64, 26));
    await until('title row scrolls the transcript', () => top() !== above);
    assert.equal(range(f.ui), 'rows 25–47 of 48');
    f.owner.show(tall(30));

    await until(
      'replacement at its top',
      () => range(f.ui) === 'rows 1–23 of 30',
    );

    f.owner.show({
      title: 'Short',
      frames: [['short 0', 'short 1', 'short 2']],
    });

    await until('uncropped', () => f.ui.text().includes('short 2'));
    const before = top();
    // 45 transcript rows put the short preview's frame on rows 47 to 49
    f.ui.stdin.write(wheel(64, 48));

    await until(
      'transcript moves under an uncropped preview',
      () => top() !== before,
    );

    assert.ok(!f.ui.text().includes('rows 1–'));
  } finally {
    f.ui.unmount();
  }
});

test('a cropped preview keeps its range ahead of a long title', async () => {
  const owner = new PreviewOwner();
  owner.show({ title: 'T'.repeat(200), frames: [['a', 'b', 'c', 'd', 'e']] });

  const ui = show(
    createElement(Preview, { owner, width: 80, height: 3 }),
    80,
    3,
  );

  try {
    await until('range', () => ui.text().startsWith('rows 1–2 of 5 · TTT'));
  } finally {
    ui.unmount();
  }
});

test('preview loops reuse clipped frames and update them on resize or replacement', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(100_000);
  const wrap = vi.mocked(wrapping.default);
  wrap.mockClear();

  const clipped = () =>
    wrap.mock.calls.filter(([, , options]) => options?.wordWrap === false)
      .length;

  const owner = new PreviewOwner();

  owner.show({
    title: 'Loop',
    frames: [
      ['\u001b[38;2;120;80;200mFIRST FRAME', 'TAIL ONE'],
      ['\u001b[38;2;80;120;200mSECOND FRAME', 'TAIL TWO'],
    ],
  });

  let resize!: (size: [number, number]) => void;

  function View() {
    const [[width, height], setSize] = useState<[number, number]>([8, 2]);
    resize = setSize;

    return createElement(Preview, { owner, width, height });
  }

  const ui = show(createElement(View));

  try {
    await until(
      'first clipped frame',
      () => ui.text() === 'rows 1–1 of 2 · Loop\nFIRST FR',
    );

    vi.advanceTimersByTime(50);

    await until(
      'second clipped frame',
      () => ui.text() === 'rows 1–1 of 2 · Loop\nSECOND F',
    );

    const calls = clipped();
    assert.ok(calls > 0);
    vi.advanceTimersByTime(50);

    await until(
      'first frame again',
      () => ui.text() === 'rows 1–1 of 2 · Loop\nFIRST FR',
    );

    vi.advanceTimersByTime(50);

    await until(
      'second frame again',
      () => ui.text() === 'rows 1–1 of 2 · Loop\nSECOND F',
    );

    assert.equal(clipped(), calls);
    resize([4, 2]);

    await until(
      'narrow frame',
      () => ui.text() === 'rows 1–1 of 2 · Loop\nSECO',
    );

    resize([8, 3]);
    await until('taller frame', () => ui.text() === 'Loop\nSECOND F\nTAIL TWO');
    owner.show({ title: 'New', frames: [['REPLACED'], ['LATEST']] });

    await until(
      'replacement starts',
      () => ui.text().trimEnd() === 'New\nREPLACED',
    );

    vi.advanceTimersByTime(50);

    await until(
      'replacement advances',
      () => ui.text().trimEnd() === 'New\nLATEST',
    );
  } finally {
    ui.unmount();
  }
});

test('frame playback stops for a still or hidden panel and unmount clears placement', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(100_000);
  const owner = new PreviewOwner();
  owner.show({ title: 'Motion', frames: [['FIRST'], ['SECOND']] });
  let resize!: (height: number) => void;

  function View() {
    const [height, setHeight] = useState(3);
    resize = setHeight;

    return createElement(Preview, { owner, width: 8, height });
  }

  const ui = show(createElement(View));

  try {
    await until('first frame', () => ui.text().includes('FIRST'));
    vi.advanceTimersByTime(50);
    await until('second frame', () => ui.text().includes('SECOND'));
    resize(0);

    await until(
      'hidden timer stops',
      () =>
        owner.snapshot?.status.placement?.rows === 0 &&
        vi.getTimerCount() === 0,
    );

    owner.show({ title: 'Still', frames: [['UNCHANGED']] });
    resize(3);
    await until('still', () => ui.text().includes('UNCHANGE'));
    assert.equal(vi.getTimerCount(), 0);
    vi.advanceTimersByTime(500);
    assert.ok(!ui.text().includes('SECOND'));
  } finally {
    ui.unmount();
  }

  await until(
    'unmounted placement',
    () => owner.snapshot?.status.placement === undefined,
  );

  assert.equal(vi.getTimerCount(), 0);
});

test('narrow previews clip whole graphemes without spilling into another row', async () => {
  const owner = new PreviewOwner();
  owner.show({ title: 'P', frames: [['🙂hello']] });
  const ui = show(createElement(Preview, { owner, width: 1, height: 2 }), 1, 2);

  try {
    await until(
      'placement',
      () => owner.snapshot?.status.placement?.columns === 1,
    );

    assert.ok(
      ui
        .text()
        .split('\n')
        .every((row) => stringWidth(row) <= 1),
    );

    assert.ok(!ui.text().includes('🙂'));
  } finally {
    ui.unmount();
  }
});

test('horizontal clipping retains every fitting cell instead of wrapping whole words', async () => {
  const owner = new PreviewOwner();
  owner.show({ title: 'P', frames: [['abc defghij']] });
  const ui = show(createElement(Preview, { owner, width: 8, height: 2 }), 8, 2);

  try {
    await until('clipped prefix', () => ui.text() === 'P\nabc defg');
  } finally {
    ui.unmount();
  }
});

test('the wheel over a request preview scrolls its frame', async () => {
  const f = fixture(24);

  try {
    f.owner.show(tall(48));
    f.coordinator.publish({ requests: [question] });

    await until(
      'request placement',
      () => f.owner.snapshot?.status.placement?.request === 'q',
    );

    const before = range(f.ui)!;
    const [, first] = /rows (\d+)–/u.exec(before)!;

    const frame = f.ui
      .text()
      .split('\n')
      .findIndex((line) => line.includes('frame row 0'));

    f.ui.stdin.write(wheel(65, frame));
    await until('one step', () => range(f.ui) !== before);

    assert.equal(
      /rows (\d+)–/u.exec(range(f.ui)!)![1],
      String(Number(first) + 1),
    );
  } finally {
    f.ui.unmount();
  }
});

test('the wheel still scrolls a long question whose preview has no room', async () => {
  const f = fixture();

  const visible = () =>
    [...f.ui.text().matchAll(/Read question line (\d+)/gu)].map((match) =>
      Number(match[1]),
    );

  try {
    f.owner.show(tall(48));

    f.coordinator.publish({
      requests: [
        {
          ...question,
          questions: [
            {
              ...question.questions[0]!,
              title: Array.from(
                { length: 40 },
                (_, index) => `Read question line ${index}`,
              ).join('\n'),
            },
          ],
        },
      ],
    });

    await until('selected option', () => f.ui.text().includes('Keep it'));
    f.ui.stdin.write('\u001b[5~'.repeat(3));
    await until('question start', () => visible()[0] === 0);
    f.ui.stdin.write(wheel(65, 5));
    await until('one wheel step', () => visible()[0] === 1);
  } finally {
    f.ui.unmount();
  }
});
