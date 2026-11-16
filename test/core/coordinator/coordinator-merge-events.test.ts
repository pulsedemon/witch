import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, vi } from 'vitest';
import { CodexAdapter } from '../../../src/agents/codex/adapter.js';
import { unreportedContextCatalog } from '../../fixtures/codex-adapter.js';
import { ClaudeAdapter } from '../../../src/agents/claude/adapter.js';
import type { Coordinator } from '../../../src/core/coordinator.js';
import type { SessionCoordination } from '../../../src/core/coordination/coordination.js';
import type { MergeEvent } from '../../../src/core/repository/merge-events.js';
import type {
  PullRequest,
  Repository,
} from '../../../src/core/repository/repository.js';
import { CoordinationStore } from '../../../src/persistence/coordination.js';
import { TurnGate } from '../../fixtures/agent.js';
import { coordinationFixture, git } from '../../fixtures/coordination.js';
import { until, within } from '../../fixtures/within.js';
import { repositoryRead } from '../../fixtures/repository.js';

const merged: PullRequest = {
  number: 17,
  url: 'https://github.com/example/project/pull/17',
  state: 'MERGED',
  branch: 'feat/events',
  base: 'release',
  commit: 'head-23',
};

const repository = (pullRequest = merged): Repository =>
  repositoryRead({
    branch: pullRequest.branch,
    staged: 1,
    modified: 1,
    pullRequest,
  });

async function observe(
  client: { coordinator: Coordinator; coordination: SessionCoordination },
  pullRequest = merged,
): Promise<void> {
  const { project } = await client.coordinator.memory.scopePaths(
    client.coordinator.snapshot.conversation!.cwd,
  );

  client.coordination.updateRepository({
    ...repository(pullRequest),
    pullRequestProject: project,
  });
}

const notices = (coordinator: Coordinator) =>
  coordinator.snapshot.items.filter(({ id }) =>
    id.startsWith('project-merge/'),
  );

const events = (context: string): MergeEvent[] => {
  const paragraph = context
    .split('\n\n')
    .find((text) => text.startsWith('Witch observed these project merges.'));

  return paragraph
    ? (JSON.parse(paragraph.slice(paragraph.indexOf('\n') + 1)) as MergeEvent[])
    : [];
};

test('busy and dirty observers publish once to open project peers without starting turns', async (t) => {
  const f = await coordinationFixture(t.onTestFinished);
  const a = await f.start('A');
  const b = await f.start('B');
  const unrelated = await f.start('C');
  const gate = new TurnGate();
  a.a.gate = gate;
  t.onTestFinished(() => gate.open());
  const running = a.coordinator.send('author work');
  await gate.entered;
  await observe(a);
  await observe(b);

  await until(
    'both notices',
    () =>
      notices(a.coordinator).length === 1 &&
      notices(b.coordinator).length === 1,
  );

  assert.equal(a.coordinator.snapshot.phase, 'running');
  assert.equal(b.coordinator.snapshot.phase, 'idle');
  assert.equal(b.a.inputs.length, 0);
  assert.equal(unrelated.a.inputs.length, 0);
  assert.deepEqual(notices(unrelated.coordinator), []);
  assert.equal(notices(a.coordinator)[0]!.id, notices(b.coordinator)[0]!.id);
  const late = await f.start('A');
  await observe(late);
  await late.coordinator.send('late conversation');
  assert.deepEqual(events(late.a.inputs.at(-1)!.context!), []);
  assert.deepEqual(notices(late.coordinator), []);
  gate.open();
  await running;
});

test('native receipts and stable notices survive restart and a runtime switch', async (t) => {
  const f = await coordinationFixture(t.onTestFinished);
  const a = await f.start('A');
  const b = await f.start('B');
  await observe(a);
  await until('recipient notice', () => notices(b.coordinator).length === 1);
  const prompt = '  continue this task\nkeep the exact request  ';
  await b.coordinator.send(prompt);
  assert.equal(b.a.inputs.at(-1)!.prompt, prompt);
  const [delivered] = events(b.a.inputs.at(-1)!.context!);
  assert.deepEqual(delivered!.pullRequest, merged);
  assert.equal(delivered!.source, a.coordinator.snapshot.conversation!.id);

  assert.match(
    b.a.inputs.at(-1)!.context!,
    /not user requests or authorization/,
  );

  const id = b.coordinator.snapshot.conversation!.id;
  await b.coordinator.close();

  const history = (
    await readFile(
      join(f.store.root, 'conversations', id, 'history.jsonl'),
      'utf8',
    )
  )
    .trim()
    .split('\n')
    .map((line: string) => JSON.parse(line) as { id: string });

  assert.equal(
    history.filter((row) => row.id === `project-merge/${delivered!.id}`).length,
    1,
  );

  const reopened = await f.start('B', { conversation: id });
  await reopened.coordinator.send('after restart');
  assert.deepEqual(events(reopened.a.inputs.at(-1)!.context!), []);
  assert.equal(notices(reopened.coordinator).length, 1);
  await reopened.coordinator.selectModel({ agent: 'b', id: 'b-model' });
  assert.equal(reopened.b.inputs.length, 0);
  await reopened.coordinator.send('first request on the destination');
  assert.deepEqual(events(reopened.b.inputs.at(-1)!.context!), [delivered]);
  await reopened.coordinator.send('same runtime again');
  assert.deepEqual(events(reopened.b.inputs.at(-1)!.context!), []);
});

