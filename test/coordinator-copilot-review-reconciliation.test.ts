import assert from 'node:assert/strict';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { test, vi } from 'vitest';
import * as github from '../src/core/github-reviews.js';
import type { GitHubReviews } from '../src/core/github-reviews.js';
import type { ReviewBatch, ReviewResult } from '../src/core/copilot-reviews.js';
import { callControl } from '../src/persistence/control.js';
import { answerInstruction } from '../src/core/peer-requests.js';
import { TurnGate } from './fixtures/agent.js';
import { git } from './fixtures/coordination.js';
import { autoReply, record, reply, setup } from './fixtures/copilot-reviews.js';
import { reviewSource } from './fixtures/github-reviews.js';
import { until, within } from './fixtures/within.js';

test('a missing result after restart stays blocked until a user prompt reconciles the existing reply', async (t) => {
  const x = await setup(t);
  const gate = new TurnGate();

  x.a.a.gate = gate;

  autoReply(x.f, x.a, x.source);

  await x.observe();

  await within(gate.entered, 5000, 'review dispatch');

  const id = x.c.snapshot.conversation!.id;
  const oldBatch = (await record(x.f, x.a)).copilotReviews![0]!.batch!;

  await unlink(oldBatch.result);

  const replies = structuredClone(x.source.threads[0]!.comments);

  await x.c.close({ restart: true });

  const reopened = await x.f.start('A', { conversation: id });

  reopened.coordination.updateRepository(x.repository);

  reopened.coordinator.copilot.updateRepository(x.repository);

  await reopened.coordinator.copilot.observe(structuredClone(x.source));

  const blocked = (await record(x.f, reopened)).copilotReviews![0]!;

  assert.equal(blocked.batch!.id, oldBatch.id);

  assert.ok(blocked.items.every(({ status }) => status === 'blocked'));

  assert.equal(reopened.a.inputs.length, 0);

  autoReply(x.f, reopened, x.source);

  await reopened.coordinator.send('reconcile the interrupted review');

  await until(
    'reconciled existing replies',
    async () =>
      !reopened.coordinator.snapshot.reviewing &&
      (await record(x.f, reopened)).copilotReviews![0]!.items.every(
        ({ status }) => status === 'handled',
      ),
  );

  assert.equal(
    reopened.a.inputs.filter(({ author }) => author === 'witch').length,
    1,
  );

  assert.deepEqual(x.source.threads[0]!.comments, replies);

  assert.equal(
    (await record(x.f, reopened)).copilotReviews![0]!.batch,
    undefined,
  );
});

for (const change of ['edit', 'addition']) {
  test(`a ${change} observed during ownership validation cannot enter an older feedback packet`, async (t) => {
    const x = await setup(t);
    const settled = Promise.withResolvers<boolean>();
    const run = x.c.copilot.run.bind(x.c.copilot);

    vi.spyOn(x.c.copilot, 'run').mockImplementationOnce(async () => {
      const result = await run();

      settled.resolve(result);

      return result;
    });

    const owns = x.a.coordination.reviews.owns.bind(x.a.coordination.reviews);

    vi.spyOn(x.a.coordination.reviews, 'owns').mockImplementationOnce(
      async (...args) => {
        const owned = await owns(...args);

        if (change === 'edit')
          x.source.reviews[0]!.body = 'The corrected overview.';
        else
          x.source.reviews.push({
            ...x.source.reviews[0]!,
            id: 'review-2',
            url: `${x.source.pullRequest.url}#pullrequestreview-2`,
            body: 'Another overview with no inline findings.',
          });

        await x.observe();

        return owned;
      },
    );

    await x.observe();

    assert.equal(
      await within(settled.promise, 5000, 'stale admission refusal'),
      false,
    );

    await until(
      'admission returned to idle',
      () => x.c.snapshot.phase === 'idle',
    );

    assert.equal(x.reviews().length, 0);

    assert.ok(
      (await record(x.f, x.a)).copilotReviews![0]!.items.every(
        ({ status }) => status === 'pending',
      ),
    );

    let admitted: ReviewBatch | undefined;

    autoReply(x.f, x.a, x.source, () => {
      admitted = x.c.copilot.context()!.state.batch;

      return true;
    });

    await x.observe();

    await x.handled();

    const packet = JSON.parse(await readFile(admitted!.packet, 'utf8')) as {
      source: GitHubReviews;
      batch: ReviewBatch;
    };

    if (change === 'edit')
      assert.equal(packet.source.reviews[0]!.body, 'The corrected overview.');
    else {
      assert.equal(packet.source.reviews[1]!.id, 'review-2');

      assert.ok(packet.batch.items.some(({ id }) => id === 'review-2'));
    }

    assert.equal(x.reviews().length, 1);
  });
}

