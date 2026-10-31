import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test, vi } from 'vitest';
import type { TestContext } from 'vitest';
import * as github from '../src/core/github-reviews.js';
import type { GitHubReviews } from '../src/core/github-reviews.js';
import type { ReviewResult } from '../src/core/copilot-reviews.js';
import { conversationRecordSchema } from '../src/core/state.js';
import { callControl } from '../src/persistence/control.js';
import { RepositoryWatch } from '../src/core/repository.js';
import { watchCopilotReviews } from '../src/core/copilot-review-watch.js';
import { answerInstruction } from '../src/core/peer-requests.js';
import { TurnGate } from './fixtures/agent.js';
import { orderedCleanup } from './fixtures/cleanup.js';
import { coordinationFixture, git } from './fixtures/coordination.js';
import { reviewSource } from './fixtures/github-reviews.js';
import { scratch } from './fixtures/scratch.js';
import { until, within } from './fixtures/within.js';

type Fixture = Awaited<ReturnType<typeof coordinationFixture>>;
type Client = Awaited<ReturnType<Fixture['start']>>;

async function record(f: Fixture, client: Client) {
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

async function setup(t: TestContext) {
  const register = orderedCleanup(t.onTestFinished);
  const source = reviewSource();
  vi.spyOn(github, 'readGitHubReviews').mockImplementation(async (pr) => {
    assert.equal(pr.url, 'https://github.com/team/project/pull/12');
    return structuredClone(source);
  });
  vi.spyOn(github, 'reviewCommitPushed').mockImplementation(
    async (pr, commit) =>
      pr.commit === 'b'.repeat(40) && commit === 'b'.repeat(40),
  );
  const f = await coordinationFixture(register, async (references) => ({
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
  const repository = {
    branch: 'feat/reviews',
    ahead: 0,
    behind: 0,
    staged: 0,
    modified: 0,
    conflicts: 0,
    untracked: 0,
    pullRequest: { ...source.pullRequest },
    pullRequestProject: (await f.memory.scopePaths(cwd)).project,
  };
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
        !!(await record(f, a)).copilotReviews?.items.every(
          ({ status }) => status === 'handled',
        ),
    );
  return { f, a, c, source, repository, observe, reviews, handled, cwd };
}

async function reply(f: Fixture, client: Client, source: GitHubReviews) {
  const saved = await record(f, client);
  const batch = saved.copilotReviews!.batch!;
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
    const item = saved.copilotReviews!.items.find(
      ({ id }) => id === expected.id,
    )!;
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

function autoReply(
  f: Fixture,
  client: Client,
  source: GitHubReviews,
  enabled = () => true,
) {
  const session = client.a.sessions.at(-1)!.session;
  const send = session.send;
  vi.spyOn(session, 'send').mockImplementation(
    async (prompt, skill, context, author) => {
      if (
        author === 'witch' &&
        prompt.startsWith('Witch started this turn to handle Copilot') &&
        enabled()
      )
        await reply(f, client, source);
      return send(prompt, skill, context, author);
    },
  );
}

test('delayed feedback runs once, verifies the reply and pushed commit, and preserves ordinary-turn metadata', async (t) => {
  const x = await setup(t);
  await x.c.send('implement the fix');
  const before = await record(x.f, x.a);
  const completion = x.c.snapshot.completedTurn;
  autoReply(x.f, x.a, x.source);
  await x.observe();
  await x.handled();
  const after = await record(x.f, x.a);
  assert.deepEqual(after.lastTurn, before.lastTurn);
  assert.equal(after.title, before.title);
  assert.equal(x.c.snapshot.completedTurn, completion);
  assert.equal(x.c.snapshot.native?.permissionMode, 'default');
  assert.equal(x.reviews().length, 1);
  assert.equal(after.copilotReviews!.batch, undefined);
  assert.equal(
    after.copilotReviews!.items.find(({ kind }) => kind === 'thread')!
      .receipts[0]!.disposition,
    'fixed',
  );
  assert.ok(
    !x.reviews()[0]!.prompt.includes('The retry crosses the deadline.'),
  );
  assert.ok(
    !x.reviews()[0]!.context?.includes('The retry crosses the deadline.'),
  );
  await x.observe();
  await x.observe();
  assert.equal(x.reviews().length, 1);
  assert.equal(
    x.source.threads[0]!.comments.filter(
      ({ author }) => author?.login === 'owner',
    ).length,
    1,
  );
});

test('feedback arriving during work waits behind queued user prompts', async (t) => {
  const x = await setup(t);
  autoReply(x.f, x.a, x.source);
  const gate = new TurnGate();
  x.a.a.gate = gate;
  x.a.a.refuseSteer = true;
  const first = x.c.send('first user task');
  await gate.entered;
  const second = x.c.send('second user task');
  await until('queued user input', () => x.c.snapshot.queue.length === 1);
  await x.observe();
  assert.equal(x.reviews().length, 0);
  gate.open();
  await Promise.all([first, second]);
  await x.handled();
  assert.deepEqual(
    x.a.a.inputs.map(({ prompt, author }) => author ?? prompt),
    ['first user task', 'second user task', 'witch'],
  );
});

test('a user prompt during a review queues without steering it', async (t) => {
  const x = await setup(t);
  const gate = new TurnGate();
  x.a.a.gate = gate;
  autoReply(x.f, x.a, x.source);
  await x.observe();
  await within(gate.entered, 5000, 'review dispatch');
  const user = x.c.send('next user task');
  await until('queued prompt', () => x.c.snapshot.queue.length === 1);
  assert.deepEqual(x.a.a.steers, []);
  assert.equal(x.c.snapshot.reviewing, true);
  gate.open();
  await user;
  await until(
    'next user turn',
    () =>
      x.a.a.inputs.at(-1)?.prompt === 'next user task' &&
      x.c.snapshot.phase === 'idle',
  );
  await x.handled();
  assert.deepEqual(
    x.a.a.inputs.map(({ prompt, author }) => author ?? prompt),
    ['witch', 'next user task'],
  );
});

test('Escape holds unknown outcomes through rereads and the next user prompt resumes after reconciliation', async (t) => {
  const x = await setup(t);
  let respond = false;
  autoReply(x.f, x.a, x.source, () => respond);
  const gate = new TurnGate();
  x.a.a.gate = gate;
  await x.observe();
  await within(gate.entered, 5000, 'review dispatch');
  await x.c.interrupt();
  await until('blocked result', async () =>
    (await record(x.f, x.a)).copilotReviews!.items.every(
      ({ status }) => status === 'blocked',
    ),
  );
  await x.observe();
  assert.equal(x.reviews().length, 1);
  assert.ok((await record(x.f, x.a)).copilotReviews!.batch);
  gate.open();
  respond = true;
  await x.c.send('resume this task');
  await x.handled();
  assert.deepEqual(
    x.a.a.inputs.map(({ prompt, author }) => author ?? prompt),
    ['witch', 'resume this task', 'witch'],
  );
});

test('delivery holds and pending questions block review turns without consuming feedback', async (t) => {
  const x = await setup(t);
  autoReply(x.f, x.a, x.source);
  const release = x.c.holdPromptDelivery();
  await x.observe();
  assert.equal(x.reviews().length, 0);
  assert.ok(
    (await record(x.f, x.a)).copilotReviews!.items.every(
      ({ status }) => status === 'pending',
    ),
  );
  x.a.a.sessions.at(-1)!.options.onEvent({
    type: 'request',
    request: {
      id: 'question',
      kind: 'question',
      title: 'Choose target',
      detail: '',
      questions: [{ id: 'target', title: 'Which target?', options: ['A'] }],
      replyAsPrompt: true,
    },
  });
  release();
  await x.observe();
  assert.equal(x.reviews().length, 0);
  await x.c.respond('question', { decision: 'decline' });
  await x.observe();
  await x.handled();
  assert.equal(x.reviews().length, 1);
});

for (const kind of ['branch', 'claim', 'project']) {
  test(`confirmed ${kind} loss interrupts a running review and retains its uncertain receipt`, async (t) => {
    const x = await setup(t);
    const gate = new TurnGate();
    x.a.a.gate = gate;
    await x.observe();
    await within(gate.entered, 5000, 'review dispatch');
    if (kind === 'branch') {
      await git('-C', x.cwd, 'symbolic-ref', 'HEAD', 'refs/heads/other-work');
      x.c.copilot.updateRepository({
        ...x.repository,
        branch: 'other-work',
        pullRequest: undefined,
      });
    } else if (kind === 'project') {
      await git(
        '-C',
        x.cwd,
        'remote',
        'set-url',
        'origin',
        join(x.f.root, 'other'),
      );
      await x.a.coordination.context();
    } else {
      const claim = (await record(x.f, x.a)).copilotReviews!.claim!;
      const result = await callControl(await x.a.binding(), {
        kind: 'release',
        claim,
      });
      assert.equal(result.kind, 'released');
    }
    await until(
      'interrupted review',
      () => x.c.snapshot.phase === 'idle' && !x.c.snapshot.reviewing,
    );
    await until('retained attempt', async () =>
      (await record(x.f, x.a)).copilotReviews!.items.every(
        ({ status }) => status === 'blocked',
      ),
    );
    assert.equal(x.reviews().length, 1);
    assert.ok((await record(x.f, x.a)).copilotReviews!.batch);
    assert.ok(
      x.c.snapshot.items.some(({ text }) =>
        text.includes('branch or task ownership changed'),
      ),
    );
  });
}

test('new feedback observed during execution waits for its own later batch', async (t) => {
  const x = await setup(t);
  const gate = new TurnGate();
  x.a.a.gate = gate;
  autoReply(x.f, x.a, x.source);
  await x.observe();
  await within(gate.entered, 5000, 'first review');
  x.source.threads.push({
    ...x.source.threads[0]!,
    id: 'thread-2',
    comments: [
      {
        ...x.source.threads[0]!.comments[0]!,
        id: 'comment-2',
        body: 'Check the final reply too.',
        url: `${x.source.pullRequest.url}#discussion_r3`,
      },
    ],
  });
  await x.observe();
  assert.equal(x.reviews().length, 1);
  gate.open();
  await x.handled();
  assert.equal(x.reviews().length, 2);
  assert.equal(
    x.source.threads[0]!.comments.filter(
      ({ author }) => author?.login === 'owner',
    ).length,
    1,
  );
  assert.equal(
    x.source.threads[1]!.comments.filter(
      ({ author }) => author?.login === 'owner',
    ).length,
    1,
  );
});

test('reopening reconciles a reply saved before interruption without another automatic turn', async (t) => {
  const x = await setup(t);
  const gate = new TurnGate();
  x.a.a.gate = gate;
  autoReply(x.f, x.a, x.source);
  await x.observe();
  await within(gate.entered, 5000, 'review dispatch');
  const id = x.c.snapshot.conversation!.id;
  await x.c.close({ restart: true });
  const reopened = await x.f.start('A', { conversation: id });
  reopened.coordination.updateRepository(x.repository);
  reopened.coordinator.copilot.updateRepository(x.repository);
  await reopened.coordinator.copilot.observe(structuredClone(x.source));
  await until('recovered receipts', async () =>
    (await record(x.f, reopened)).copilotReviews!.items.every(
      ({ status }) => status === 'handled',
    ),
  );
  assert.equal(reopened.a.inputs.length, 0);
  assert.equal(
    x.source.threads[0]!.comments.filter(
      ({ author }) => author?.login === 'owner',
    ).length,
    1,
  );
});

test('the CLI watcher wiring carries a real repository observation through a review turn to persisted receipts', async (t) => {
  const x = await setup(t);
  const execute = promisify(execFile);
  const repository = new RepositoryWatch(
    x.cwd,
    async (command, args, options) => {
      if (command !== 'gh') return execute(command, args, options);
      assert.deepEqual(args.slice(0, 3), ['pr', 'view', '--json']);
      return {
        stdout: JSON.stringify({
          number: 12,
          url: x.source.pullRequest.url,
          state: 'OPEN',
          headRefName: 'feat/reviews',
          headRefOid: x.source.pullRequest.commit,
          baseRefName: 'main',
          mergeable: 'MERGEABLE',
          statusCheckRollup: [],
        }),
      };
    },
    async () => (await x.f.memory.scopePaths(x.cwd)).project,
  );
  const stopRepository = repository.subscribe(() =>
    x.a.coordination.updateRepository(repository.snapshot),
  );
  autoReply(x.f, x.a, x.source);
  const stop = watchCopilotReviews(repository, x.c, x.cwd);
  try {
    await x.handled();
    const saved = await record(x.f, x.a);
    assert.deepEqual(
      saved.copilotReviews!.items.map(({ id, status }) => [id, status]),
      [
        ['review-1', 'handled'],
        ['thread-1', 'handled'],
      ],
    );
    assert.equal(x.reviews().length, 1);
    assert.ok(
      x.c.snapshot.items.some(({ text }) =>
        text.startsWith('Watching Copilot on #12:'),
      ),
    );
  } finally {
    stop();
    stopRepository();
    repository.close();
  }
});

test('a prompt in another conversation cannot resume an uncertain review on return', async (t) => {
  const x = await setup(t);
  const original = x.c.snapshot.conversation!.id;
  const gate = new TurnGate();
  x.a.a.gate = gate;
  await x.observe();
  await within(gate.entered, 5000, 'first review');
  await x.c.interrupt();
  gate.open();
  await until('uncertain result', async () =>
    (await record(x.f, x.a)).copilotReviews!.items.every(
      ({ status }) => status === 'blocked',
    ),
  );
  await x.c.newConversation('a');
  await x.c.send('work in this other conversation');
  await x.c.selectConversation(original);
  await x.a.claim(x.source.closingIssues[0]!);
  await x.observe();
  assert.equal(x.c.copilot.ready(), false);
  assert.equal(x.reviews().length, 1);
  assert.ok((await record(x.f, x.a)).copilotReviews!.batch);
});

test('review turns compact before native input and retain the feedback packet across replacement', async (t) => {
  const x = await setup(t);
  await x.c.send('work on this PR');
  x.a.a.sessions.at(-1)!.session.contextUsage = async () => 85;
  autoReply(x.f, x.a, x.source, () => {
    assert.equal(x.a.a.compactions.length, 1);
    return true;
  });
  await x.observe();
  await x.handled();
  assert.match(x.reviews()[0]!.context!, /You are running inside Witch/);
  assert.equal(x.c.snapshot.pendingCompaction, false);
  assert.equal(x.reviews().length, 1);
});

test('waiting peer answers run before a pending Copilot review', async (t) => {
  const x = await setup(t);
  const b = await x.f.start('B');
  await b.claim('task:asker');
  autoReply(x.f, x.a, x.source);
  const release = x.c.holdPromptDelivery();
  await x.observe();
  const state = await record(x.f, x.a);
  const asked = await callControl(await b.binding(), {
    kind: 'ask',
    claim: state.copilotReviews!.claim!,
    message: 'What did this task find?',
  });
  assert.equal(asked.kind, 'peer-request');
  await x.a.coordination.context();
  release();
  await x.handled();
  assert.deepEqual(
    x.a.a.inputs.map(({ prompt, author }) =>
      prompt === answerInstruction
        ? 'peer'
        : author === 'witch'
          ? 'review'
          : 'user',
    ),
    ['peer', 'review'],
  );
});
