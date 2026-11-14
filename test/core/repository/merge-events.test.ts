import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { CoordinationStore } from '../../../src/persistence/coordination.js';
import { StateStore } from '../../../src/persistence/store.js';
import type { PullRequest } from '../../../src/core/repository/repository.js';
import { expireAfterLock } from '../../fixtures/coordination.js';
import { scratch } from '../../fixtures/scratch.js';

const merged: PullRequest = {
  number: 17,
  url: 'https://github.com/example/project/pull/17',
  state: 'MERGED',
  branch: 'feat/merge-events',
  base: 'main',
  commit: 'head-23',
};

test('concurrent observers freeze one recipient set and retain the event after reopening', async () => {
  const root = await scratch('witch-merge-events-');
  const a = await CoordinationStore.open(await StateStore.open(root));
  const b = await CoordinationStore.open(await StateStore.open(root));

  const [first, second] = await Promise.all([
    a.recordMerge('project-a', merged, 'observer-a', ['a', 'b']),
    b.recordMerge('project-a', merged, 'observer-b', ['a', 'b']),
  ]);

  assert.deepEqual(first, second);

  assert.deepEqual(first.pullRequest, merged);

  assert.ok(['observer-a', 'observer-b'].includes(first.source));

  assert.deepEqual(await b.mergeEvents('project-a', 'b'), [first]);

  await b.recordMerge('project-a', merged, 'late', ['a', 'b', 'late']);

  assert.deepEqual(await a.mergeEvents('project-a', 'late'), []);

  assert.deepEqual(await a.mergeEvents('project-b', 'b'), []);

  const reopened = await CoordinationStore.open(await StateStore.open(root));

  assert.deepEqual(await reopened.mergeEvents('project-a', 'a'), [first]);
});

test('different projects, pull requests and head revisions retain distinct events', async () => {
  const store = await CoordinationStore.open(
    await StateStore.open(await scratch('witch-merge-identity-')),
  );

  const first = await store.recordMerge('project-a', merged, 'source', [
    'recipient',
  ]);

  const nextPr = await store.recordMerge(
    'project-a',
    {
      ...merged,
      number: 29,
      url: 'https://github.com/example/project/pull/29',
    },
    'source',
    ['recipient'],
  );

  const nextHead = await store.recordMerge(
    'project-a',
    { ...merged, commit: 'head-31' },
    'source',
    ['recipient'],
  );

  const other = await store.recordMerge('project-b', merged, 'source', [
    'recipient',
  ]);

  assert.equal(new Set([first.id, nextPr.id, nextHead.id, other.id]).size, 4);

  assert.deepEqual(await store.mergeEvents('project-a', 'recipient'), [
    first,
    nextPr,
    nextHead,
  ]);

  assert.deepEqual(await store.mergeEvents('project-b', 'recipient'), [other]);
});

test('a merge whose deadline passes after the lock is taken records nothing', async () => {
  const store = await CoordinationStore.open(
    await StateStore.open(await scratch('witch-merge-deadline-')),
  );

  expireAfterLock();

  await assert.rejects(
    store.recordMerge('project-a', merged, 'source', ['a']),
    /expired/,
  );

  vi.restoreAllMocks();

  assert.deepEqual(await store.mergeEvents('project-a', 'a'), []);
});