test('a merge arriving during a turn remains pending after that turn completes', async (t) => {
  const f = await coordinationFixture(t.onTestFinished);
  const a = await f.start('A');
  const b = await f.start('B');
  await observe(a);
  await until('first merge', () => notices(b.coordinator).length === 1);
  const gate = new TurnGate();
  b.a.gate = gate;
  t.onTestFinished(() => gate.open());
  const running = b.coordinator.send('recipient work');
  await gate.entered;

  const second = {
    ...merged,
    number: 31,
    url: 'https://github.com/example/project/pull/31',
    commit: 'head-47',
  };

  await observe(a, second);
  await until('second merge', () => notices(b.coordinator).length === 2);

  assert.deepEqual(
    events(b.a.inputs.at(-1)!.context!).map(({ pullRequest }) => pullRequest),
    [merged],
  );

  gate.open();
  await running;
  await b.coordinator.send('next turn');

  assert.deepEqual(
    events(b.a.inputs.at(-1)!.context!).map(({ pullRequest }) => pullRequest),
    [second],
  );
});

test('interruption and confirmed compaction retain events for the next native turn', async (t) => {
  const f = await coordinationFixture(t.onTestFinished);
  const a = await f.start('A');
  await observe(a);
  await until('merge notice', () => notices(a.coordinator).length === 1);
  a.a.interruptNext = true;
  await a.coordinator.send('interrupted delivery');
  const delivered = events(a.a.inputs.at(-1)!.context!);
  await a.coordinator.send('retry');
  assert.deepEqual(events(a.a.inputs.at(-1)!.context!), delivered);
  await a.coordinator.send('completed delivery');
  assert.deepEqual(events(a.a.inputs.at(-1)!.context!), []);
  a.a.sessions.at(-1)!.options.onEvent({ type: 'compacted' });
  await a.coordinator.send('after compaction');
  assert.deepEqual(events(a.a.inputs.at(-1)!.context!), delivered);
  assert.equal(notices(a.coordinator).length, 1);
});

test('conversation and project changes do not inherit another recipient scope', async (t) => {
  const f = await coordinationFixture(t.onTestFinished);
  const a = await f.start('A');
  const b = await f.start('B');
  await observe(a);
  await until('merge notice', () => notices(b.coordinator).length === 1);
  const recipient = b.coordinator.snapshot.conversation!.id;
  await b.coordinator.newConversation();
  await b.coordinator.send('new conversation');
  assert.deepEqual(events(b.a.inputs.at(-1)!.context!), []);
  assert.equal(notices(b.coordinator).length, 0);
  await b.coordinator.selectConversation(recipient);
  assert.equal(notices(b.coordinator).length, 1);

  await git(
    '-C',
    join(f.root, 'B'),
    'remote',
    'set-url',
    'origin',
    join(f.root, 'other'),
  );

  await b.coordinator.send('different project');
  assert.deepEqual(events(b.a.inputs.at(-1)!.context!), []);
});

test('an open recipient retains merges while its native activation is reconnecting', async (t) => {
  const f = await coordinationFixture(t.onTestFinished);
  const source = await f.start('A');
  const recipient = await f.start('B');
  const id = recipient.coordinator.snapshot.conversation!.id;
  const deactivated = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();

  const deactivate = recipient.coordination.deactivate.bind(
    recipient.coordination,
  );

  const closing = vi
    .spyOn(recipient.coordination, 'deactivate')
    .mockImplementation(async () => {
      await deactivate();
      deactivated.resolve();
      await resume.promise;
    });

  const switching = recipient.coordinator.selectModel({
    agent: 'b',
    id: 'b-model',
  });

  try {
    await within(deactivated.promise, 5000, 'native activation removed');

    assert.equal(
      (await f.store.openConversations()).get(id)?.coordinated,
      true,
    );

    assert.equal(
      (await f.registry.presences()).some((presence) => presence.id === id),
      false,
    );

    await observe(source);

    await until(
      'merge published during reconnect',
      () => notices(source.coordinator).length === 1,
    );

    resume.resolve();
    await switching;
    assert.equal(notices(recipient.coordinator).length, 1);
    assert.equal(recipient.b.inputs.length, 0);
    await recipient.coordinator.send('read after reconnect');

    assert.deepEqual(
      events(recipient.b.inputs.at(-1)!.context!).map(
        ({ pullRequest }) => pullRequest,
      ),
      [merged],
    );
  } finally {
    resume.resolve();
    await switching;
    closing.mockRestore();
  }
});