for (const outcome of ['handled', 'uncertain']) {
  test(`switching PRs and reopening preserves ${outcome} feedback without replaying it`, async (t) => {
    const x = await setup(t);

    if (outcome === 'handled') autoReply(x.f, x.a, x.source);

    await x.observe();

    await until(
      'first PR disposition',
      async () =>
        !x.c.snapshot.reviewing &&
        (await record(x.f, x.a)).copilotReviews![0]!.items.every(
          ({ status }) =>
            status === (outcome === 'handled' ? 'handled' : 'blocked'),
        ),
    );

    const original = (await record(x.f, x.a)).copilotReviews![0]!;
    const hold = x.c.holdPromptDelivery();
    const other = reviewSource();

    other.pullRequest = {
      ...other.pullRequest,
      number: 13,
      url: 'https://github.com/team/project/pull/13',
      branch: 'feat/another-review',
    };

    other.reviews = [];

    other.threads = [];

    await git(
      '-C',
      x.cwd,
      'symbolic-ref',
      'HEAD',
      'refs/heads/feat/another-review',
    );

    const repository = {
      ...x.repository,
      branch: other.pullRequest.branch,
      pullRequest: other.pullRequest,
    };

    x.a.coordination.updateRepository(repository);

    x.c.copilot.updateRepository(repository);

    await x.c.copilot.observe(other);

    hold();

    await x.c.send('work on this second PR');

    await git('-C', x.cwd, 'symbolic-ref', 'HEAD', 'refs/heads/feat/reviews');

    x.a.coordination.updateRepository(x.repository);

    x.c.copilot.updateRepository(x.repository);

    await x.observe();

    assert.equal(x.c.copilot.ready(), false);

    assert.equal(x.reviews().length, 1);

    const restored = (await record(x.f, x.a)).copilotReviews!.find(
      ({ pullRequest }) => pullRequest.url === x.source.pullRequest.url,
    )!;

    assert.deepEqual(restored.items, original.items);

    assert.equal(
      x.c.copilot.context()!.state.pullRequest.url,
      x.source.pullRequest.url,
    );

    assert.equal(x.c.copilot.context()!.state.batch?.id, original.batch?.id);

    const id = x.c.snapshot.conversation!.id;

    await x.c.close({ restart: true });

    const reopened = await x.f.start('A', { conversation: id });

    reopened.coordination.updateRepository(x.repository);

    reopened.coordinator.copilot.updateRepository(x.repository);

    await reopened.coordinator.copilot.observe(structuredClone(x.source));

    const history = (await record(x.f, reopened)).copilotReviews!;

    assert.deepEqual(
      history.map(({ pullRequest }) => pullRequest.url),
      [x.source.pullRequest.url, other.pullRequest.url],
    );

    assert.deepEqual(history[0]!.items, original.items);

    assert.equal(history[0]!.batch?.id, original.batch?.id);

    assert.equal(reopened.a.inputs.length, 0);
  });
}

test('absent feedback retains pending history without entering a packet until it returns', async (t) => {
  const x = await setup(t);
  const hold = x.c.holdPromptDelivery();

  await x.observe();

  const body = x.source.reviews[0]!.body;

  x.source.reviews[0]!.body = '';

  await x.observe();

  let admitted: ReviewBatch | undefined;

  autoReply(x.f, x.a, x.source, () => {
    admitted = x.c.copilot.context()!.state.batch;

    return true;
  });

  hold();

  await until(
    'visible thread handled',
    async () =>
      !x.c.snapshot.reviewing &&
      (await record(x.f, x.a)).copilotReviews![0]!.items.find(
        ({ id }) => id === 'thread-1',
      )!.status === 'handled',
  );

  assert.deepEqual(
    admitted!.items.map(({ id }) => id),
    ['thread-1'],
  );

  assert.equal(x.reviews().length, 1);

  assert.equal(x.c.copilot.ready(), false);

  const absent = x.c.copilot
    .context()!
    .state.items.find(({ id }) => id === 'review-1')!;

  assert.equal(absent.present, false);

  assert.equal(absent.status, 'pending');

  x.source.reviews[0]!.body = body;

  await x.observe();

  await x.handled();

  assert.equal(x.reviews().length, 2);

  assert.deepEqual(
    admitted!.items.map(({ id }) => id),
    ['review-1'],
  );

  assert.equal(
    x.source.threads[0]!.comments.filter(
      ({ author }) => author?.login === 'owner',
    ).length,
    1,
  );
});

