import assert from 'node:assert/strict';
import { createElement, useState } from 'react';
import { Box, Text } from 'ink';
import { test, vi } from 'vitest';
import { useTick } from '../../src/ui/useTick.js';
import { show } from '../fixtures/ui.js';
import { until } from '../fixtures/within.js';

function Clock({ every, active }: { every: number; active: boolean }) {
  return createElement(
    Text,
    null,
    `${active ? '' : 'paused '}${every}:${useTick(every, active)}`,
  );
}

test('animation clocks share one timer, retain their cadence and resume at current time', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(100_023);
  let update!: (active: [boolean, boolean]) => void;

  function Clocks() {
    const [active, setActive] = useState<[boolean, boolean]>([true, true]);
    update = setActive;

    return createElement(
      Box,
      { flexDirection: 'column' },
      createElement(Clock, { every: 1, active: active[0] }),
      createElement(Clock, { every: 2, active: active[1] }),
    );
  }

  const ui = show(createElement(Clocks));

  try {
    await until('both initial clocks', () => ui.text() === '1:2000\n2:1000');
    assert.equal(vi.getTimerCount(), 1);
    vi.advanceTimersByTime(27);
    await until('the faster clock', () => ui.text() === '1:2001\n2:1000');
    vi.advanceTimersByTime(50);
    await until('both clocks advance', () => ui.text() === '1:2002\n2:1001');
    update([false, true]);

    await until(
      'the first consumer pauses',
      () => ui.text() === 'paused 1:2002\n2:1001',
    );

    assert.equal(vi.getTimerCount(), 1);
    vi.advanceTimersByTime(100);

    await until(
      'only the active clock advances',
      () => ui.text() === 'paused 1:2002\n2:1002',
    );

    update([false, false]);

    await until(
      'the last consumer stops the timer',
      () => vi.getTimerCount() === 0,
    );

    vi.advanceTimersByTime(5000);
    update([true, false]);

    await until('reactivation uses the current time', () =>
      ui.text().startsWith('1:2104\n'),
    );

    assert.equal(vi.getTimerCount(), 1);
  } finally {
    ui.unmount();
  }

  await until('unmount stops the timer', () => vi.getTimerCount() === 0);
});