test('idle origin changes use the current project for recipients and notices', async (t) => {
  const f = await coordinationFixture(t.onTestFinished);
  const source = await f.start('A');
  const recipient = await f.start('B');
  const other = await f.start('C');

  await git(
    '-C',
    join(f.root, 'B'),
    'remote',
    'set-url',
    'origin',
    join(f.root, 'other'),
  );

  await observe(source);

  await until(
    'old project publication',
    () => notices(source.coordinator).length === 1,
  );

  const current = {
    ...merged,
    number: 31,
    url: 'https://github.com/example/other/pull/31',
    commit: 'head-47',
  };

  await observe(other, current);

  await until(
    'current project notice without a user turn',
    () =>
      notices(recipient.coordinator).some(({ text }) => text.includes('#31')),
    500,
  );

  assert.equal(notices(recipient.coordinator).length, 1);
  assert.equal(recipient.a.inputs.length, 0);
  await recipient.coordinator.send('current project work');

  assert.deepEqual(
    events(recipient.a.inputs.at(-1)!.context!).map(
      ({ pullRequest }) => pullRequest,
    ),
    [current],
  );
});

test('merge notices leave memory recovery and queued user input intact', async (t) => {
  const f = await coordinationFixture(t.onTestFinished);
  const a = await f.start('A');
  a.a.interruptNext = true;
  await a.coordinator.send('remember-port');
  assert.equal(a.coordinator.snapshot.phase, 'recovery');
  await a.coordinator.send('queued user request');
  await observe(a);

  await until(
    'notice during recovery',
    () => notices(a.coordinator).length === 1,
  );

  assert.equal(a.coordinator.snapshot.phase, 'recovery');
  assert.deepEqual(a.coordinator.snapshot.queue, ['queued user request']);
  assert.equal(a.a.inputs.length, 1);
  await a.coordinator.recoverMemory('discard');

  await until(
    'queued turn',
    () => a.a.inputs.length === 2 && a.coordinator.snapshot.phase === 'idle',
  );

  assert.equal(a.a.inputs[1]!.prompt, 'queued user request');

  assert.deepEqual(
    events(a.a.inputs[1]!.context!).map(({ pullRequest }) => pullRequest),
    [merged],
  );
});

for (const name of ['codex', 'claude'] as const) {
  test(`${name} receives the merge context through its native protocol`, async (t) => {
    const f = await coordinationFixture(t.onTestFinished);
    const source = await f.start('A');
    const cwd = join(f.root, 'B');

    const executable = fileURLToPath(
      new URL(`../../fixtures/${name}.mjs`, import.meta.url),
    );

    const launch = (signal?: AbortSignal) =>
      spawn(process.execPath, [executable], { cwd, stdio: 'pipe', signal });

    const adapter =
      name === 'codex'
        ? new CodexAdapter(
            (_, __, signal) => launch(signal),
            unreportedContextCatalog,
          )
        : new ClaudeAdapter((options) => {
            if (!options.args.includes('--no-session-persistence'))
              return launch(options.signal);

            const directory = join(cwd, 'usage');
            mkdirSync(directory, { recursive: true });

            return spawn(process.execPath, [executable, 'background'], {
              cwd: directory,
              stdio: 'pipe',
              signal: options.signal,
            });
          });

    const recipient = await f.start('B', {}, [{ adapter, executable }]);
    const answered = new Set<string>();

    const stop = recipient.coordinator.subscribe(() => {
      for (const request of recipient.coordinator.snapshot.requests) {
        if (answered.has(request.id)) continue;

        answered.add(request.id);
        void recipient.coordinator.respond(request.id, { decision: 'accept' });
      }
    });

    t.onTestFinished(stop);
    await observe(source);

    await until(
      'native recipient notice',
      () => notices(recipient.coordinator).length === 1,
    );

    const prompt = '  exact native request  ';
    await within(recipient.coordinator.send(prompt), 10_000, 'native turn');
    assert.equal(recipient.coordinator.snapshot.phase, 'idle');
    assert.equal(recipient.coordinator.snapshot.error, undefined);

    if (name === 'codex') {
      const injection = JSON.parse(
        await readFile(join(cwd, 'context.json'), 'utf8'),
      ) as { items: { content: { text: string }[] }[] };

      assert.deepEqual(
        events(injection.items[0]!.content[0]!.text).map(
          ({ pullRequest }) => pullRequest,
        ),
        [merged],
      );

      const input = JSON.parse(
        await readFile(join(cwd, 'prompt.json'), 'utf8'),
      ) as { params: { input: { text: string }[] } };

      assert.equal(input.params.input[0]!.text, prompt);

      assert.equal(
        await readFile(join(cwd, 'approved.txt'), 'utf8'),
        'approved',
      );
    } else {
      const content = JSON.parse(
        await readFile(join(cwd, 'content.json'), 'utf8'),
      ) as string;

      assert.deepEqual(
        events(content).map(({ pullRequest }) => pullRequest),
        [merged],
      );

      assert.ok(content.endsWith(`User request:\n${prompt}`));
    }
  });
}

