import assert from 'node:assert/strict';
import { test } from 'vitest';
import { main } from '../src/memory/memory.js';
import { fixture } from './fixtures/coordinator.js';

for (const window of ['beginActivity', 'prepareNote'] as const) {
  test(`an interrupt during ${window} stops the memory editor before it opens`, async (t) => {
    const signals: boolean[] = [];

    const { coordinator, memory } = await fixture(async (_path, signal) => {
      signals.push(signal.aborted);

      if (signal.aborted)
        throw new DOMException('Editing interrupted', 'AbortError');
    });

    t.onTestFinished(() => coordinator.close());

    const internals = coordinator as unknown as Record<string, unknown> & {
      workspace: Record<string, unknown>;
    };

    const target = window === 'beginActivity' ? internals : internals.workspace;

    const original = (target[window] as (...args: unknown[]) => unknown).bind(
      target,
    );

    target[window] = async (...args: unknown[]) => {
      await coordinator.interrupt();

      return original(...args);
    };

    await coordinator.editMemory();

    assert.deepEqual(signals, [true]);

    assert.equal(coordinator.snapshot.error, undefined);

    const subjects = await memory.git(memory.root, [
      'log',
      '--format=%s',
      main,
    ]);

    assert.ok(!subjects.includes('chore(memory): save edited notes'));
  });
}
