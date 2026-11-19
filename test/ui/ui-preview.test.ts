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

function fixture() {
  const f = fake({
    items: [
      {
        id: 'text',
        kind: 'assistant',
        text: 'Transcript remains readable',
        cwd: '/work',
      },
    ],
  });

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
    30,
  );

  return { ...f, owner, ui };
}

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
    await until('first clipped frame', () => ui.text() === 'Loop\nFIRST FR');
    vi.advanceTimersByTime(50);
    await until('second clipped frame', () => ui.text() === 'Loop\nSECOND F');
    const calls = clipped();
    assert.ok(calls > 0);
    vi.advanceTimersByTime(50);
    await until('first frame again', () => ui.text() === 'Loop\nFIRST FR');
    vi.advanceTimersByTime(50);
    await until('second frame again', () => ui.text() === 'Loop\nSECOND F');
    assert.equal(clipped(), calls);
    resize([4, 2]);
    await until('narrow frame', () => ui.text() === 'Loop\nSECO');
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