test('failed publication retries the captured observation after the source leaves its branch', async (t) => {
  const f = await coordinationFixture(t.onTestFinished);
  const source = await f.start('A');
  const recipient = await f.start('B');
  const original = CoordinationStore.prototype.recordMerge;
  let attempts = 0;

  vi.spyOn(CoordinationStore.prototype, 'recordMerge').mockImplementation(
    function (this: CoordinationStore, ...args) {
      if (++attempts === 1)
        return Promise.reject(new Error('merge publication unavailable'));

      return original.apply(this, args);
    },
  );

  await observe(source);

  await until(
    'publication failure',
    () =>
      !!source.coordination.snapshot.error?.includes(
        'merge publication unavailable',
      ),
  );

  source.coordination.updateRepository({
    ...repository(),
    branch: 'main',
    pullRequest: undefined,
  });

  const late = await f.start('A');

  await until(
    'retried publication',
    () => notices(recipient.coordinator).length === 1,
  );

  assert.deepEqual(notices(late.coordinator), []);
  await recipient.coordinator.send('read recovered observation');

  assert.deepEqual(
    events(recipient.a.inputs.at(-1)!.context!).map(
      ({ pullRequest }) => pullRequest,
    ),
    [merged],
  );

  assert.equal(source.coordination.snapshot.error, undefined);
});

const projectOf = async (client: { coordinator: Coordinator }) =>
  (
    await client.coordinator.memory.scopePaths(
      client.coordinator.snapshot.conversation!.cwd,
    )
  ).project;

test("a followed pull request's merge is announced from another branch", async (t) => {
  {
    const f = await coordinationFixture(t.onTestFinished);
    const source = await f.start('A');
    const peer = await f.start('B');
    const followedPeer = await f.start('C');

    source.coordination.updateRepository(
      repositoryRead({
        branch: 'main',
        pullRequestProject: await projectOf(source),
        followed: [merged],
        followedProject: await projectOf(followedPeer),
      }),
    );

    await until(
      'merge notice',
      () => notices(followedPeer.coordinator).length === 1,
    );

    assert.deepEqual(notices(peer.coordinator), []);
    await followedPeer.coordinator.send('read the merge');

    assert.deepEqual(
      events(followedPeer.a.inputs.at(-1)!.context!).map(
        ({ pullRequest: { url, commit } }) => ({ url, commit }),
      ),
      [{ url: merged.url, commit: merged.commit }],
    );
  }

  const f = await coordinationFixture(t.onTestFinished);
  const source = await f.start('A');
  const peer = await f.start('B');

  source.coordination.updateRepository(
    repositoryRead({
      branch: 'main',
      pullRequestProject: await projectOf(source),
      followed: [merged],
    }),
  );

  // merges publish in the order observed, so this one arrives after any the update above recorded
  const own = { ...merged, number: 18, url: `${merged.url.slice(0, -2)}18` };
  await observe(source, own);
  await until('the later merge', () => notices(peer.coordinator).length > 0);
  await peer.coordinator.send('read the merges');

  assert.deepEqual(
    events(peer.a.inputs.at(-1)!.context!).map(
      ({ pullRequest: { url } }) => url,
    ),
    [own.url],
  );
});

test('a merge publishes and control queries answer while another open conversation has lost its directory', async (t) => {
  const f = await coordinationFixture(t.onTestFinished);
  const source = await f.start('A');
  const recipient = await f.start('B');
  await f.start('C');
  await rename(join(f.root, 'C'), join(f.root, 'C-moved'));
  await observe(source);

  await until(
    'merge delivered',
    () => notices(recipient.coordinator).length === 1,
  );

  assert.deepEqual(
    (await source.query()).peers.map(({ presence }) => presence.id),
    [recipient.coordinator.snapshot.conversation!.id],
  );
});
