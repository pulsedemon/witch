import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'vitest';
import type { TestContext } from 'vitest';
import { watchMerges } from '../../../src/core/repository/merge-watch.js';
import type { Repository } from '../../../src/core/repository/repository.js';
import { callControl } from '../../../src/persistence/control.js';
import { orderedCleanup } from '../../fixtures/cleanup.js';
import { unitCoordinationFixture } from '../../fixtures/coordination.js';
import { git } from '../../fixtures/git.js';
import { withGh } from '../../fixtures/merged.js';
import { notices } from '../../fixtures/coordinator.js';
import { record } from '../../fixtures/copilot-reviews.js';
import { pullRequest, repositoryRead } from '../../fixtures/repository.js';
import { until } from '../../fixtures/within.js';

const parentUrl = 'https://github.com/o/r/pull/7';
const childUrl = 'https://github.com/o/r/pull/8';
const issueUrl = 'https://github.com/o/r/issues/6';

async function stack(t: TestContext) {
  const cleanup = orderedCleanup(t.onTestFinished);

  const f = await unitCoordinationFixture(cleanup, async (references) => ({
    assigned: references,
  }));

  const cwd = join(f.root, 'A');
  const origin = join(f.root, 'stack.git');
  const other = join(f.root, 'merger');
  await git(f.root, 'init', '--bare', origin);
  await git(cwd, 'remote', 'set-url', 'origin', origin);
  await git(cwd, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  await writeFile(join(cwd, 'shared.txt'), 'base\n');
  await git(cwd, 'add', '.');
  await git(cwd, 'commit', '-m', 'base');
  await git(cwd, 'push', '-u', 'origin', 'main');
  await git(cwd, 'switch', '-c', 'feat/parent');
  await writeFile(join(cwd, 'shared.txt'), 'parent\n');
  await git(cwd, 'commit', '-am', 'parent');
  await git(cwd, 'push', '-u', 'origin', 'feat/parent');
  const parentHead = await git(cwd, 'rev-parse', 'HEAD');
  await git(cwd, 'switch', '-c', 'feat/child');
  await writeFile(join(cwd, 'child.txt'), 'child\n');
  await git(cwd, 'add', '.');
  await git(cwd, 'commit', '-m', 'child');
  await git(cwd, 'push', '-u', 'origin', 'feat/child');
  const childHead = await git(cwd, 'rev-parse', 'HEAD');
  await git(f.root, 'clone', origin, other);
  const x = await f.start('A');
  const c = x.coordinator;
  const project = (await f.memory.scopePaths(cwd)).project;

  let parent = pullRequest({
    url: parentUrl,
    branch: 'feat/parent',
    commit: parentHead,
    mergeable: 'MERGEABLE',
  });

  let current = repositoryRead({
    branch: 'feat/child',
    commit: childHead,
    pullRequestProject: project,
    pullRequest: pullRequest({
      number: 8,
      url: childUrl,
      branch: 'feat/child',
      commit: childHead,
      base: 'feat/parent',
      mergeable: 'MERGEABLE',
    }),
  });

  const listeners = new Set<() => void>();

  const observe = (read: Repository) => {
    current = read;
    x.coordination.updateRepository(read);
    c.conflict = read.conflict;
    c.repair.observe(read);
    listeners.forEach((listener) => listener());
  };

  const watch = {
    get snapshot() {
      return current;
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    unfollow: () => {},
  };

  const stopMerges = watchMerges(watch, c);
  t.onTestFinished(stopMerges);

  c.repair.setRefresh(async () => {
    observe(current);
  });

  const claimed = await callControl(await x.binding(), {
    kind: 'claim',
    input: {
      reference: parentUrl,
      aliases: [childUrl, issueUrl, 'task:continuing'],
      summary:
        'Maintain the stack through integration and continue the other task',
    },
  });

  if (claimed.kind !== 'claimed') assert.fail(JSON.stringify(claimed));

  observe(current);
  await c.send('Maintain the parent and child through integration into main');
  assert.deepEqual((await x.query()).ownClaim, claimed.claim);

  const mergeChild = async () => {
    await git(other, 'switch', 'feat/parent');

    await git(
      other,
      'merge',
      '--no-ff',
      '-m',
      'merge child',
      'origin/feat/child',
    );

    await git(other, 'push', 'origin', 'feat/parent');
    await git(other, 'push', 'origin', '--delete', 'feat/child');
    parent = { ...parent, commit: await git(other, 'rev-parse', 'HEAD') };

    await withGh(
      f.root,
      '[ "$1 $2" = "api graphql" ] || exit 1\nprintf "true\\nmain\\nfalse\\n"',
      async () => {
        observe({
          ...current,
          pullRequest: pullRequest({
            ...current.pullRequest!,
            state: 'MERGED',
          }),
        });

        await until(
          'child cleanup',
          () =>
            notices(c).includes(
              '#8 merged: switched to feat/parent and pulled, deleted branch feat/child.',
            ),
          500,
        ).catch((error: unknown) => {
          throw new Error(
            JSON.stringify({
              phase: c.snapshot.phase,
              error: c.snapshot.error,
              notices: notices(c),
              current,
            }),
            { cause: error },
          );
        });

        await until('cleanup settled', () => c.snapshot.phase === 'idle');
      },
    );

    assert.equal(await git(cwd, 'branch', '--show-current'), 'feat/parent');
    assert.equal(await git(cwd, 'rev-parse', 'HEAD'), parent.commit);

    assert.equal(
      await git(
        cwd,
        'for-each-ref',
        '--format=%(refname)',
        'refs/heads/feat/child',
      ),
      '',
    );

    observe(
      repositoryRead({
        branch: 'feat/parent',
        commit: parent.commit,
        pullRequest: parent,
        pullRequestProject: project,
      }),
    );

    assert.deepEqual((await x.query()).ownClaim, claimed.claim);
  };

  const conflict = async () => {
    await git(other, 'switch', 'main');
    await writeFile(join(other, 'shared.txt'), 'main\n');
    await git(other, 'commit', '-am', 'conflicting main');
    await git(other, 'push', 'origin', 'main');
    await git(cwd, 'fetch', 'origin');

    await assert.rejects(
      git(cwd, 'merge-tree', '--write-tree', 'HEAD', 'origin/main'),
      { code: 1 },
    );

    const baseTip = await git(other, 'rev-parse', 'HEAD');
    parent = { ...parent, mergeable: 'CONFLICTING' };

    observe({
      ...current,
      pullRequest: parent,
      conflict: { pullRequest: parent, baseTip },
    });

    return baseTip;
  };

  const repairs = () =>
    x.a.inputs.filter(({ prompt }) =>
      prompt.startsWith('Witch started this turn to repair the merge conflict'),
    );

  return {
    f,
    x,
    c,
    project,
    claim: claimed.claim,
    mergeChild,
    conflict,
    repairs,
    observe: () => observe(current),
    parent: () => parent,
  };
}

test('a child merge preserves the parent claim and automatically admits its later conflict repair', async (t) => {
  const s = await stack(t);
  await s.mergeChild();
  const baseTip = await s.conflict();
  await until('parent repair', () => s.repairs().length === 1);
  await until('repair settled', () => s.c.snapshot.phase === 'idle');
  const repair = s.repairs()[0]!;
  assert.equal(repair.author, 'witch');

  assert.ok(
    repair.prompt.includes(
      `${parentUrl}: head ${s.parent().commit} conflicts with main, whose tip was ${baseTip}`,
    ),
  );

  assert.deepEqual((await s.x.query()).ownClaim, s.claim);

  assert.deepEqual((await record(s.f, s.x)).conflictRepairs, [
    { url: parentUrl, commit: s.parent().commit, base: 'main' },
  ]);

  s.observe();
  assert.equal(s.c.repair.ready(), false);
  assert.equal(s.repairs().length, 1);
});

test('releasing a parent and its closing issue after child cleanup prevents rebinding and repair', async (t) => {
  const s = await stack(t);
  await s.mergeChild();

  const released = await callControl(await s.x.binding(), {
    kind: 'release-references',
    claim: s.claim.id,
    references: [parentUrl, childUrl, issueUrl],
  });

  assert.equal(released.kind, 'references-released');
  await s.conflict();

  assert.equal(
    await s.x.coordination.reviews.bind(s.parent(), [issueUrl]),
    undefined,
  );

  await s.c.send('Continue only the separate continuing task');
  const claim = (await s.x.query()).ownClaim;
  assert.equal(claim?.id, s.claim.id);
  assert.deepEqual(claim.references, [`task:${s.project}:continuing`]);
  assert.equal(s.c.repair.ready(), false);
  assert.deepEqual(s.repairs(), []);
});

test('a stop after child cleanup holds parent repair until the next user prompt', async (t) => {
  const s = await stack(t);
  await s.mergeChild();
  await s.c.interrupt();
  await s.conflict();
  await delay(100);
  assert.deepEqual(s.repairs(), []);
  assert.deepEqual((await s.x.query()).ownClaim, s.claim);
  await s.c.send('Resume the authorized stack maintenance');
  await until('resumed parent repair', () => s.repairs().length === 1);
  await until('resumed repair settled', () => s.c.snapshot.phase === 'idle');
  assert.equal(s.repairs()[0]!.author, 'witch');
  assert.deepEqual((await s.x.query()).ownClaim, s.claim);
});
