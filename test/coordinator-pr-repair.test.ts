import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import type { TestContext } from 'vitest';
import * as github from '../src/core/github-reviews.js';
import { answerInstruction } from '../src/core/peer-requests.js';
import { watchConflicts } from '../src/core/pr-repair.js';
import { conversationRecordSchema } from '../src/core/state.js';
import { RepositoryWatch } from '../src/core/repository.js';
import type { PullRequest, Repository } from '../src/core/repository.js';
import { statusLines } from '../src/ui/status-line.js';
import { callControl } from '../src/persistence/control.js';
import { TurnGate } from './fixtures/agent.js';
import { reviewSource } from './fixtures/github-reviews.js';
import { orderedCleanup } from './fixtures/cleanup.js';
import { unitFixture, notices } from './fixtures/coordinator.js';
import { unitCoordinationFixture, git } from './fixtures/coordination.js';
import { until, within } from './fixtures/within.js';
import { record as savedRecord } from './fixtures/copilot-reviews.js';
import {
  pullRequest as openPullRequest,
  repositoryRead,
} from './fixtures/repository.js';

test("every turn carries the branch's pull request conflict until it clears", async () => {
  const f = await unitFixture();
  try {
    const pullRequest = openPullRequest({ mergeable: 'CONFLICTING' });
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
  const f = await unitCoordinationFixture(register, async (references) => ({
    assigned: references,
  }));
  const x = await f.start(name);
  const c = x.coordinator;
  const cwd = c.snapshot.conversation!.cwd;
  await git('-C', cwd, 'symbolic-ref', 'HEAD', 'refs/heads/feat/x');
  const project = (await f.memory.scopePaths(cwd)).project;
  const pullRequest = (fields: Partial<PullRequest> = {}) =>
    openPullRequest({ commit: head(1), mergeable: 'CONFLICTING', ...fields });
  /** a read of the pull request; a conflicting one carries its conflict, as `RepositoryWatch` publishes it. */
  const read = (
    fields: Partial<PullRequest> = {},
    kept?: PullRequest,
  ): Repository => {
    const current = pullRequest(fields);
    const conflict = current.mergeable === 'CONFLICTING' ? current : kept;
    return repositoryRead({
      commit: current.commit,
      pullRequest: current,
      pullRequestProject: project,
      ...(conflict
        ? { conflict: { pullRequest: conflict, baseTip: 'f00' } }
        : {}),
    });
  };
  const observe = (
    repository: Repository,
    client: { coordinator: typeof c; coordination: typeof x.coordination } = x,
  ) => {
    client.coordination.updateRepository(repository);
    client.coordinator.conflict = repository.conflict;
    client.coordinator.repair.observe(repository);
  };
  c.repair.setRefresh(async () => {});
  await x.claim(pullRequest().url, 'repair task');
  const repairs = (agent = x.a) =>
    agent.inputs.filter(({ prompt }) => prompt.startsWith(repairPrefix));
  const idle = (coordinator = c) =>
    until('idle', () => coordinator.snapshot.phase === 'idle');
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
    record: (client = x) => savedRecord(f, client),
    notices: (coordinator = c) => notices(coordinator),
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
  reopened.coordinator.repair.setRefresh(async () => {});
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
    pullRequestReadAt: 0,
    readPullRequest: async () => {},
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

const checkPrefix = 'Witch started this turn to repair the failed checks';
const job = (n: number) => `https://github.com/o/r/actions/runs/1/job/${n}`;

/** a mergeable read whose `verify` check failed, as `parsePullRequest` publishes it. */
const failing = (
  s: Awaited<ReturnType<typeof setup>>,
  fields: Partial<PullRequest> = {},
) =>
  s.read({
    mergeable: 'MERGEABLE',
    checks: 'failing',
    failed: [{ name: 'verify', url: job(1) }],
    ...fields,
  });

const checkRepairs = (s: Awaited<ReturnType<typeof setup>>) =>
  s.x.a.inputs.filter(({ prompt }) => prompt.startsWith(checkPrefix));

test('failed checks on the claimed pull request start one repair turn per head and check, and pending or passing checks start none', async (t) => {
  const s = await setup(t);
  s.observe(s.read({ mergeable: 'MERGEABLE', checks: 'pending' }));
  assert.equal(s.c.repair.ready(), false, 'pending');
  s.observe(s.read({ mergeable: 'MERGEABLE', checks: 'passing' }));
  assert.equal(s.c.repair.ready(), false, 'passing');
  s.observe(failing(s));
  await until('check repair', () => checkRepairs(s).length === 1);
  await s.idle();
  const [repair] = checkRepairs(s);
  assert.equal(repair!.author, 'witch');
  assert.match(
    repair!.prompt,
    new RegExp(
      `pull request https://github\\.com/o/r/pull/7 at head ${head(1)}: verify \\(${job(1).replaceAll('/', '\\/')}\\)\\.`,
    ),
  );
  assert.match(repair!.prompt, /gh run view --job/);
  assert.match(
    repair!.prompt,
    /only once that's settled rerun the failed jobs/,
  );
  assert.ok(s.notices().includes('Repairing failed checks on #7: verify.'));
  assert.deepEqual((await s.record()).checkRepairs, [
    { url: s.pullRequest().url, commit: head(1), check: 'verify' },
  ]);
  assert.equal((await s.record()).conflictRepairs, undefined);
  s.observe(failing(s));
  assert.equal(s.c.repair.ready(), false, 'a repeated poll');
  s.observe(failing(s, { failed: [{ name: 'verify', url: job(2) }] }));
  assert.equal(s.c.repair.ready(), false, 'a rerun that failed the same way');
  await s.c.send('continue');
  await s.idle();
  assert.equal(checkRepairs(s).length, 1);
  s.observe(
    failing(s, {
      failed: [
        { name: 'verify', url: job(2) },
        { name: 'lint', url: job(3) },
      ],
    }),
  );
  await until('repair of the later check', () => checkRepairs(s).length === 2);
  await s.idle();
  assert.match(checkRepairs(s)[1]!.prompt, new RegExp(`${head(1)}: lint \\(`));
  assert.doesNotMatch(checkRepairs(s)[1]!.prompt, /verify/);
  s.observe(failing(s, { commit: head(2) }));
  await until('repair of the new head', () => checkRepairs(s).length === 3);
  assert.match(checkRepairs(s)[2]!.prompt, new RegExp(`at head ${head(2)}:`));
});

test('a check repair waits for the running and queued user turns', async (t) => {
  const s = await setup(t);
  const gate = new TurnGate();
  s.x.a.gate = gate;
  const first = s.c.send('long user turn');
  await within(gate.entered, 5000, 'user turn');
  s.x.a.refuseSteer = true;
  await s.c.send('queued user turn');
  s.observe(failing(s));
  assert.equal(checkRepairs(s).length, 0);
  gate.open();
  s.x.a.gate = undefined;
  await first;
  s.x.a.refuseSteer = false;
  await until('check repair', () => checkRepairs(s).length === 1);
  assert.deepEqual(
    s.x.a.inputs.map(({ prompt }) =>
      prompt.startsWith(checkPrefix) ? 'repair' : prompt,
    ),
    ['long user turn', 'queued user turn', 'repair'],
  );
});

test('fresh resolution or an uncertain read skips the cached conflict without recording an attempt', async (t) => {
  const s = await setup(t);
  const old = s.read();
  let reads = 0;
  for (const fresh of [
    s.read({ mergeable: 'MERGEABLE' }),
    s.read({ commit: head(2), mergeable: 'MERGEABLE' }),
    s.read({ mergeable: 'UNKNOWN' }, s.pullRequest()),
    { ...old, pullRequest: undefined },
    { ...old, commit: head(2) },
  ]) {
    const before = reads;
    s.c.repair.setRefresh(async () => {
      reads++;
      s.observe(fresh);
    });
    s.observe(old);
    await until(
      'fresh observation',
      () => reads === before + 1 && !s.c.repair.ready(),
    );
    await s.c.send('check status');
    await until(
      'user turn',
      () =>
        s.x.a.inputs.filter(({ prompt }) => prompt === 'check status')
          .length ===
        before + 1,
    );
    await s.idle();
    assert.equal(s.repairs().length, 0);
    assert.equal((await s.record()).conflictRepairs, undefined);
    assert.equal(reads, before + 1, 'no admission retry loop');
  }
  s.c.repair.setRefresh(async () => {});
  s.observe(s.read({ commit: head(2) }));
  await until('recovered conflict', () => s.repairs().length === 1);
  await s.idle();
  assert.deepEqual((await s.record()).conflictRepairs, [
    { url: s.pullRequest().url, commit: head(2), base: 'main' },
  ]);
});

test('fresh conflict admission uses the refreshed base tip and starts once', async (t) => {
  const s = await setup(t);
  let reads = 0;
  s.c.repair.setRefresh(async () => {
    reads++;
    s.observe({
      ...s.read(),
      conflict: { pullRequest: s.pullRequest(), baseTip: 'new-tip' },
    });
  });
  s.observe(s.read());
  await until('repair', () => s.repairs().length === 1);
  await s.idle();
  assert.match(s.repairs()[0]!.prompt, /whose tip was new-tip/);
  s.observe(s.read());
  await s.c.send('continue');
  await s.idle();
  assert.equal(s.repairs().length, 1);
  assert.equal(reads, 1);
});

test('a user turn queued during the freshness read runs before a new admission', async (t) => {
  const s = await setup(t);
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  t.onTestFinished(() => released.resolve());
  let reads = 0;
  s.c.repair.setRefresh(async () => {
    reads++;
    entered.resolve();
    await released.promise;
  });
  s.observe(s.read());
  await within(entered.promise, 5000, 'fresh read');
  await s.c.send('queued during read');
  released.resolve();
  await until('repair', () => s.repairs().length === 1);
  await s.idle();
  assert.equal(s.x.a.inputs[0]!.prompt, 'queued during read');
  assert.equal(reads, 2, 'a new admission after the user turn reads again');
});

test('unbinding the conflict watch during its refresh prevents admission', async (t) => {
  const s = await setup(t);
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const repository = {
    snapshot: s.read(),
    subscribe: () => () => {},
    refreshPullRequest: () => {},
    pullRequestReadAt: 0,
    readPullRequest: async () => {
      entered.resolve();
      await released.promise;
    },
  };
  s.x.coordination.updateRepository(repository.snapshot);
  const stop = watchConflicts(repository, s.c);
  t.onTestFinished(() => {
    stop();
    released.resolve();
  });
  await within(entered.promise, 5000, 'fresh read');
  stop();
  released.resolve();
  await s.c.send('after disposal');
  await until('user input', () =>
    s.x.a.inputs.some(({ prompt }) => prompt === 'after disposal'),
  );
  assert.equal(s.c.repair.ready(), false);
  assert.equal(s.repairs().length, 0);
  assert.equal((await s.record()).conflictRepairs, undefined);
});

for (const mergeable of ['MERGEABLE', 'CONFLICTING'] as const) {
  test(`the wired watch reads the pushed head before admission: ${mergeable}`, async (t) => {
    const register = orderedCleanup(t.onTestFinished);
    const f = await unitCoordinationFixture(register, async (references) => ({
      assigned: references,
    }));
    const x = await f.start();
    const c = x.coordinator;
    const cwd = c.snapshot.conversation!.cwd;
    const project = (await f.memory.scopePaths(cwd)).project;
    await git('-C', cwd, 'checkout', '-b', 'feat/x');
    const commit = async (message: string) => {
      await git(
        '-C',
        cwd,
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        'commit',
        '--allow-empty',
        '-m',
        message,
      );
      return (await git('-C', cwd, 'rev-parse', 'HEAD')).stdout.trim();
    };
    const a = await commit('A');
    const url = 'https://github.com/o/r/pull/7';
    await x.claim(url, 'repair test');
    const release = c.holdPromptDelivery();
    register(release);
    let current = a;
    const watch = new RepositoryWatch(
      cwd,
      async (command, args, options) => {
        if (command !== 'gh') return git('-C', options.cwd, ...args);
        if (args[0] === 'api') return { stdout: `${a}\n` };
        return {
          stdout: JSON.stringify({
            number: 7,
            url,
            state: 'OPEN',
            headRefName: 'feat/x',
            headRefOid: current,
            baseRefName: 'main',
            mergeable: current === a ? 'CONFLICTING' : mergeable,
            statusCheckRollup: [],
          }),
        };
      },
      async () => project,
    );
    register(() => watch.close());
    register(
      watch.subscribe(() => x.coordination.updateRepository(watch.snapshot)),
    );
    register(watchConflicts(watch, c));
    await until('cached conflict', () => !!c.conflict);
    assert.match(
      statusLines(
        { cwd, usage: {}, repository: watch.snapshot },
        Date.now(),
      ).join(' '),
      /CONFLICT/,
    );
    current = await commit('B');
    release();
    const repairs = () =>
      x.a.inputs.filter(({ prompt }) => prompt.startsWith(repairPrefix));
    if (mergeable === 'CONFLICTING') {
      await until('fresh repair', () => repairs().length === 1);
      await until('idle', () => c.snapshot.phase === 'idle');
      assert.match(
        repairs()[0]!.prompt,
        new RegExp(`head ${current} conflicts`),
      );
      assert.deepEqual((await savedRecord(f, x)).conflictRepairs, [
        { url, commit: current, base: 'main' },
      ]);
    } else {
      await until('resolution', () => c.conflict === undefined);
      await c.send('continue');
      await until(
        'user input completed',
        () =>
          x.a.inputs.some(({ prompt }) => prompt === 'continue') &&
          c.snapshot.phase === 'idle',
      );
      assert.equal(repairs().length, 0);
      assert.equal((await savedRecord(f, x)).conflictRepairs, undefined);
      assert.doesNotMatch(
        x.a.inputs.at(-1)!.context ?? '',
        /Witch confirmed on GitHub/,
      );
      assert.doesNotMatch(
        statusLines(
          { cwd, usage: {}, repository: watch.snapshot },
          Date.now(),
        ).join(' '),
        /CONFLICT/,
      );
    }
  });
}

test('a status failure during the fresh GitHub read cannot restore cached conflict admission', async (t) => {
  const s = await setup(t);
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let reads = 0,
    failStatus = false;
  const watch = new RepositoryWatch(
    '/work',
    async (command, args) => {
      if (command !== 'gh') {
        if (args.includes('status') && failStatus)
          throw Object.assign(new Error('status unavailable'), { code: 128 });
        return { stdout: `# branch.head feat/x\n# branch.oid ${head(1)}\n` };
      }
      if (args[0] === 'api') return { stdout: 'f00\n' };
      if (++reads === 2) {
        entered.resolve();
        await released.promise;
      }
      return {
        stdout: JSON.stringify({
          number: 7,
          url: s.pullRequest().url,
          state: 'OPEN',
          headRefName: 'feat/x',
          headRefOid: head(1),
          baseRefName: 'main',
          mergeable: reads === 1 ? 'CONFLICTING' : 'MERGEABLE',
          statusCheckRollup: [],
        }),
      };
    },
    async () => s.read().pullRequestProject!,
  );
  const stopRepository = watch.subscribe(() =>
    s.x.coordination.updateRepository(watch.snapshot),
  );
  const stopConflicts = watchConflicts(watch, s.c);
  try {
    await within(entered.promise, 5000, 'fresh read');
    failStatus = true;
    vi.advanceTimersByTime(5000);
    await until('status loss', () => watch.snapshot === undefined);
    failStatus = false;
    released.resolve();
    await until(
      'recovered local status',
      () => watch.snapshot?.commit === head(1),
    );
    await s.c.send('after status recovery');
    await until(
      'user input completed',
      () =>
        s.x.a.inputs.some(({ prompt }) => prompt === 'after status recovery') &&
        s.c.snapshot.phase === 'idle',
    );
    assert.equal(s.repairs().length, 0);
    assert.equal((await s.record()).conflictRepairs, undefined);
    vi.advanceTimersByTime(5000);
    await until(
      'automatic confirmed resolution',
      () => s.c.conflict === undefined,
    );
    assert.equal(watch.snapshot?.pullRequest?.mergeable, 'MERGEABLE');
    assert.equal(
      reads,
      3,
      'one automatic recovery read, with no admission retry loop',
    );
    assert.equal(s.repairs().length, 0);
  } finally {
    released.resolve();
    stopConflicts();
    stopRepository();
    watch.close();
  }
});
