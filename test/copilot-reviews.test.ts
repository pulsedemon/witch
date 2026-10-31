import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'vitest';
import {
  blockReviewBatch,
  observeReviews,
  reconcileReviews,
  reviewInstruction,
  reviewResultSchema,
} from '../src/core/copilot-reviews.js';
import type { ReviewBatch, ReviewResult } from '../src/core/copilot-reviews.js';
import {
  clearConversationContext,
  conversationRecordSchema,
} from '../src/core/state.js';
import { StateStore } from '../src/persistence/store.js';
import { reviewSource } from './fixtures/github-reviews.js';
import { scratch } from './fixtures/scratch.js';

function fixture() {
  const source = reviewSource();
  const state = observeReviews(undefined, source);
  const batch: ReviewBatch = {
    id: randomUUID(),
    claim: randomUUID(),
    owner: 'conversation',
    pullRequest: source.pullRequest,
    items: state.items.map(({ id, version }) => ({ id, version })),
    packet: '/scratch/review-input.json',
    result: '/scratch/review-result.json',
  };
  state.batch = batch;
  for (const item of state.items) item.status = 'attempted';
  const commit = 'b'.repeat(40);
  const response = {
    id: 'response-1',
    body: `fixed in https://github.com/team/project/commit/${commit}`,
    url: `${source.pullRequest.url}#discussion_r2`,
    author: { __typename: 'User', login: 'owner' },
    createdAt: '2026-10-30T23:01:00Z',
    updatedAt: '2026-10-30T23:01:00Z',
    pullRequestReview: null,
  };
  source.threads[0]!.comments.push(response);
  const result: ReviewResult = {
    batch: batch.id,
    items: [
      {
        ...batch.items[0]!,
        disposition: 'covered',
        threads: ['thread-1'],
        reason: 'the summary repeats its inline finding',
      },
      { ...batch.items[1]!, disposition: 'fixed', reply: response.url, commit },
    ],
  };
  return { source, state, batch, result, response, commit };
}

test('a pushed fix and its thread reply cover a summary without another response', async () => {
  const f = fixture();
  const result = await reconcileReviews(
    f.state,
    f.batch,
    f.result,
    f.source,
    async (commit) => commit === 'b'.repeat(40),
  );
  assert.deepEqual(
    result.items.map(({ id, status }) => [id, status]),
    [
      ['review-1', 'handled'],
      ['thread-1', 'handled'],
    ],
  );
  assert.equal(result.batch, undefined);
  assert.equal(f.state.items[0]!.status, 'attempted');
  assert.equal(result.items[1]!.receipts[0]!.disposition, 'fixed');
});

test('a handled finding stays handled through rereads, head updates and human replies', async () => {
  const f = fixture();
  const handled = await reconcileReviews(
    f.state,
    f.batch,
    f.result,
    f.source,
    async () => true,
  );
  f.source.pullRequest.commit = 'c'.repeat(40);
  f.source.threads[0]!.isResolved = true;
  f.source.threads[0]!.comments.push({
    ...f.response,
    id: 'response-2',
    body: 'checked again',
  });
  const observed = observeReviews(handled, f.source);
  assert.deepEqual(
    observed.items.map(({ status }) => status),
    ['handled', 'handled'],
  );
  assert.equal(observed.items[1]!.version, handled.items[1]!.version);
});

test.each(['edit', 'new comment'])(
  'new Copilot content queues work and retains the prior disposition: %s',
  async (kind) => {
    const f = fixture();
    const handled = await reconcileReviews(
      f.state,
      f.batch,
      f.result,
      f.source,
      async () => true,
    );
    if (kind === 'edit')
      f.source.threads[0]!.comments[0]!.body =
        'The deadline check still runs too late.';
    else
      f.source.threads[0]!.comments.push({
        ...f.source.threads[0]!.comments[0]!,
        id: 'followup',
        body: 'Check the final response too.',
      });
    const observed = observeReviews(handled, f.source);
    assert.equal(observed.items[1]!.status, 'pending');
    assert.notEqual(observed.items[1]!.version, handled.items[1]!.version);
    assert.equal(observed.items[1]!.receipts[0]!.disposition, 'fixed');
  },
);

test('a result for an older content version cannot handle a finding edited during its turn', async () => {
  const f = fixture();
  f.source.threads[0]!.comments[0]!.body = 'New evidence after dispatch.';
  const changed = observeReviews(f.state, f.source);
  const result = await reconcileReviews(
    changed,
    f.batch,
    f.result,
    f.source,
    async () => true,
  );
  assert.equal(result.items[1]!.status, 'pending');
  assert.equal(
    result.items[1]!.receipts[0]!.version,
    f.batch.items[1]!.version,
  );
  assert.equal(result.items[0]!.status, 'handled');
});

test.each([
  [true, 'handled'],
  [false, 'blocked'],
] as const)(
  'a repeated content version retains its verified disposition (pushed: %s)',
  async (pushed, expected) => {
    const f = fixture();
    const settled = await reconcileReviews(
      f.state,
      f.batch,
      f.result,
      f.source,
      async () => pushed,
    );
    f.source.threads[0]!.comments[0]!.body = 'A revised finding.';
    const edited = observeReviews(settled, f.source);
    assert.equal(edited.items[1]!.status, 'pending');
    f.source.threads[0]!.comments[0]!.body = 'The retry crosses the deadline.';
    const repeated = observeReviews(edited, f.source);
    assert.equal(repeated.items[1]!.status, expected);
    assert.equal(repeated.items[1]!.receipts.length, 1);
    if (!pushed) assert.match(repeated.items[1]!.reason!, /not on the remote/);
  },
);

