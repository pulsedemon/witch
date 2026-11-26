import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'vitest';
import {
  configValue,
  fastForward,
  gitIn,
  unlessExit1,
} from '../../../src/core/repository/checkout-git.js';
import type { CheckoutProgress } from '../../../src/core/repository/checkout-git.js';
import { git, identity } from '../../fixtures/git.js';
import { merge, merged, withGit } from '../../fixtures/merged.js';
import { configureGitEnvironment } from '../../fixtures/merged-environment.js';

configureGitEnvironment();

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

for (const mode of ['ahead', 'behind', 'annotated tag'])
  test(`fastForward checkpoints HEAD when the base is ${mode}`, async () => {
    const { checkout, other } = await merged();
    await git(checkout, 'switch', 'main');
    let target: string;

    if (mode === 'ahead') {
      await git(checkout, 'commit', '--allow-empty', '-m', 'local');
      target = await git(checkout, 'rev-parse', 'HEAD');
      assert.notEqual(target, await git(checkout, 'rev-parse', 'origin/main'));
    } else {
      await merge(other, 'feat/x');
      target = await git(other, 'rev-parse', 'HEAD');

      if (mode === 'annotated tag') {
        await git(checkout, 'fetch');
        await git(checkout, 'tag', '-a', 'release', '-m', 'release', target);
        await git(checkout, 'config', 'branch.main.remote', '.');
        await git(checkout, 'config', 'branch.main.merge', 'refs/tags/release');
        assert.notEqual(await git(checkout, 'rev-parse', 'release'), target);
      }
    }

    const progress: CheckoutProgress = {};
    assert.equal(await fastForward(gitIn(checkout), 'main', progress), true);
    assert.equal(await git(checkout, 'rev-parse', 'HEAD'), target);
    assert.deepEqual(progress, { head: target, target, done: true });
  });

test('fastForward refuses a base committed ahead during its ancestry read', async () => {
  const { root, checkout, other } = await merged();
  await git(checkout, 'switch', 'main');
  await merge(other, 'feat/x');
  const target = await git(other, 'rev-parse', 'HEAD');
  const marker = join(root, 'advanced');
  const progress: CheckoutProgress = {};

  const result = await withGit(
    root,
    `if (args[0] === 'merge-base' && !existsSync(${JSON.stringify(marker)})) {
  writeFileSync(${JSON.stringify(marker)}, '');
  if (run([...${JSON.stringify(identity)}, 'merge', '--ff-only', ${JSON.stringify(target)}], 'ignore').status) process.exit(1);
  if (run([...${JSON.stringify(identity)}, 'commit', '--allow-empty', '-m', 'competing'], 'ignore').status) process.exit(1);
}`,
    () => fastForward(gitIn(checkout), 'main', progress),
  );

  assert.equal(result, false);
  const head = await git(checkout, 'rev-parse', 'HEAD');
  assert.notEqual(head, target);
  assert.equal(await git(checkout, 'rev-parse', 'HEAD~1'), target);
  assert.equal(await git(checkout, 'branch', '--show-current'), 'main');
  assert.equal(progress.head, undefined);
  assert.equal(progress.target, undefined);
  assert.equal(progress.done, undefined);
});
