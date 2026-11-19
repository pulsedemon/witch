import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  configValue,
  gitIn,
  unlessExit1,
} from '../../../src/core/repository/checkout-git.js';

test('Git config preserves a null cancellation reason', async () => {
  const signal = AbortSignal.abort(null);

  await assert.rejects(
    configValue(gitIn(process.cwd(), signal), 'branch.main.remote'),
    (reason: unknown) => reason === signal.reason,
  );
});

test('only numeric Git exit 1 becomes the absent value', async () => {
  assert.equal(await unlessExit1(Promise.resolve('value'), 'absent'), 'value');

  assert.equal(
    await unlessExit1(Promise.reject({ code: 1 }), 'absent'),
    'absent',
  );

  for (const reason of [undefined, null, { code: '1' }, { code: 2 }])
    await assert.rejects(
      unlessExit1(Promise.reject(reason), 'absent'),
      (error: unknown) => error === reason,
    );
});