test('a delayed review receives the destination runtime handoff and preserves it for the next user turn', async (t) => {
  const x = await setup(t);

  await x.c.send('implement the approved task');

  await x.c.selectModel({ agent: 'b', id: 'b-model' });

  const handoff = (await record(x.f, x.a)).handoff;

  assert.equal(x.a.b.inputs.length, 0);

  autoReply(x.f, x.a, x.source);

  await x.observe();

  await x.handled();

  assert.equal(x.a.b.inputs[0]!.author, 'witch');

  assert.match(
    x.a.b.inputs[0]!.context!,
    /Pending task context from a:\na: finish the migration/,
  );

  assert.deepEqual((await record(x.f, x.a)).handoff, handoff);

  await x.c.send('continue the user task');

  await until(
    'the next user turn',
    () => x.a.b.inputs.length === 2 && x.c.snapshot.phase === 'idle',
  );

  assert.match(
    x.a.b.inputs[1]!.context!,
    /Pending task context from a:\na: finish the migration/,
  );

  assert.equal((await record(x.f, x.a)).handoff, undefined);
});

test('review turns on a second PR settle its own receipts without changing the first PR', async (t) => {
  const x = await setup(t);

  autoReply(x.f, x.a, x.source);

  await x.observe();

  await x.handled();

  const first = structuredClone(x.source);
  const original = (await record(x.f, x.a)).copilotReviews![0]!;
  const second = reviewSource();

  second.pullRequest = {
    ...second.pullRequest,
    number: 13,
    url: 'https://github.com/team/project/pull/13',
    branch: 'feat/second-pr',
  };

  second.reviews[0] = {
    ...second.reviews[0]!,
    id: 'review-13',
    url: `${second.pullRequest.url}#pullrequestreview-13`,
  };

  second.threads[0] = {
    ...second.threads[0]!,
    id: 'thread-13',
    comments: [
      {
        ...second.threads[0]!.comments[0]!,
        id: 'comment-13',
        url: `${second.pullRequest.url}#discussion_r13`,
        pullRequestReview: { id: 'review-13' },
      },
    ],
  };

  Object.assign(x.source, second);

  await git('-C', x.cwd, 'symbolic-ref', 'HEAD', 'refs/heads/feat/second-pr');

  const repository = {
    ...x.repository,
    branch: x.source.pullRequest.branch,
    pullRequest: x.source.pullRequest,
  };

  x.a.coordination.updateRepository(repository);

  x.c.copilot.updateRepository(repository);

  await x.observe();

  await until(
    'second PR handled',
    async () =>
      !x.c.snapshot.reviewing &&
      !!(await record(x.f, x.a))
        .copilotReviews!.find(
          ({ pullRequest }) => pullRequest.url === second.pullRequest.url,
        )
        ?.items.every(({ status }) => status === 'handled'),
  );

  const history = (await record(x.f, x.a)).copilotReviews!;

  assert.deepEqual(
    history.find(
      ({ pullRequest }) => pullRequest.url === first.pullRequest.url,
    ),
    original,
  );

  const thread = history
    .find(({ pullRequest }) => pullRequest.url === second.pullRequest.url)!
    .items.find(({ id }) => id === 'thread-13')!;

  assert.deepEqual(
    thread.receipts.map((receipt) =>
      receipt.disposition === 'fixed' ? receipt.reply : receipt.disposition,
    ),
    [`${second.pullRequest.url}#discussion_response_thread-13`],
  );

  assert.equal(x.reviews().length, 2);

  Object.assign(x.source, first);

  await git('-C', x.cwd, 'symbolic-ref', 'HEAD', 'refs/heads/feat/reviews');

  x.a.coordination.updateRepository(x.repository);

  x.c.copilot.updateRepository(x.repository);

  await x.observe();

  assert.equal(x.c.copilot.ready(), false);

  assert.equal(x.reviews().length, 2);
});