test.each(['not pushed', 'no commit link', 'wrong author', 'wrong thread'])(
  'an unverifiable fix remains blocked: %s',
  async (kind) => {
    const f = fixture();
    if (kind === 'no commit link') f.response.body = 'fixed';
    if (kind === 'wrong author') f.response.author.login = 'someone-else';
    if (kind === 'wrong thread') {
      f.source.threads[0]!.comments.pop();
      f.source.comments.push(f.response);
    }
    const result = await reconcileReviews(
      f.state,
      f.batch,
      f.result,
      f.source,
      async () => kind !== 'not pushed',
    );
    assert.deepEqual(
      result.items.map(({ status }) => status),
      ['blocked', 'blocked'],
    );
    assert.ok(result.items[1]!.reason);
  },
);

test('an existing thread response can be acknowledged without another post', async () => {
  const f = fixture();
  f.result.items[1] = {
    ...f.batch.items[1]!,
    disposition: 'already-addressed',
    reply: f.response.url,
    reason: 'the pushed code and earlier reply already address it',
  };
  const result = await reconcileReviews(
    f.state,
    f.batch,
    f.result,
    f.source,
    async () => {
      throw new Error('no new fix');
    },
  );
  assert.equal(result.items[1]!.status, 'handled');
  assert.equal(result.items[1]!.receipts[0]!.disposition, 'already-addressed');
});

test('a summary response must link its own source, even when the reply is on the same PR', async () => {
  const f = fixture();
  const top = {
    ...f.response,
    url: `${f.source.pullRequest.url}#issuecomment-1`,
    body: 'see another review',
  };
  f.source.comments.push(top);
  f.result.items[0] = {
    ...f.batch.items[0]!,
    disposition: 'declined',
    reply: top.url,
    reason: 'current code already guards this path',
  };
  let result = await reconcileReviews(
    f.state,
    f.batch,
    f.result,
    f.source,
    async () => true,
  );
  assert.equal(result.items[0]!.status, 'blocked');
  top.body = `declined: ${f.source.reviews[0]!.url} is already guarded`;
  result = await reconcileReviews(
    f.state,
    f.batch,
    f.result,
    f.source,
    async () => true,
  );
  assert.equal(result.items[0]!.status, 'handled');
});

test.each(['another batch', 'unknown item', 'duplicate item'])(
  'foreign or ambiguous results refuse settlement: %s',
  async (kind) => {
    const f = fixture();
    if (kind === 'another batch') f.result.batch = randomUUID();
    if (kind === 'unknown item') f.result.items[0]!.id = 'unrelated';
    if (kind === 'duplicate item') f.result.items.push(f.result.items[1]!);
    await assert.rejects(
      reconcileReviews(f.state, f.batch, f.result, f.source, async () => true),
      /another batch|duplicate or unknown/,
    );
    assert.ok(f.state.items.every(({ status }) => status === 'attempted'));
  },
);

test('partial results retain missing findings as visible blockers', async () => {
  const f = fixture();
  f.result.items = [f.result.items[1]!];
  const result = await reconcileReviews(
    f.state,
    f.batch,
    f.result,
    f.source,
    async () => true,
  );
  assert.deepEqual(
    result.items.map(({ status }) => status),
    ['blocked', 'handled'],
  );
  assert.match(result.items[0]!.reason!, /did not return/);
});

test('an interrupted batch retains its identity and does not consume later feedback', () => {
  const f = fixture();
  f.source.comments.push({
    ...f.source.threads[0]!.comments[0]!,
    id: 'late-comment',
  });
  const result = blockReviewBatch(
    observeReviews(f.state, f.source),
    'interrupted',
  );
  assert.equal(result.batch?.id, f.batch.id);
  assert.equal(
    result.items.find(({ id }) => id === 'late-comment')!.status,
    'pending',
  );
  assert.equal(
    result.items.find(({ id }) => id === 'thread-1')!.status,
    'blocked',
  );
});

test('reopen and context clear retain receipts while older records still parse', async (t) => {
  const root = await scratch('witch-review-record-');
  const store = await StateStore.open(root);
  const f = fixture();
  const record = conversationRecordSchema.parse({
    id: 'review-owner',
    title: 'review',
    cwd: '/checkout',
    agent: 'codex',
    sessions: {},
    createdAt: '2026-10-30T00:00:00Z',
  });
  assert.equal(record.copilotReviews, undefined);
  const files = await store.create(record);
  t.onTestFinished(() => files.close());
  record.copilotReviews = await reconcileReviews(
    f.state,
    f.batch,
    f.result,
    f.source,
    async () => true,
  );
  clearConversationContext(record);
  await files.save(record);
  await files.close();
  const reopened = await store.claim(record.id);
  t.onTestFinished(() => reopened.close());
  assert.deepEqual(
    reopened.record.copilotReviews!.items.map(({ status }) => status),
    ['handled', 'handled'],
  );
  assert.equal(reopened.record.sessions.codex!.hasHistory, false);
});

test('the result schema and instruction keep source bodies out of native input', () => {
  const f = fixture();
  assert.ok(reviewResultSchema.safeParse(f.result).success);
  assert.equal(
    reviewResultSchema.safeParse({
      batch: f.batch.id,
      items: [
        { ...f.batch.items[0], disposition: 'fixed', reply: f.response.url },
      ],
    }).success,
    false,
  );
  const prompt = reviewInstruction(f.batch);
  assert.ok(prompt.includes(f.batch.packet));
  assert.ok(prompt.includes(f.batch.result));
  assert.ok(!prompt.includes(f.source.reviews[0]!.body));
  assert.ok(!prompt.includes(f.source.threads[0]!.comments[0]!.body));
});
