import assert from 'node:assert/strict';

import { test, vi } from 'vitest';

import * as commands from '../src/core/command.js';

import { callControl } from '../src/persistence/control.js';

import { selectionTurn } from './fixtures/task-selection.js';

import type { GitHubReviews } from '../src/core/github-reviews.js';

import {
  unitCoordinationFixture,
  git,
  pauseDiscovery,
} from './fixtures/coordination.js';

import { reviewSource } from './fixtures/github-reviews.js';

import { orderedCleanup } from './fixtures/cleanup.js';

import { repositoryRead } from './fixtures/repository.js';

type Fixture = Awaited<ReturnType<typeof unitCoordinationFixture>>;

type Client = Awaited<ReturnType<Fixture['start']>>;

async function attach(f: Fixture, client: Client, source: GitHubReviews) {
  const cwd = client.coordinator.snapshot.conversation!.cwd;

  await git(
    '-C',
    cwd,
    'symbolic-ref',
    'HEAD',
    `refs/heads/${source.pullRequest.branch}`,
  );

  const project = (await f.memory.scopePaths(cwd)).project;

  client.coordination.updateRepository(
    repositoryRead({
      branch: source.pullRequest.branch,
      pullRequest: source.pullRequest,
      pullRequestProject: project,
    }),
  );

  return cwd;
}

test('binding an issue claim adds the PR alias and records assignment without replacing its identity', async (t) => {
  const f = await unitCoordinationFixture(
    orderedCleanup(t.onTestFinished),
    async (references) => ({ assigned: references }),
  );

  const a = await f.start('A');

  const source = reviewSource();

  await attach(f, a, source);

  const claimed = await a.claim(source.closingIssues[0]!, 'finish the fix');

  assert.equal(claimed.kind, 'claimed');

  if (claimed.kind !== 'claimed') assert.fail();

  const result = await a.coordination.reviews.bind(
    source.pullRequest,
    source.closingIssues,
  );

  assert.equal(result!.claim.id, claimed.claim.id);

  assert.equal(result!.claim.summary, 'finish the fix');

  assert.deepEqual(result!.claim.references, [
    'github:team/project#4',
    'github:team/project#12',
  ]);

  assert.deepEqual(result!.claim.assigned, [
    'github:team/project#4',
    'github:team/project#12',
  ]);

  assert.equal(
    await a.coordination.reviews.owns(result!.claim.id, source.pullRequest),
    true,
  );

  await a.coordination.reviews.bind(source.pullRequest, source.closingIssues);

  const saved = (await f.registry.claims()).find(
    ({ id }) => id === claimed.claim.id,
  )!;

  assert.deepEqual(saved.references, [
    'github:team/project#4',
    'github:team/project#12',
  ]);
});

test('binding refuses a stale summary and retries with the current claim', async (t) => {
  const f = await unitCoordinationFixture(
    orderedCleanup(t.onTestFinished),
    async (references) => ({ assigned: references }),
  );

  const a = await f.start('A');

  const source = reviewSource();

  await attach(f, a, source);

  await a.claim(source.closingIssues[0]!, 'old summary');

  const entered = Promise.withResolvers<void>();

  const released = Promise.withResolvers<void>();

  const run = commands.runCommand;

  let held = false;

  vi.spyOn(commands, 'runCommand').mockImplementation(
    async (command, args, options) => {
      if (command === 'git' && args.includes('symbolic-ref') && !held) {
        held = true;

        entered.resolve();

        await released.promise;
      }

      return run(command, args, options);
    },
  );

  const binding = a.coordination.reviews.bind(
    source.pullRequest,
    source.closingIssues,
  );

  const rejected = assert.rejects(binding, /ownership changed/);

  await entered.promise;

  try {
    await a.claim(source.closingIssues[0]!, 'new summary');
  } finally {
    released.resolve();
  }

  await rejected;

  const saved = (await f.registry.claims())[0]!;

  assert.equal(saved.summary, 'new summary');

  assert.deepEqual(saved.references, ['github:team/project#4']);

  const fresh = await a.coordination.reviews.bind(
    source.pullRequest,
    source.closingIssues,
  );

  assert.equal(fresh!.claim.summary, 'new summary');

  assert.deepEqual(fresh!.claim.references, [
    'github:team/project#4',
    'github:team/project#12',
  ]);
});

test('another PR owner refuses alias binding without transfer or loss of either claim', async (t) => {
  const f = await unitCoordinationFixture(orderedCleanup(t.onTestFinished));

  const a = await f.start('A');

  const b = await f.start('B');

  const source = reviewSource();

  await attach(f, a, source);

  const issue = await a.claim(source.closingIssues[0]!);

  const owner = await b.claim(source.pullRequest.url);

  assert.equal(issue.kind, 'claimed');

  assert.equal(owner.kind, 'claimed');

  await assert.rejects(
    a.coordination.reviews.bind(source.pullRequest, source.closingIssues),
    /already reserved/,
  );

  const claims = await f.registry.claims();

  assert.equal(claims.length, 2);

  assert.deepEqual(claims.map(({ references }) => references).sort(), [
    ['github:team/project#12'],
    ['github:team/project#4'],
  ]);

  assert.ok(
    claims.every(
      ({ transfer, automaticTransfer }) => !transfer && !automaticTransfer,
    ),
  );
});