for (const revoke of ['branch', 'CLOSED', 'MERGED'] as const) {
  test(`${revoke} review revocation preserves automatic peer answers`, async (t) => {
    const x = await setup(t);
    const b = await x.f.start('B');

    await b.claim('task:asker');

    const gate = new TurnGate();

    x.a.a.gate = gate;

    await x.observe();

    await within(gate.entered, 5000, 'review dispatch');

    const asked = await callControl(await b.binding(), {
      kind: 'ask',
      claim: x.a.coordination.snapshot.ownClaim!.id,
      message: 'Report the current task status.',
    });

    assert.ok(asked.kind === 'peer-request');

    await x.a.coordination.context();

    x.a.a.gate = undefined;

    if (revoke === 'branch') {
      await git('-C', x.cwd, 'symbolic-ref', 'HEAD', 'refs/heads/other-work');

      x.c.copilot.updateRepository({
        ...x.repository,
        branch: 'other-work',
        pullRequest: undefined,
      });
    } else {
      x.source.pullRequest.state = revoke;

      await x.observe();
    }

    const binding = await b.binding();

    const answer = () =>
      callControl(binding, {
        kind: 'peer-request',
        request: asked.request.id,
      });

    await until('persisted peer answer after review revocation', async () => {
      const result = await answer();

      return result.kind === 'peer-request' && result.status === 'answered';
    });

    const result = await answer();

    assert.ok(result.kind === 'peer-request');

    assert.equal(result.request.answer?.message, 'Done.');

    assert.equal(
      x.a.a.inputs.filter(({ prompt }) => prompt === answerInstruction).length,
      1,
    );

    assert.equal(
      x.a.a.inputs.filter(({ prompt }) =>
        prompt.startsWith('Witch started this turn to handle Copilot'),
      ).length,
      1,
    );

    gate.open();
  });
}

test('ordinary prompts show present review counts only while the PR is bound', async (t) => {
  const x = await setup(t);

  autoReply(x.f, x.a, x.source);

  await x.c.interrupt();

  await x.observe();

  await x.c.send('pending review status');

  await x.handled();

  const pending = x.a.a.inputs.find(
    ({ prompt }) => prompt === 'pending review status',
  )!;

  assert.ok(
    pending.context?.includes(
      `${x.source.pullRequest.url}, 0 handled, 2 outstanding.`,
    ),
  );

  await x.c.send('handled review status');

  assert.ok(
    x.a.a.inputs
      .at(-1)!
      .context?.includes(
        `${x.source.pullRequest.url}, 2 handled, 0 outstanding.`,
      ),
  );

  x.source.threads = [];

  await x.observe();

  await x.c.send('present review status');

  assert.ok(
    x.a.a.inputs
      .at(-1)!
      .context?.includes(
        `${x.source.pullRequest.url}, 1 handled, 0 outstanding.`,
      ),
  );

  await git('-C', x.cwd, 'symbolic-ref', 'HEAD', 'refs/heads/other-work');

  x.c.copilot.updateRepository({
    ...x.repository,
    branch: 'other-work',
    pullRequest: undefined,
  });

  await x.c.send('other branch status');

  assert.ok(!x.a.a.inputs.at(-1)!.context?.includes('Copilot review watch:'));
});

test('a head GitHub never asks Copilot to review reports that no review is pending until one arrives', async (t) => {
  const x = await setup(t);
  const review = x.source.reviews;

  x.source.reviews = [];

  x.source.threads = [];

  const missing = "GitHub hasn't asked Copilot to review the latest push";

  const noticed = () =>
    x.c.snapshot.items.filter(({ text }) => text.includes(missing)).length;

  await x.observe();

  assert.equal(x.c.copilot.context()!.unrequested, false);

  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);

  t.onTestFinished(() => {
    vi.mocked(Date.now).mockRestore();
  });

  x.source.draft = true;

  await x.observe();

  assert.equal(x.c.copilot.context()!.unrequested, false);

  x.source.draft = false;

  const rules = x.source.copilotRules;

  x.source.copilotRules = [];

  await x.observe();

  assert.equal(x.c.copilot.context()!.unrequested, false);

  x.source.copilotRules = rules;

  await x.observe();

  assert.equal(x.c.copilot.context()!.unrequested, true);

  assert.equal(noticed(), 1);

  await x.c.send('unreviewed status');

  assert.ok(
    x.a.a.inputs
      .at(-1)!
      .context?.includes(
        `${x.source.pullRequest.url}, 0 handled, 0 outstanding. Keep this task claimed while its open pull request remains watched; verify feedback against current code and existing replies.\n\nNo Copilot review is pending`,
      ),
  );

  x.source.reviews = review;

  assert.equal(await x.observe(), true);

  assert.equal(x.c.copilot.context()!.unrequested, false);

  assert.equal(noticed(), 1);
});

