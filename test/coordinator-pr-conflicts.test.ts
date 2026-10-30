import assert from 'node:assert/strict';
import { test } from 'vitest';
import { fixture } from './fixtures/coordinator.js';

test("every turn carries the branch's pull request conflict until it clears", async () => {
  const f = await fixture();
  try {
    const pullRequest = {
      number: 7,
      url: 'https://github.com/o/r/pull/7',
      state: 'OPEN' as const,
      branch: 'feat/x',
      commit: 'a1b2c3',
      base: 'main',
      checks: 'passing' as const,
      mergeable: 'CONFLICTING' as const,
    };
    f.coordinator.conflict = { pullRequest, baseTip: 'f00' };
    await f.coordinator.send('First');
    assert.match(
      f.a.inputs.at(-1)!.context!,
      /^Witch confirmed on GitHub that pull request #7 \(https:\/\/github\.com\/o\/r\/pull\/7\) at head a1b2c3 conflicts with its base branch main, whose tip was f00 when observed, and hasn't confirmed a resolution since\. Passing checks do not make it mergeable\./m,
    );
    f.coordinator.conflict = { pullRequest };
    await f.coordinator.send('Second');
    assert.match(
      f.a.inputs.at(-1)!.context!,
      /^Witch confirmed on GitHub that pull request #7 \S+ at head a1b2c3 conflicts with its base branch main and hasn't confirmed/m,
    );
    f.coordinator.conflict = undefined;
    await f.coordinator.send('Third');
    assert.doesNotMatch(f.a.inputs.at(-1)!.context ?? '', /pull request #7/);
  } finally {
    await f.coordinator.close();
  }
});