test('an unrelated task is never replaced by the branch PR', async (t) => {
  const f = await unitCoordinationFixture(orderedCleanup(t.onTestFinished));

  const a = await f.start('A');

  const source = reviewSource();

  await attach(f, a, source);

  await a.claim('task:unrelated');

  assert.equal(
    await a.coordination.reviews.bind(source.pullRequest, source.closingIssues),
    undefined,
  );

  assert.equal((await f.registry.claims()).length, 1);

  assert.match((await f.registry.claims())[0]!.references[0]!, /:unrelated$/);
});

test('fresh Git state rejects a changed branch even while the displayed status is stale', async (t) => {
  const f = await unitCoordinationFixture(orderedCleanup(t.onTestFinished));

  const a = await f.start('A');

  const source = reviewSource();

  const cwd = await attach(f, a, source);

  await a.claim(source.pullRequest.url);

  const bound = await a.coordination.reviews.bind(source.pullRequest, []);

  await git('-C', cwd, 'symbolic-ref', 'HEAD', 'refs/heads/other-work');

  assert.equal(
    await a.coordination.reviews.owns(bound!.claim.id, source.pullRequest),
    false,
  );

  assert.equal(
    await a.coordination.reviews.bind(source.pullRequest, []),
    undefined,
  );
});

test('failed GitHub assignment leaves usable ownership and retries only on an explicit claim', async (t) => {
  let writes = 0;

  const f = await unitCoordinationFixture(
    orderedCleanup(t.onTestFinished),
    async (references) => {
      writes++;

      return references.includes('github:team/project#12')
        ? { assigned: [], failure: 'GitHub unavailable' }
        : { assigned: references };
    },
  );

  const a = await f.start('A');

  const source = reviewSource();

  await attach(f, a, source);

  await a.claim(source.closingIssues[0]!);

  const result = await a.coordination.reviews.bind(
    source.pullRequest,
    source.closingIssues,
  );

  assert.match(result!.warning!, /GitHub unavailable/);

  assert.equal(
    await a.coordination.reviews.owns(result!.claim.id, source.pullRequest),
    true,
  );

  assert.deepEqual(result!.claim.assigned, ['github:team/project#4']);

  const before = writes;

  const reread = await a.coordination.reviews.bind(
    source.pullRequest,
    source.closingIssues,
  );

  assert.equal(reread!.warning, undefined);

  assert.equal(writes, before);

  assert.equal((await a.claim(source.pullRequest.url)).kind, 'claimed');

  assert.equal(writes, before + 1);
});

test('closed PRs do not bind even if the local status still says open', async (t) => {
  const f = await unitCoordinationFixture(orderedCleanup(t.onTestFinished));

  const a = await f.start('A');

  const source = reviewSource();

  await attach(f, a, source);

  await a.claim(source.closingIssues[0]!);

  assert.equal(
    await a.coordination.reviews.bind(
      { ...source.pullRequest, state: 'CLOSED' },
      source.closingIssues,
    ),
    undefined,
  );

  assert.deepEqual((await f.registry.claims())[0]!.references, [
    'github:team/project#4',
  ]);
});

test('a solo PR suggestion binds only after the requested claim promotion', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);

  const f = await unitCoordinationFixture(cleanup, async (references) => ({
    assigned: references,
  }));

  const a = await f.start('A');

  const source = reviewSource();

  await attach(f, a, source);

  const selecting = await selectionTurn(cleanup, a);

  const { ticket } = await selecting.select();

  const suggested = await callControl(await a.binding(), {
    kind: 'recommend',
    selection: ticket.id,
    input: { reference: source.pullRequest.url, summary: 'Review this PR' },
  });

  assert.equal(suggested.kind, 'claimed');

  await selecting.finish();

  const context = await a.coordination.context();

  assert.deepEqual(context.snapshot.peers, []);

  assert.ok(context.snapshot.ownClaim!.suggestion);

  assert.match(
    context.context,
    /Open pull requests still need an active claim/,
  );

  assert.match(
    context.instructions,
    /Promote its suggestion to an active claim for Copilot watching/,
  );

  assert.equal(
    await a.coordination.reviews.bind(source.pullRequest, []),
    undefined,
  );

  assert.equal((await a.claim(source.pullRequest.url)).kind, 'claimed');

  const bound = await a.coordination.reviews.bind(source.pullRequest, []);

  assert.equal(bound!.claim.id, context.snapshot.ownClaim!.id);

  assert.equal(bound!.claim.suggestion, undefined);
});

test("an ownership check given the turn's project reads no scope", async (t) => {
  pauseDiscovery(vi.spyOn);

  const f = await unitCoordinationFixture(orderedCleanup(t.onTestFinished));

  const a = await f.start('A');

  const source = reviewSource();

  const cwd = await attach(f, a, source);

  const claimed = await a.claim(source.pullRequest.url, 'review fixes');

  assert.equal(claimed.kind, 'claimed');

  if (claimed.kind !== 'claimed') assert.fail();

  const { project } = await f.memory.scopePaths(cwd);

  const reads = vi.spyOn(f.memory, 'scopePaths');

  const { reviews } = a.coordination;

  assert.equal(
    await reviews.owns(claimed.claim.id, source.pullRequest, project),
    true,
  );

  assert.equal(reads.mock.calls.length, 0);

  assert.equal(await reviews.owns(claimed.claim.id, source.pullRequest), true);

  assert.deepEqual(
    reads.mock.calls.map(([directory]) => directory),
    [cwd],
  );
});
