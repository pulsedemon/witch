import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { CopilotReviewWatch } from '../src/core/copilot-review-watch.js';
import type { GitHubReviews } from '../src/core/github-reviews.js';
import { reviewSource } from './fixtures/github-reviews.js';

test('polling speeds up for requests and outstanding feedback, then returns to quiet reads', async (t) => {
  vi.useFakeTimers();
  t.onTestFinished(() => {
    vi.useRealTimers();
  });
  const source = reviewSource();
  source.requested = [
    {
      requestedReviewer: {
        __typename: 'Bot',
        login: 'copilot-pull-request-reviewer',
      },
    },
  ];
  const reads: number[] = [];
  let pending = false;
  const watch = new CopilotReviewWatch(
    '/checkout',
    async () => pending,
    assert.fail,
    async () => {
      reads.push(Date.now());
      return source;
    },
  );
  t.onTestFinished(() => watch.close());
  watch.update(source.pullRequest);
  await vi.advanceTimersByTimeAsync(0);
  const start = reads[0]!;
  source.requested = [];
  pending = true;
  await vi.advanceTimersByTimeAsync(30_000);
  pending = false;
  await vi.advanceTimersByTimeAsync(30_000);
  await vi.advanceTimersByTimeAsync(89_999);
  assert.deepEqual(
    reads.map((at) => at - start),
    [0, 30_000, 60_000],
  );
  await vi.advanceTimersByTimeAsync(1);
  assert.deepEqual(
    reads.map((at) => at - start),
    [0, 30_000, 60_000, 150_000],
  );
});

test('a newly completed check triggers another read for delayed review publication', async (t) => {
  vi.useFakeTimers();
  t.onTestFinished(() => {
    vi.useRealTimers();
  });
  const source = reviewSource();
  source.reviews = [];
  source.threads = [];
  source.checks = [
    {
      id: 1,
      name: 'copilot-pull-request-reviewer',
      status: 'completed',
      conclusion: 'success',
      head_sha: source.pullRequest.commit,
    },
  ];
  const published: number[] = [];
  let count = 0;
  const watch = new CopilotReviewWatch(
    '/checkout',
    async (value) => {
      published.push(value.reviews.length);
      return false;
    },
    assert.fail,
    async () => {
      if (++count > 1) source.reviews = reviewSource().reviews;
      return source;
    },
  );
  t.onTestFinished(() => watch.close());
  watch.update(source.pullRequest);
  await vi.advanceTimersByTimeAsync(0);
  assert.deepEqual(published, [0, 1]);
  await vi.advanceTimersByTimeAsync(90_000);
  assert.deepEqual(published, [0, 1, 1]);
});

for (const state of ['CLOSED', 'MERGED'] as const) {
  test(`a ${state} observation stops polling even when a completed check requests another read`, async (t) => {
    vi.useFakeTimers();
    t.onTestFinished(() => {
      vi.useRealTimers();
    });
    const source = reviewSource();
    source.checks = [
      {
        id: 1,
        name: 'copilot-pull-request-reviewer',
        status: 'completed',
        conclusion: 'success',
        head_sha: source.pullRequest.commit,
      },
    ];
    const observations: string[] = [];
    let reads = 0;
    const watch = new CopilotReviewWatch(
      '/checkout',
      async (value) => {
        observations.push(value.pullRequest.state);
        return true;
      },
      assert.fail,
      async () => {
        reads++;
        return { ...source, pullRequest: { ...source.pullRequest, state } };
      },
    );
    t.onTestFinished(() => watch.close());
    watch.update(source.pullRequest);
    await vi.advanceTimersByTimeAsync(180_000);
    watch.refresh();
    await vi.advanceTimersByTimeAsync(180_000);
    assert.deepEqual(observations, [state]);
    assert.equal(reads, 1);
  });
}

test.each(['switch', 'close'])(
  'an old read cannot publish after %s',
  async (kind) => {
    const source = reviewSource();
    const pending = Promise.withResolvers<GitHubReviews>();
    const published: string[] = [];
    let calls = 0;
    let firstSignal: AbortSignal | undefined;
    const watch = new CopilotReviewWatch(
      '/checkout',
      async (value) => {
        published.push(value.pullRequest.url);
        return false;
      },
      assert.fail,
      async (_pr, _cwd, signal) => {
        if (++calls === 1) {
          firstSignal = signal;
          return pending.promise;
        }
        return {
          ...source,
          pullRequest: {
            ...source.pullRequest,
            url: 'https://github.com/team/project/pull/13',
            number: 13,
          },
        };
      },
    );
    watch.update(source.pullRequest);
    if (kind === 'close') watch.close();
    else
      watch.update({
        ...source.pullRequest,
        url: 'https://github.com/team/project/pull/13',
        number: 13,
      });
    assert.equal(firstSignal!.aborted, true);
    pending.resolve(source);
    await pending.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    watch.close();
    assert.deepEqual(
      published,
      kind === 'close' ? [] : ['https://github.com/team/project/pull/13'],
    );
  },
);

test('refresh requests coalesce while a read is running', async () => {
  const source = reviewSource();
  const pending = Promise.withResolvers<GitHubReviews>();
  let reads = 0;
  const publications: number[] = [];
  const watch = new CopilotReviewWatch(
    '/checkout',
    async () => {
      publications.push(reads);
      return false;
    },
    assert.fail,
    async () => (++reads === 1 ? pending.promise : source),
  );
  watch.update(source.pullRequest);
  watch.refresh();
  watch.refresh();
  assert.equal(reads, 1);
  pending.resolve(source);
  await pending.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  watch.close();
  assert.deepEqual(publications, [1, 2]);
});

test('repeated read errors do not erase published work or repeat the notice', async (t) => {
  vi.useFakeTimers();
  t.onTestFinished(() => {
    vi.useRealTimers();
  });
  const source = reviewSource();
  const publications: string[] = [];
  const notices: string[] = [];
  let fail = false;
  const watch = new CopilotReviewWatch(
    '/checkout',
    async (value) => {
      publications.push(value.threads[0]!.id);
      return true;
    },
    (text) => notices.push(text),
    async () => {
      if (fail) throw new Error('network unavailable');
      return source;
    },
  );
  t.onTestFinished(() => watch.close());
  watch.update(source.pullRequest);
  await vi.advanceTimersByTimeAsync(0);
  fail = true;
  await vi.advanceTimersByTimeAsync(60_000);
  assert.deepEqual(publications, ['thread-1']);
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /network unavailable/);
  fail = false;
  await vi.advanceTimersByTimeAsync(30_000);
  assert.deepEqual(publications, ['thread-1', 'thread-1']);
  assert.equal(notices.length, 2);
});
