import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test, vi } from 'vitest';
import * as github from '../src/core/github-reviews.js';
import type { GitHubReviews } from '../src/core/github-reviews.js';
import { callControl } from '../src/persistence/control.js';
import { RepositoryWatch } from '../src/core/repository.js';
import { watchCopilotReviews } from '../src/core/copilot-review-watch.js';
import { answerInstruction } from '../src/core/peer-requests.js';
import { TurnGate } from './fixtures/agent.js';
import { git } from './fixtures/coordination.js';
import { autoReply, record, reply, setup } from './fixtures/copilot-reviews.js';
import { until, within } from './fixtures/within.js';

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

test("a review turn's ownership check reuses the project its turn read", async (t) => {
  const x = await setup(t);
  const owns = vi.spyOn(x.a.coordination.reviews, 'owns');

  autoReply(x.f, x.a, x.source);

  await x.observe();

  await x.handled();

  assert.equal(x.reviews().length, 1);

  assert.ok(
    owns.mock.calls.some(
      ([, , project]) => project === x.repository.pullRequestProject,
    ),
  );
});

test('unmatched feedback reports one blocker until a matching claim admits it', async (t) => {
  const x = await setup(t);

  await x.a.coordination.releaseTask();

  const notices = () =>
    x.c.snapshot.items.filter(({ text }) =>
      text.includes('needs a matching task claim'),
    ).length;

  assert.equal(await x.observe(), false);

  assert.equal(await x.observe(), false);

  assert.equal((await record(x.f, x.a)).copilotReviews, undefined);

  assert.equal(x.reviews().length, 0);

  assert.equal(notices(), 1);

  const claimed = await x.a.claim(x.source.closingIssues[0]!);

  assert.ok(claimed.kind === 'claimed');

  autoReply(x.f, x.a, x.source);

  await x.observe();

  await x.handled();

  assert.equal(
    (await record(x.f, x.a)).copilotReviews![0]!.claim,
    claimed.claim.id,
  );

  assert.equal(x.reviews().length, 1);

  await x.a.coordination.releaseTask();

  assert.equal(await x.observe(), false);

  assert.equal(await x.observe(), false);

  assert.equal(notices(), 2);

  assert.equal(x.reviews().length, 1);
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
      if (args[1]?.purpose === 'pr-review') {
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

    await until('persisted recovery failure and its notice', async () => {
      const reason = (await record(x.f, x.a)).copilotReviews?.[0]?.batch
        ?.reason;

      return (
        !x.c.snapshot.reviewing &&
        !!reason?.includes('could not be verified') &&
        x.c.snapshot.items.some(({ text }) => text.includes(reason))
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
    if (args[1]?.purpose === 'pr-review' && respond) {
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
      if (args[1]?.purpose === 'pr-review') {
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

test('a review the agent never read leaves feedback pending and the user queue empty', async (t) => {
  const x = await setup(t);

  const send = vi
    .spyOn(x.a.a.sessions.at(-1)!.session, 'send')
    .mockImplementationOnce(async () => ({
      status: 'interrupted',
      text: '',
      inputUnread: true,
    }));

  await x.observe();

  await until('unread review settlement', async () => {
    const state = (await record(x.f, x.a)).copilotReviews![0]!;

    return (
      send.mock.calls.length === 1 &&
      x.c.snapshot.phase === 'idle' &&
      !x.c.snapshot.reviewing &&
      !state.batch &&
      state.items.every(({ status }) => status === 'pending')
    );
  });

  assert.deepEqual(x.c.snapshot.queue, []);
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
    if (args[1]?.purpose === 'pr-review') {
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