test('a failed post-turn GitHub read retains the result and recovers without another native attempt', async (t) => {
  const x = await setup(t);

  autoReply(x.f, x.a, x.source);

  vi.mocked(github.readGitHubReviews)
    .mockImplementationOnce(async () => structuredClone(x.source))
    .mockRejectedValueOnce(new Error('after-turn-github-down'));

  await x.observe();

  await until(
    'saved GitHub read failure',
    async () =>
      x.c.snapshot.phase === 'idle' &&
      (await record(x.f, x.a)).copilotReviews![0]!.batch?.reason ===
        'after-turn-github-down',
  );

  const failed = (await record(x.f, x.a)).copilotReviews![0]!;

  assert.ok(failed.items.every(({ status }) => status === 'blocked'));

  await until('post-turn GitHub failure notice', () =>
    x.c.snapshot.items.some(({ text }) =>
      text.includes('after-turn-github-down'),
    ),
  );

  await x.observe();

  await x.handled();

  assert.equal((await record(x.f, x.a)).copilotReviews![0]!.batch, undefined);

  assert.equal(x.reviews().length, 1);
});

test('an ordinary turn can reconcile a missing reply receipt before later feedback runs', async (t) => {
  const x = await setup(t);
  const session = x.a.a.sessions.at(-1)!.session;
  const send = session.send;

  session.send = async (...args) => {
    if (args[1]?.purpose === 'pr-review') {
      await reply(x.f, x.a, x.source);

      x.source.threads[0]!.comments.pop();
    }

    return send(...args);
  };

  await x.observe();

  await until(
    'waiting receipt',
    async () =>
      x.c.snapshot.phase === 'idle' &&
      !!(await record(x.f, x.a)).copilotReviews![0]!.batch?.verifying,
  );

  const batch = (await record(x.f, x.a)).copilotReviews![0]!.batch!;

  await until('GitHub verification notice', () =>
    x.c.snapshot.items.some(({ text }) => text.includes('Waiting for GitHub')),
  );

  session.send = async (...args) => {
    if (args[0] === 'reconcile the previous review result') {
      assert.ok(args[1]?.context?.includes(batch.result));

      await writeFile(
        batch.result,
        JSON.stringify({
          batch: batch.id,
          items: batch.items.map((item) => ({
            ...item,
            disposition: 'blocked',
            reason: 'The recorded reply does not exist.',
          })),
        } satisfies ReviewResult),
      );
    } else if (args[1]?.purpose === 'pr-review')
      await reply(x.f, x.a, x.source);

    return send(...args);
  };

  await x.c.send('reconcile the previous review result');

  await x.observe();

  const reconciled = (await record(x.f, x.a)).copilotReviews![0]!;

  assert.equal(reconciled.batch, undefined);

  assert.ok(reconciled.items.every(({ status }) => status === 'blocked'));

  assert.equal(x.reviews().length, 1);

  const original = x.source.threads[0]!;

  x.source.threads.push({
    ...original,
    id: 'later-thread',
    comments: [
      {
        ...original.comments[0]!,
        id: 'later-comment',
        body: 'Inspect later feedback.',
        url: `${x.source.pullRequest.url}#discussion_later`,
      },
    ],
  });

  await x.observe();

  await until(
    'later feedback handled',
    async () =>
      x.c.snapshot.phase === 'idle' &&
      (await record(x.f, x.a)).copilotReviews![0]!.items.find(
        ({ id }) => id === 'later-thread',
      )?.status === 'handled',
  );

  assert.equal(x.reviews().length, 2);

  assert.equal(x.source.threads[0]!.comments.length, 1);
});
