import assert from 'node:assert/strict';

import { readFile, writeFile } from 'node:fs/promises';

import { join } from 'node:path';

import { vi } from 'vitest';

import type { TestContext } from 'vitest';

import * as github from '../../src/core/github-reviews.js';

import type { GitHubReviews } from '../../src/core/github-reviews.js';

import type { ReviewResult } from '../../src/core/copilot-reviews.js';

import { conversationRecordSchema } from '../../src/core/state.js';

import { orderedCleanup } from './cleanup.js';

import { unitCoordinationFixture, git } from './coordination.js';

import { reviewSource } from './github-reviews.js';

import { scratch } from './scratch.js';

import { until } from './within.js';

import { repositoryRead } from './repository.js';

type Fixture = Awaited<ReturnType<typeof unitCoordinationFixture>>;

type Client = Awaited<ReturnType<Fixture['start']>>;

export async function record(f: Fixture, client: Client) {
  return conversationRecordSchema.parse(
    JSON.parse(
      await readFile(
        join(
          f.store.root,
          'conversations',
          client.coordinator.snapshot.conversation!.id,
          'state.json',
        ),
        'utf8',
      ),
    ),
  );
}

export async function setup(t: TestContext) {
  const register = orderedCleanup(t.onTestFinished);

  const source = reviewSource();

  vi.spyOn(github, 'readGitHubReviews').mockImplementation(async (pr) => {
    assert.equal(pr.url, source.pullRequest.url);

    return structuredClone(source);
  });

  vi.spyOn(github, 'reviewCommitPushed').mockImplementation(
    async (pr, commit) =>
      pr.commit === 'b'.repeat(40) && commit === 'b'.repeat(40),
  );

  const f = await unitCoordinationFixture(register, async (references) => ({
    assigned: references,
  }));

  const packets = await scratch('witch-review-packets-');

  vi.stubEnv('TMPDIR', packets);

  register(() => {
    vi.unstubAllEnvs();
  });

  const a = await f.start('A');

  const c = a.coordinator;

  const cwd = c.snapshot.conversation!.cwd;

  await git('-C', cwd, 'symbolic-ref', 'HEAD', 'refs/heads/feat/reviews');

  const repository = repositoryRead({
    branch: 'feat/reviews',
    pullRequest: { ...source.pullRequest },
    pullRequestProject: (await f.memory.scopePaths(cwd)).project,
  });

  a.coordination.updateRepository(repository);

  c.copilot.updateRepository(repository);

  await a.claim(source.closingIssues[0]!);

  const observe = () => c.copilot.observe(structuredClone(source));

  const reviews = () => a.a.inputs.filter(({ author }) => author === 'witch');

  const handled = () =>
    until(
      'persisted review dispositions',
      async () =>
        c.snapshot.phase === 'idle' &&
        !c.snapshot.reviewing &&
        !!(await record(f, a)).copilotReviews?.[0]?.items.every(
          ({ status }) => status === 'handled',
        ),
    );

  return { f, a, c, source, repository, observe, reviews, handled, cwd };
}

export async function reply(f: Fixture, client: Client, source: GitHubReviews) {
  const saved = await record(f, client);

  const state = saved.copilotReviews!.find(
    ({ pullRequest }) => pullRequest.url === source.pullRequest.url,
  )!;

  const batch = state.batch!;

  assert.ok(batch, 'the admission receipt was saved before native input');

  const packet = JSON.parse(await readFile(batch.packet, 'utf8')) as {
    source: GitHubReviews;
  };

  assert.equal(
    packet.source.threads[0]!.comments[0]!.body,
    'The retry crosses the deadline.',
  );

  const items: ReviewResult['items'] = [];

  for (const expected of batch.items) {
    const item = state.items.find(({ id }) => id === expected.id)!;

    if (item.kind === 'review') {
      items.push({
        ...expected,
        disposition: 'covered',
        threads: source.threads
          .filter(({ comments }) =>
            comments.some(
              ({ pullRequestReview }) => pullRequestReview?.id === item.id,
            ),
          )
          .map(({ id }) => id),
        reason: 'the inline findings cover the summary',
      });

      continue;
    }

    const thread = source.threads.find(({ id }) => id === item.id)!;

    const url = `${source.pullRequest.url}#discussion_response_${item.id}`;

    if (!thread.comments.some((comment) => comment.url === url))
      thread.comments.push({
        id: `response-${item.id}`,
        url,
        body: `fixed in https://github.com/team/project/commit/${'b'.repeat(40)}`,
        author: { __typename: 'User', login: 'owner' },
        createdAt: '2026-10-30T23:01:00Z',
        updatedAt: '2026-10-30T23:01:00Z',
        pullRequestReview: null,
      });

    source.pullRequest.commit = 'b'.repeat(40);

    items.push({
      ...expected,
      disposition: 'fixed',
      reply: url,
      commit: 'b'.repeat(40),
    });
  }

  await writeFile(batch.result, JSON.stringify({ batch: batch.id, items }));
}

export function autoReply(
  f: Fixture,
  client: Client,
  source: GitHubReviews,
  enabled = () => true,
) {
  const agent =
    client.coordinator.snapshot.conversation!.agent === 'b'
      ? client.b
      : client.a;

  const session = agent.sessions.at(-1)!.session;

  const send = session.send;

  vi.spyOn(session, 'send').mockImplementation(async (prompt, options) => {
    if (
      options?.purpose === 'pr-review' &&
      prompt.startsWith('Witch started this turn to handle Copilot') &&
      enabled()
    )
      await reply(f, client, source);

    // the fixture never sent images, so it keeps dropping them
    return send(prompt, { ...options, images: undefined });
  });
}
