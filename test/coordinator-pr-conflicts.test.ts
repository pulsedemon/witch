import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import type { TestContext } from 'vitest';
import * as github from '../src/core/github-reviews.js';
import { answerInstruction } from '../src/core/peer-requests.js';
import { watchConflicts } from '../src/core/pr-conflicts.js';
import { conversationRecordSchema } from '../src/core/state.js';
import type { PullRequest, Repository } from '../src/core/repository.js';
import { callControl } from '../src/persistence/control.js';
import { TurnGate } from './fixtures/agent.js';
import { reviewSource } from './fixtures/github-reviews.js';
import { orderedCleanup } from './fixtures/cleanup.js';
import { fixture } from './fixtures/coordinator.js';
import { coordinationFixture, git } from './fixtures/coordination.js';
import { until, within } from './fixtures/within.js';

test("every turn carries the branch's pull request conflict until it clears", async () => {
  const f = await fixture();
  try {
    const pullRequest = {
      number: 7,
      url: 'https://github.com/o/r/pull/7',
      state: 'OPEN' as const,
      branch: 'feat/x',
      commit: 'a1b2c3',
      base: 'main',
      checks: 'passing' as const,
      mergeable: 'CONFLICTING' as const,
    };
    f.coordinator.conflict = { pullRequest, baseTip: 'f00' };
    await f.coordinator.send('First');
    assert.match(
      f.a.inputs.at(-1)!.context!,
      /^Witch confirmed on GitHub that pull request #7 \(https:\/\/github\.com\/o\/r\/pull\/7\) at head a1b2c3 conflicts with its base branch main, whose tip was f00 when observed, and hasn't confirmed a resolution since\. Passing checks do not make it mergeable\./m,
    );
    f.coordinator.conflict = { pullRequest };
    await f.coordinator.send('Second');
    assert.match(
      f.a.inputs.at(-1)!.context!,
      /^Witch confirmed on GitHub that pull request #7 \S+ at head a1b2c3 conflicts with its base branch main and hasn't confirmed/m,
    );
    f.coordinator.conflict = undefined;
    await f.coordinator.send('Third');
    assert.doesNotMatch(f.a.inputs.at(-1)!.context ?? '', /pull request #7/);
  } finally {
    await f.coordinator.close();
  }
});

const head = (n: number) => String(n).repeat(40);
const repairPrefix = 'Witch started this turn to repair the merge conflict';

/** a session that claims pull request #7 on `feat/x`, with a way to feed it repository reads. */
async function setup(t: TestContext, name = 'A') {
  const register = orderedCleanup(t.onTestFinished);
  const f = await coordinationFixture(register, async (references) => ({
    assigned: references,
  }));
  const x = await f.start(name);
  const c = x.coordinator;
  const cwd = c.snapshot.conversation!.cwd;
  await git('-C', cwd, 'symbolic-ref', 'HEAD', 'refs/heads/feat/x');
  const project = (await f.memory.scopePaths(cwd)).project;
  const pullRequest = (fields: Partial<PullRequest> = {}): PullRequest => ({
    number: 7,
    url: 'https://github.com/o/r/pull/7',
    state: 'OPEN',
    branch: 'feat/x',
    commit: head(1),
    base: 'main',
    checks: 'passing',
    mergeable: 'CONFLICTING',
    ...fields,
  });
  /** a read of the pull request; a conflicting one carries its conflict, as `RepositoryWatch` publishes it. */
  const read = (
    fields: Partial<PullRequest> = {},
    kept?: PullRequest,
  ): Repository => {
    const current = pullRequest(fields);
    const conflict = current.mergeable === 'CONFLICTING' ? current : kept;
    return {
      branch: 'feat/x',
      ahead: 0,
      behind: 0,
      staged: 0,
      modified: 0,
      conflicts: 0,
      untracked: 0,
      pullRequest: current,
      pullRequestProject: project,
      ...(conflict
        ? { conflict: { pullRequest: conflict, baseTip: 'f00' } }
        : {}),
    };
  };
  const observe = (
    repository: Repository,
    client: { coordinator: typeof c; coordination: typeof x.coordination } = x,
  ) => {
    client.coordination.updateRepository(repository);
    client.coordinator.conflict = repository.conflict;
    client.coordinator.repair.observe(repository);
  };
  await x.claim(pullRequest().url, 'repair task');
  const repairs = (agent = x.a) =>
    agent.inputs.filter(({ prompt }) => prompt.startsWith(repairPrefix));
  const idle = (coordinator = c) =>
    until('idle', () => coordinator.snapshot.phase === 'idle');
  const record = async (client = x) =>
    conversationRecordSchema.parse(
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
  const notices = (coordinator = c) =>
    coordinator.snapshot.items
      .filter(({ kind }) => kind === 'notice')
      .map(({ text }) => text);
  return {
    f,
    x,
    c,
    cwd,
    pullRequest,
    read,
    observe,
    repairs,
    idle,
    record,
    notices,
  };
}

test('a conflict on the claimed pull request starts one repair turn per head and base, with its own instruction', async (t) => {
  const s = await setup(t);
  s.observe(s.read());
  await until('repair', () => s.repairs().length === 1);
  await s.idle();
  const [repair] = s.repairs();
  assert.equal(repair!.author, 'witch');
  assert.match(
    repair!.prompt,
    new RegExp(
      `pull request https://github\\.com/o/r/pull/7: head ${head(1)} conflicts with main, whose tip was f00\\.`,
    ),
  );
  assert.match(repair!.prompt, /without rebasing/);
  assert.match(repair!.prompt, /Don't merge or edit the pull request/);
  assert.doesNotMatch(repair!.context ?? '', /Witch confirmed on GitHub/);
  assert.ok(
    s.c.snapshot.items.some(
      ({ text }) => text === 'Repairing the conflict on #7 with main.',
    ),
  );
  assert.deepEqual((await s.record()).conflictRepairs, [
    { url: s.pullRequest().url, commit: head(1), base: 'main' },
  ]);
  s.observe(s.read());
  assert.equal(s.c.repair.ready(), false, 'the same head and base');
  await s.c.send('continue');
  await s.idle();
  assert.equal(s.repairs().length, 1);
  s.observe(s.read({ commit: head(2) }));
  await until('second repair', () => s.repairs().length === 2);
});

test('a conflict kept through an uncomputed read, or on an unclaimed pull request, starts no repair', async (t) => {
  const s = await setup(t);
  const conflicting = s.pullRequest();
  s.observe(s.read({ mergeable: 'UNKNOWN', commit: head(2) }, conflicting));
  assert.equal(s.c.repair.ready(), false, 'a pushed head');
  s.observe(s.read({ mergeable: 'UNKNOWN', base: 'release' }, conflicting));
  assert.equal(s.c.repair.ready(), false, 'a new base');
  await s.c.send('work');
  await s.idle();
  assert.equal(s.repairs().length, 0);
  const result = await callControl(await s.x.binding(), {
    kind: 'release',
    claim: s.x.coordination.snapshot.ownClaim!.id,
  });
  assert.equal(result.kind, 'released');
  await s.x.claim('task:other', 'other work');
  s.observe(s.read());
  await s.c.send('more work');
  await s.idle();
  assert.equal(s.repairs().length, 0);
  assert.ok(
    !s.notices().some((text) => text.startsWith("Witch didn't repair")),
  );
  await callControl(await s.x.binding(), {
    kind: 'release',
    claim: s.x.coordination.snapshot.ownClaim!.id,
  });
  await s.x.claim(s.pullRequest().url, 'repair task');
  await until('repair after the claim', () => s.repairs().length === 1);
});

test('a repair waits for the running and queued user turns, and a prompt sent during it queues', async (t) => {
  const s = await setup(t);
  const gate = new TurnGate();
  s.x.a.gate = gate;
  const first = s.c.send('long user turn');
  await within(gate.entered, 5000, 'user turn');
  // a refused steer leaves the prompt queued for a turn of its own
  s.x.a.refuseSteer = true;
  await s.c.send('queued user turn');
  s.observe(s.read());
  gate.open();
  s.x.a.gate = undefined;
  await first;
  s.x.a.refuseSteer = false;
  await until('repair', () => s.repairs().length === 1);
  const prompts = s.x.a.inputs.map(({ prompt }) =>
    prompt.startsWith(repairPrefix) ? 'repair' : prompt,
  );
  assert.deepEqual(prompts, ['long user turn', 'queued user turn', 'repair']);
  await s.idle();

  const second = new TurnGate();
  s.x.a.gate = second;
  s.observe(s.read({ commit: head(2) }));
  await within(second.entered, 5000, 'second repair');
  await s.c.send('sent during the repair');
  assert.deepEqual(s.c.snapshot.queue, ['sent during the repair']);
  assert.deepEqual(s.x.a.steers, []);
  second.open();
  s.x.a.gate = undefined;
  await until('queued prompt ran', () =>
    s.x.a.inputs.some(({ prompt }) => prompt === 'sent during the repair'),
  );
});

test('a stopped repair holds automatic turns until the next prompt and is never repeated', async (t) => {
  const s = await setup(t);
  const gate = new TurnGate();
  s.x.a.gate = gate;
  s.observe(s.read());
  await within(gate.entered, 5000, 'repair');
  await s.c.interrupt();
  await s.idle();
  s.x.a.gate = undefined;
  s.observe(s.read({ commit: head(2) }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(s.repairs().length, 1, 'held after the stop');
  await s.c.send('next prompt');
  await until('repair of the new head', () => s.repairs().length === 2);
  await s.idle();
  assert.match(s.repairs()[1]!.prompt, new RegExp(`head ${head(2)}`));
  s.observe(s.read());
  await s.c.send('another prompt');
  await s.idle();
  assert.equal(s.repairs().length, 2, 'the stopped head');
});

test('a failed repair keeps the queue for the composer and its head attempted', async (t) => {
  const s = await setup(t);
  const gate = new TurnGate();
  s.x.a.gate = gate;
  s.x.a.failNext = true;
  s.observe(s.read());
  await within(gate.entered, 5000, 'repair');
  await s.c.send('queued behind the repair');
  gate.open();
  s.x.a.gate = undefined;
  await until('failed repair settled', () => s.c.snapshot.phase === 'idle');
  assert.deepEqual(s.c.snapshot.queue, ['queued behind the repair']);
  assert.equal(
    s.x.a.inputs.filter(({ prompt }) => prompt === 'queued behind the repair')
      .length,
    0,
  );
  assert.equal((await s.record()).conflictRepairs?.length, 1);
  assert.equal(s.c.repair.ready(), false);
});

test('a restart during the repair keeps its head attempted, and a new head still repairs', async (t) => {
  const s = await setup(t);
  const gate = new TurnGate();
  s.x.a.gate = gate;
  s.observe(s.read());
  await within(gate.entered, 5000, 'repair');
  const id = s.c.snapshot.conversation!.id;
  await s.c.close({ restart: true });
  const reopened = await s.f.start('A', { conversation: id });
  s.observe(s.read(), reopened);
  await reopened.coordinator.send('after restart');
  await until('idle', () => reopened.coordinator.snapshot.phase === 'idle');
  assert.equal(s.repairs(reopened.a).length, 0);
  s.observe(s.read({ commit: head(2) }), reopened);
  await until(
    'repair of the new head',
    () => s.repairs(reopened.a).length === 1,
  );
});

test('a checkout on another branch declines the repair with one notice until the next prompt', async (t) => {
  const s = await setup(t);
  await git('-C', s.cwd, 'symbolic-ref', 'HEAD', 'refs/heads/other');
  s.observe(s.read());
  await until('declined notice', () =>
    s
      .notices()
      .includes(
        "Witch didn't repair the conflict on #7: this session's checkout or claim no longer matches it.",
      ),
  );
  assert.equal(s.c.repair.ready(), false, 'declined until the next prompt');
  s.observe(s.read());
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(s.repairs().length, 0);
  assert.equal(
    s.notices().filter((text) => text.startsWith("Witch didn't repair")).length,
    1,
  );
  await git('-C', s.cwd, 'symbolic-ref', 'HEAD', 'refs/heads/feat/x');
  await s.c.send('back on the branch');
  await until('repair', () => s.repairs().length === 1);
});

test('an ownership check that refuses before native input declines the repair until the next prompt', async (t) => {
  const s = await setup(t);
  const repository = s.read();
  await s.c.send('connect');
  await s.idle();
  vi.spyOn(
    s.x.a.sessions.at(-1)!.session,
    'contextUsage',
  ).mockImplementationOnce(async () => {
    s.x.coordination.updateRepository({
      ...repository,
      pullRequest: undefined,
    });
    return undefined;
  });
  s.observe(repository);
  await until('declined notice', () =>
    s.notices().some((text) => text.startsWith("Witch didn't repair")),
  );
  await s.idle();
  assert.equal(s.repairs().length, 0);
  assert.equal(s.c.snapshot.error, undefined);
  assert.deepEqual((await s.record()).conflictRepairs ?? [], []);
  s.observe(repository);
  await s.c.send('next prompt');
  await until('repair', () => s.repairs().length === 1);
});

test('losing the claim or the base during a repair stops it once', async (t) => {
  for (const kind of ['claim', 'base'] as const) {
    const s = await setup(t, kind === 'claim' ? 'A' : 'B');
    const gate = new TurnGate();
    s.x.a.gate = gate;
    s.observe(s.read());
    await within(gate.entered, 5000, 'repair');
    if (kind === 'claim') {
      const result = await callControl(await s.x.binding(), {
        kind: 'release',
        claim: s.x.coordination.snapshot.ownClaim!.id,
      });
      assert.equal(result.kind, 'released');
    } else {
      s.observe(s.read({ base: 'release' }));
      s.observe(s.read({ base: 'release' }));
    }
    await s.idle();
    s.observe(s.read());
    assert.equal(
      s.notices().filter((text) => text.startsWith('Conflict repair stopped'))
        .length,
      1,
      kind,
    );
    assert.equal(
      s.x.a.stops.filter(({ operation }) => operation === 'interrupt').length,
      1,
      kind,
    );
  }
});

/** holds the next admission's ownership check until `release`, then runs the real one. */
function gateOwnership(s: Awaited<ReturnType<typeof setup>>) {
  const reviews = s.x.coordination.reviews;
  const owns = reviews.owns.bind(reviews);
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  vi.spyOn(reviews, 'owns').mockImplementationOnce(async (...args) => {
    entered.resolve();
    await released.promise;
    return owns(...args);
  });
  return { entered: entered.promise, release: () => released.resolve() };
}

test('an admission overtaken by a prompt or a stop records nothing and repairs once they clear', async (t) => {
  for (const kind of ['prompt', 'stop'] as const) {
    const s = await setup(t, kind === 'prompt' ? 'A' : 'B');
    const gate = gateOwnership(s);
    s.observe(s.read());
    await within(gate.entered, 5000, 'ownership check');
    const sent = kind === 'prompt' ? s.c.send('user prompt') : s.c.interrupt();
    gate.release();
    await sent;
    await s.idle();
    if (kind === 'stop') {
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(s.repairs().length, 0, kind);
      assert.deepEqual((await s.record()).conflictRepairs ?? [], [], kind);
      await s.c.send('user prompt');
    }
    await until('repair', () => s.repairs().length === 1);
    assert.deepEqual(
      s.x.a.inputs.map(({ prompt }) =>
        prompt.startsWith(repairPrefix) ? 'repair' : prompt,
      ),
      ['user prompt', 'repair'],
      kind,
    );
  }
});

test("a head observed during another head's admission repairs in the same drain", async (t) => {
  const s = await setup(t);
  const gate = gateOwnership(s);
  s.observe(s.read());
  await within(gate.entered, 5000, 'ownership check');
  s.observe(s.read({ commit: head(2) }));
  gate.release();
  await until('repair', () => s.repairs().length === 1);
  await s.idle();
  assert.match(s.repairs()[0]!.prompt, new RegExp(`head ${head(2)}`));
  assert.deepEqual((await s.record()).conflictRepairs, [
    { url: s.pullRequest().url, commit: head(2), base: 'main' },
  ]);
});

test('switching conversations during an admission admits nothing', async (t) => {
  const s = await setup(t);
  const original = s.c.snapshot.conversation!.id;
  const gate = gateOwnership(s);
  s.observe(s.read());
  await within(gate.entered, 5000, 'ownership check');
  const switched = s.c.newConversation('a');
  gate.release();
  await switched;
  await s.idle();
  assert.equal(s.repairs().length, 0);
  const saved = conversationRecordSchema.parse(
    JSON.parse(
      await readFile(
        join(s.f.store.root, 'conversations', original, 'state.json'),
        'utf8',
      ),
    ),
  );
  assert.equal(saved.conflictRepairs, undefined);
});

test('a waiting peer answer runs before the repair, and one arriving during its admission runs after it', async (t) => {
  const s = await setup(t);
  const b = await s.f.start('B');
  await b.claim('task:asker');
  const ask = async (message: string) => {
    const asked = await callControl(await b.binding(), {
      kind: 'ask',
      claim: s.x.coordination.snapshot.ownClaim!.id,
      message,
    });
    assert.equal(asked.kind, 'peer-request');
    await s.x.coordination.context();
  };
  const release = s.c.holdPromptDelivery();
  s.observe(s.read());
  await ask('What did this task find?');
  release();
  await until('repair', () => s.repairs().length === 1);
  await s.idle();
  const gate = gateOwnership(s);
  s.observe(s.read({ commit: head(2) }));
  await within(gate.entered, 5000, 'ownership check');
  await ask('And now?');
  gate.release();
  await until(
    'second answer',
    () =>
      s.x.a.inputs.filter(({ prompt }) => prompt === answerInstruction)
        .length === 2,
  );
  assert.deepEqual(
    s.x.a.inputs.map(({ prompt }) =>
      prompt === answerInstruction
        ? 'peer'
        : prompt.startsWith(repairPrefix)
          ? 'repair'
          : prompt,
    ),
    ['peer', 'repair', 'repair', 'peer'],
  );
});

test('an ownership check that throws declines with its error, reported once per blocker and conversation', async (t) => {
  const s = await setup(t);
  const owns = vi.spyOn(s.x.coordination.reviews, 'owns');
  owns.mockRejectedValue(new Error('Ledger unavailable.'));
  s.observe(s.read());
  const blocker = "Witch didn't repair the conflict on #7: Ledger unavailable.";
  await until('declined notice', () => s.notices().includes(blocker));
  await s.idle();
  assert.equal(s.c.snapshot.error, undefined);
  assert.equal(s.repairs().length, 0);
  await s.c.send('retry');
  await s.idle();
  s.observe(s.read());
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(s.notices().filter((text) => text === blocker).length, 1);
  owns.mockRejectedValue(new Error('Git unavailable.'));
  await s.c.send('retry again');
  await until('changed blocker', () =>
    s
      .notices()
      .includes("Witch didn't repair the conflict on #7: Git unavailable."),
  );
});

test('a restart while the final ownership check runs keeps the head attempted', async (t) => {
  const s = await setup(t);
  const reviews = s.x.coordination.reviews;
  const owns = reviews.owns.bind(reviews);
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let calls = 0;
  vi.spyOn(reviews, 'owns').mockImplementation(async (...args) => {
    if (++calls === 2) {
      entered.resolve();
      await released.promise;
    }
    return owns(...args);
  });
  s.observe(s.read());
  await within(entered.promise, 5000, 'final ownership check');
  const id = s.c.snapshot.conversation!.id;
  const closing = s.c.close({ restart: true });
  released.resolve();
  await closing;
  const reopened = await s.f.start('A', { conversation: id });
  assert.equal((await s.record(reopened)).conflictRepairs?.length, 1);
  s.observe(s.read(), reopened);
  await reopened.coordinator.send('after restart');
  await until('idle', () => reopened.coordinator.snapshot.phase === 'idle');
  assert.equal(s.repairs().length + s.repairs(reopened.a).length, 0);
});

test('a conflict observed while a Copilot admission reads GitHub repairs in the same drain', async (t) => {
  const s = await setup(t);
  const source = reviewSource();
  source.pullRequest = { ...s.pullRequest(), mergeable: undefined };
  source.closingIssues = [];
  const kept = s.pullRequest();
  vi.spyOn(github, 'readGitHubReviews').mockImplementation(async () => {
    // the head's readiness lapses through an uncomputed read and returns
    s.observe(s.read({ mergeable: 'UNKNOWN' }, kept));
    s.observe(s.read());
    return structuredClone(source);
  });
  const mergeable = s.read({ mergeable: 'MERGEABLE' });
  s.x.coordination.updateRepository(mergeable);
  s.c.copilot.updateRepository(mergeable);
  s.c.repair.observe(mergeable);
  await s.c.copilot.observe(structuredClone(source));
  await until('repair', () => s.repairs().length === 1);
  assert.ok(s.x.a.inputs[0]!.prompt.startsWith(repairPrefix));
});

test('the wired conflict watch survives a conversation switch and a restart with a repair pending', async (t) => {
  const s = await setup(t);
  const listeners = new Set<() => void>();
  const repository = {
    snapshot: s.read() as Repository | undefined,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refreshPullRequest: () => {},
  };
  s.x.coordination.updateRepository(repository.snapshot);
  const release = s.c.holdPromptDelivery();
  const stop = watchConflicts(repository, s.c);
  try {
    await until('ready repair', () => s.c.repair.ready());
    await s.c.newConversation('a');
    for (const listener of listeners) listener();
    await s.c.close({ restart: true });
    for (const listener of listeners) listener();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    release();
    stop();
  }
  assert.equal(s.repairs().length, 0);
});

test('a new conflict does not steer prompts a replied turn refused', async (t) => {
  const s = await setup(t);
  const gate = new TurnGate();
  s.x.a.gate = gate;
  s.x.a.replied = true;
  s.x.a.refuseSteer = true;
  void s.c.send('long turn');
  await within(gate.entered, 5000, 'user turn');
  await s.c.send('queued prompt');
  assert.deepEqual(s.c.snapshot.queue, ['queued prompt']);
  s.x.a.refuseSteer = false;
  s.observe(s.read());
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(s.x.a.steers, []);
  gate.open();
  s.x.a.gate = undefined;
  s.x.a.replied = false;
});
