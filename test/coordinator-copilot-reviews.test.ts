import assert from 'node:assert/strict';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test, vi } from 'vitest';
import type { TestContext } from 'vitest';
import * as github from '../src/core/github-reviews.js';
import type { GitHubReviews } from '../src/core/github-reviews.js';
import type { ReviewBatch, ReviewResult } from '../src/core/copilot-reviews.js';
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
    assert.equal(pr.url, source.pullRequest.url);
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
        !!(await record(f, a)).copilotReviews?.[0]?.items.every(
          ({ status }) => status === 'handled',
        ),
    );
  return { f, a, c, source, repository, observe, reviews, handled, cwd };
}

async function reply(f: Fixture, client: Client, source: GitHubReviews) {
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

function autoReply(
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
  vi.spyOn(session, 'send').mockImplementation(
    async (prompt, skill, context, purpose, answer) => {
      if (
        purpose === 'pr-review' &&
        prompt.startsWith('Witch started this turn to handle Copilot') &&
        enabled()
      )
        await reply(f, client, source);
      return send(prompt, skill, context, purpose, answer);
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
  assert.equal(x.reviews().length, 1);
  assert.equal(after.copilotReviews![0]!.batch, undefined);
  assert.equal(
    after.copilotReviews![0]!.items.find(({ kind }) => kind === 'thread')!
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
    (await record(x.f, x.a)).copilotReviews![0]!.items.every(
      ({ status }) => status === 'blocked',
    ),
  );
  await x.observe();
  assert.equal(x.reviews().length, 1);
  assert.ok((await record(x.f, x.a)).copilotReviews![0]!.batch);
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
    (await record(x.f, x.a)).copilotReviews![0]!.items.every(
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

for (const mode of ['edited', 'interrupted']) {
  test(`a malformed ${mode} review result retains its diagnostic`, async (t) => {
    const x = await setup(t);
    const session = x.a.a.sessions.at(-1)!.session;
    const send = session.send;
    vi.spyOn(session, 'send').mockImplementation(async (...args) => {
      if (args[3] === 'pr-review') {
        const state = (await record(x.f, x.a)).copilotReviews![0]!;
        if (mode === 'edited') {
          x.source.reviews[0]!.body = 'Updated summary.';
          x.source.threads[0]!.comments[0]!.body = 'Updated finding.';
        }
        await writeFile(state.batch!.result, '{invalid json');
      }
      const result = await send(...args);
      return mode === 'interrupted'
        ? { status: 'interrupted', text: '' }
        : result;
    });
    await x.observe();
    await until('persisted recovery failure', async () => {
      const state = (await record(x.f, x.a)).copilotReviews?.[0];
      return (
        !x.c.snapshot.reviewing &&
        !!state?.batch?.reason?.includes('could not be verified')
      );
    });
    const diagnostic = (await record(x.f, x.a)).copilotReviews![0]!.batch!
      .reason!;
    assert.match(diagnostic, /JSON|property name|Unexpected/);
    assert.ok(x.c.snapshot.items.some(({ text }) => text.includes(diagnostic)));
    if (mode === 'edited')
      assert.ok(
        (await record(x.f, x.a)).copilotReviews![0]!.items.every(
          ({ status }) => status === 'pending',
        ),
      );
    const notices = x.c.snapshot.items.length;
    await x.observe();
    assert.equal(x.c.snapshot.items.length, notices);
    assert.equal(x.reviews().length, 1);
    assert.equal(x.c.copilot.ready(), false);
  });
}

test('an uncertain content version stays blocked after a newer version is handled', async (t) => {
  const x = await setup(t);
  x.source.reviews = [];
  const original = x.source.threads[0]!.comments[0]!.body;
  const session = x.a.a.sessions.at(-1)!.session;
  const send = session.send;
  let respond = false;
  vi.spyOn(session, 'send').mockImplementation(async (...args) => {
    if (args[3] === 'pr-review' && respond) {
      const batch = (await record(x.f, x.a)).copilotReviews![0]!.batch!;
      const url = `${x.source.pullRequest.url}#discussion_r2`;
      x.source.threads[0]!.comments.push({
        ...x.source.threads[0]!.comments[0]!,
        id: 'response-2',
        url,
        author: { __typename: 'User', login: 'owner' },
        body: 'acknowledged',
      });
      await writeFile(
        batch.result,
        JSON.stringify({
          batch: batch.id,
          items: batch.items.map((item) => ({
            ...item,
            disposition: 'acknowledged',
            reply: url,
            reason: 'verified',
          })),
        }),
      );
    }
    return send(...args);
  });
  await x.observe();
  await until(
    'uncertain first version',
    async () =>
      !!(await record(x.f, x.a)).copilotReviews?.[0]?.items.every(
        ({ status }) => status === 'blocked',
      ),
  );
  x.source.threads[0]!.comments[0]!.body = 'New version.';
  await x.observe();
  respond = true;
  await x.c.send('reconcile the current feedback');
  await x.handled();
  x.source.threads[0]!.comments[0]!.body = original;
  await x.observe();
  const item = (await record(x.f, x.a)).copilotReviews![0]!.items[0]!;
  assert.equal(item.status, 'blocked');
  assert.equal(item.receipts.length, 2);
  assert.equal(x.c.copilot.ready(), false);
  await x.observe();
  assert.equal(x.reviews().length, 2);
});

for (const state of ['CLOSED', 'MERGED'] as const) {
  test(`a ${state} GitHub observation stops an active review despite stale repository metadata`, async (t) => {
    const x = await setup(t);
    const gate = new TurnGate();
    x.a.a.gate = gate;
    await x.observe();
    await within(gate.entered, 5000, 'review dispatch');
    x.source.pullRequest.state = state;
    await x.observe();
    await until('closed review settlement', async () => {
      const saved = (await record(x.f, x.a)).copilotReviews![0]!;
      return (
        x.c.snapshot.phase === 'idle' &&
        !x.c.snapshot.reviewing &&
        saved.items.every(({ status }) => status === 'blocked')
      );
    });
    const saved = (await record(x.f, x.a)).copilotReviews![0]!;
    assert.equal(saved.pullRequest.state, state);
    assert.ok(saved.batch);
    assert.ok(
      x.c.snapshot.items.some(({ text }) =>
        text.includes(`#12 is ${state.toLowerCase()}`),
      ),
    );
    gate.open();
    x.a.a.gate = undefined;
    await x.c.send('continue the task');
    await x.observe();
    assert.equal(x.c.copilot.ready(), false);
    assert.equal(x.reviews().length, 1);
  });
}

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
      const claim = (await record(x.f, x.a)).copilotReviews![0]!.claim!;
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
      (await record(x.f, x.a)).copilotReviews![0]!.items.every(
        ({ status }) => status === 'blocked',
      ),
    );
    assert.equal(x.reviews().length, 1);
    assert.ok((await record(x.f, x.a)).copilotReviews![0]!.batch);
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
    (await record(x.f, reopened)).copilotReviews![0]!.items.every(
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

for (const kind of ['thread', 'reply']) {
  test(`missing ${kind} evidence is verified after restart without repeating the native attempt`, async (t) => {
    const x = await setup(t);
    let complete: GitHubReviews;
    const session = x.a.a.sessions.at(-1)!.session;
    const send = session.send;
    session.send = async (...args) => {
      if (args[3] === 'pr-review') {
        await reply(x.f, x.a, x.source);
        complete = structuredClone(x.source);
        if (kind === 'thread') x.source.threads = [];
        else x.source.threads[0]!.comments.pop();
      }
      return send(...args);
    };
    await x.observe();
    await until(
      'verification waiting for GitHub evidence',
      async () =>
        x.c.snapshot.phase === 'idle' &&
        !x.c.snapshot.reviewing &&
        !!(await record(x.f, x.a)).copilotReviews![0]!.batch?.verifying,
    );
    const waiting = (await record(x.f, x.a)).copilotReviews![0]!;
    assert.ok(
      waiting.items.every(
        ({ status, receipts }) => status === 'attempted' && !receipts.length,
      ),
    );
    assert.equal(x.reviews().length, 1);
    await x.c.send('continue the task');
    assert.equal(x.reviews().length, 1);
    const id = x.c.snapshot.conversation!.id;
    await x.c.close({ restart: true });
    const reopened = await x.f.start('A', { conversation: id });
    reopened.coordination.updateRepository(x.repository);
    reopened.coordinator.copilot.updateRepository(x.repository);
    await reopened.coordinator.copilot.observe(structuredClone(x.source));
    assert.equal(
      (await record(x.f, reopened)).copilotReviews![0]!.batch!.id,
      waiting.batch!.id,
    );
    assert.equal(reopened.coordinator.copilot.ready(), false);
    Object.assign(x.source, complete!);
    await reopened.coordinator.copilot.observe(structuredClone(x.source));
    const settled = (await record(x.f, reopened)).copilotReviews![0]!;
    assert.ok(settled.items.every(({ status }) => status === 'handled'));
    assert.equal(settled.batch, undefined);
    assert.equal(reopened.a.inputs.length, 0);
    assert.equal(
      x.source.threads[0]!.comments.filter(
        ({ author }) => author?.login === 'owner',
      ).length,
      1,
    );
  });
}

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
      saved.copilotReviews![0]!.items.map(({ id, status }) => [id, status]),
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
    (await record(x.f, x.a)).copilotReviews![0]!.items.every(
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
  assert.ok((await record(x.f, x.a)).copilotReviews![0]!.batch);
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
    claim: state.copilotReviews![0]!.claim!,
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

test('a closed native session reconnects without revoking the retained review claim', async (t) => {
  const x = await setup(t);
  await x.a.a.sessions.at(-1)!.session.close();
  const connect = x.a.a.connect.bind(x.a.a);
  vi.spyOn(x.a.a, 'connect').mockImplementation(async (options) => {
    const session = await connect(options);
    autoReply(x.f, x.a, x.source);
    return session;
  });
  await x.observe();
  await x.handled();
  assert.equal(x.reviews().length, 1);
  assert.equal(x.a.a.sessions.length, 2);
  assert.ok(
    !x.c.snapshot.items.some(({ text }) =>
      text.includes('branch or task ownership changed'),
    ),
  );
});

test('a final ownership check that proves input unsent leaves feedback pending for a later observation', async (t) => {
  const x = await setup(t);
  let withdrawn = false;
  vi.spyOn(
    x.a.a.sessions.at(-1)!.session,
    'contextUsage',
  ).mockImplementationOnce(async () => {
    x.a.coordination.updateRepository({
      ...x.repository,
      pullRequest: undefined,
    });
    withdrawn = true;
    return undefined;
  });
  await x.observe();
  await until('proven unsent review settlement', async () => {
    const state = (await record(x.f, x.a)).copilotReviews![0]!;
    return (
      withdrawn &&
      x.c.snapshot.phase === 'idle' &&
      !x.c.snapshot.reviewing &&
      !state.batch &&
      state.items.every(({ status }) => status === 'pending')
    );
  });
  assert.equal(x.reviews().length, 0);
  assert.ok(
    !x.c.snapshot.items.some(({ text }) =>
      text.includes('outcome is uncertain'),
    ),
  );
  x.a.coordination.updateRepository(x.repository);
  autoReply(x.f, x.a, x.source);
  await x.observe();
  await x.handled();
  assert.equal(x.reviews().length, 1);
});

test('a peer arriving during the review read retains priority without losing the review batch', async (t) => {
  const x = await setup(t);
  const b = await x.f.start('B');
  await b.claim('task:asker');
  autoReply(x.f, x.a, x.source);
  vi.mocked(github.readGitHubReviews).mockImplementationOnce(async () => {
    const result = await callControl(await b.binding(), {
      kind: 'ask',
      claim: x.a.coordination.snapshot.ownClaim!.id,
      message: 'What did this task find?',
    });
    assert.equal(result.kind, 'peer-request');
    await x.a.coordination.context();
    return structuredClone(x.source);
  });
  await x.observe();
  await x.handled();
  assert.deepEqual(
    x.a.a.inputs.map(({ prompt }) =>
      prompt === answerInstruction ? 'peer' : 'review',
    ),
    ['peer', 'review'],
  );
});

test('an uncertain batch with new feedback does not cause admission reads before a user prompt', async (t) => {
  const x = await setup(t);
  const gate = new TurnGate();
  x.a.a.gate = gate;
  await x.observe();
  await within(gate.entered, 5000, 'review dispatch');
  await x.c.interrupt();
  gate.open();
  await until(
    'uncertain review settlement',
    async () =>
      !x.c.snapshot.reviewing &&
      (await record(x.f, x.a)).copilotReviews![0]!.items.every(
        ({ status }) => status === 'blocked',
      ),
  );
  x.source.threads.push({ ...x.source.threads[0]!, id: 'thread-2' });
  vi.mocked(github.readGitHubReviews).mockClear();
  await x.observe();
  await x.a.coordination.context();
  assert.equal(x.c.copilot.ready(), false);
  assert.equal(vi.mocked(github.readGitHubReviews).mock.calls.length, 0);
  assert.equal(x.reviews().length, 1);
  assert.equal(
    (await record(x.f, x.a)).copilotReviews![0]!.items.find(
      ({ id }) => id === 'thread-2',
    )!.status,
    'pending',
  );
});

test('an unrelated user prompt does not retry dispositions explicitly blocked for authorization', async (t) => {
  const x = await setup(t);
  const session = x.a.a.sessions.at(-1)!.session;
  const send = session.send;
  vi.spyOn(session, 'send').mockImplementation(async (...args) => {
    if (args[3] === 'pr-review') {
      const batch = (await record(x.f, x.a)).copilotReviews![0]!.batch!;
      await writeFile(
        batch.result,
        JSON.stringify({
          batch: batch.id,
          items: batch.items.map((item) => ({
            ...item,
            disposition: 'blocked',
            reason: 'Needs new authorization.',
          })),
        }),
      );
    }
    return send(...args);
  });
  await x.observe();
  await until(
    'blocked dispositions',
    async () =>
      !x.c.snapshot.reviewing &&
      (await record(x.f, x.a)).copilotReviews![0]!.items.every(
        ({ status }) => status === 'blocked',
      ),
  );
  await x.c.send('an unrelated question');
  await x.observe();
  assert.equal(x.c.copilot.ready(), false);
  assert.equal(x.reviews().length, 1);
  const state = (await record(x.f, x.a)).copilotReviews![0]!;
  assert.equal(state.batch, undefined);
  assert.ok(
    state.items.every(
      ({ status, reason }) =>
        status === 'blocked' && reason === 'Needs new authorization.',
    ),
  );
});

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
      admitted = x.c.copilot.context()!.batch;
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
      x.c.copilot.context()!.pullRequest.url,
      x.source.pullRequest.url,
    );
    assert.equal(x.c.copilot.context()!.batch?.id, original.batch?.id);
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
    admitted = x.c.copilot.context()!.batch;
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
    .items.find(({ id }) => id === 'review-1')!;
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
  assert.ok(
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
    if (args[3] === 'pr-review') {
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
  assert.ok(
    x.c.snapshot.items.some(({ text }) => text.includes('Waiting for GitHub')),
  );
  session.send = async (...args) => {
    if (args[0] === 'reconcile the previous review result') {
      assert.ok(args[2]?.includes(batch.result));
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
    } else if (args[3] === 'pr-review') await reply(x.f, x.a, x.source);
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
