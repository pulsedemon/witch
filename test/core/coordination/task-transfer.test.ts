import assert from 'node:assert/strict';
import type { TestContext } from 'vitest';
import { test, vi } from 'vitest';
import { callControl } from '../../../src/persistence/control.js';
import {
  CoordinationStore,
  DeadlineExpired,
} from '../../../src/persistence/coordination.js';
import type { TransferField } from '../../../src/core/coordination/coordination-state.js';
import {
  awaitTransfer,
  transferRefusal,
} from '../../../src/core/coordination/task-transfer.js';
import { USAGE_CURRENT_MS } from '../../../src/core/runtime/usage.js';
import type { Snapshot } from '../../../src/core/snapshot.js';
import { FixtureAgent, TurnGate } from '../../fixtures/agent.js';
import {
  coordinationFixture,
  unitCoordinationFixture,
  pauseDiscovery,
} from '../../fixtures/coordination.js';
import { orderedCleanup } from '../../fixtures/cleanup.js';
import { until, within } from '../../fixtures/within.js';

async function transfer(
  t: TestContext,
  createFixture = unitCoordinationFixture,
) {
  const cleanup = orderedCleanup(t.onTestFinished);
  const ticks = pauseDiscovery(vi.spyOn);
  const f = await createFixture(cleanup);

  const a = await f.start(),
    b = await f.start('B');

  assert.equal((await a.claim('task:shared', 'Shared work')).kind, 'claimed');

  const requested = (field: TransferField = 'transfer') =>
    until('transfer request', async () =>
      (await f.registry.claims()).some((claim) => claim[field]),
    );

  return {
    ...f,
    a,
    b,
    requested,
    /** the first session's periodic tick, which `pauseDiscovery` holds back. */
    tick: () => ticks[0]!(),
    /** an exhausted owner's periodic tick must answer without a model turn. */
    answer: async (field: TransferField = 'transfer', owner = 0) => {
      await requested(field);
      ticks[owner]!();
    },
  };
}

test('an idle owner hands over its task without a model turn, and its next context names the move', async (t) => {
  const { a, b, answer, registry } = await transfer(t);
  a.a.failNext = true;
  await a.coordinator.send('turn that fails');
  assert.equal(a.coordinator.snapshot.phase, 'idle');
  const [before] = await registry.claims();
  const turns = a.a.inputs.length;
  await Promise.all([b.coordination.takeTask('task:shared'), answer()]);
  const taker = b.coordinator.snapshot.conversation!.id;
  const owned = b.coordination.snapshot.ownClaim!;

  assert.deepEqual(
    [owned.id, owned.references, owned.summary, owned.owner.conversation],
    [before!.id, before!.references, 'Shared work', taker],
  );

  assert.equal(a.a.inputs.length, turns);

  assert.match(
    (await a.coordination.context()).context,
    new RegExp(
      `Task ${before!.references[0]} moved to conversation ${taker}\\. Do not continue that task\\.`,
    ),
  );

  const release = await callControl(await a.binding(), {
    kind: 'release',
    claim: before!.id,
  });

  assert.deepEqual(
    release.kind === 'error' && release.message,
    'Only the owning conversation can release this task.',
  );

  const [conflict] = await Promise.all([
    a.claim('task:shared', 'Shared work'),
    answer('automaticTransfer', 1),
  ]);

  assert.equal(conflict.kind, 'conflict');
});

test('a running turn, a native run, a running brew and memory recovery each refuse with their next action', async (t) => {
  const { a, b, answer, registry } = await transfer(t, coordinationFixture);
  const before = await registry.claims();

  const refuses = async (reason: RegExp) => {
    const taking = b.coordination.takeTask('task:shared');
    await answer();

    await assert.rejects(taking, (error: Error) => {
      assert.match(error.message, /still holds task:shared\. /);
      assert.match(error.message, reason);

      return true;
    });

    assert.deepEqual(await registry.claims(), before);
  };

  const gate = new TurnGate();
  a.a.gate = gate;
  const sending = a.coordinator.send('Held work');
  await within(gate.entered, 5000, 'held turn');

  await refuses(
    /It is running\. Wait for it to go idle or stop its turn there/,
  );

  gate.open();
  await sending;
  const emit = a.a.sessions.at(-1)!.options.onEvent;
  emit({ type: 'running', running: true });
  await refuses(/It is running on its own\. Wait for it to go idle/);
  emit({ type: 'running', running: false });

  emit({
    type: 'command',
    command: { id: 'brew', description: 'Work', status: 'running' },
  });

  await refuses(/It has running familiars or brews\. Stop them there/);

  emit({
    type: 'command',
    command: { id: 'brew', description: 'Work', status: 'completed' },
  });

  a.a.interruptNext = true;
  await a.coordinator.send('remember-port');
  assert.equal(a.coordinator.snapshot.phase, 'recovery');
  await refuses(/It has unresolved memory recovery\. Resolve it there/);
});

test('an owner that never reads the ledger times out and leaves no request', async (t) => {
  const { b, registry } = await transfer(t);
  const before = await registry.claims();

  await assert.rejects(
    b.coordination.takeTask('task:shared', 3000),
    /did not answer\. Restart Witch in that conversation or close it, then run \/task take again\./,
  );

  assert.deepEqual(await registry.claims(), before);
  assert.equal(b.coordination.snapshot.error, undefined);
});

for (const { budget, wait } of [
  { budget: 30_000, wait: 8000 },
  { budget: 5000, wait: 3000 },
])
  test(`a request with ${budget} ms left gives the owner ${wait} ms to answer`, async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const expiries: number[] = [];

    await assert.rejects(
      awaitTransfer({
        conversation: 'requester',
        activation: 'activation',
        reference: 'task:shared',
        field: 'transfer',
        deadline: 1000 + budget,
        request: async (expires) => {
          expiries.push(expires());

          throw new Error('Request refused');
        },
        title: async () => undefined,
        admit: () => {},
        read: async () => ({ ledger: { claims: [], selections: [] } }),
        withdraw: async () => undefined,
      }),
      /Request refused/,
    );

    assert.deepEqual(expiries, [1000 + wait]);
  });

test('a request that is slow to record still gives the owner 8 s from the write', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
  let recorded = 0;
  let reads = 0;

  await assert.rejects(
    awaitTransfer({
      conversation: 'requester',
      activation: 'activation',
      reference: 'task:shared',
      field: 'transfer',
      deadline: 31_000,
      request: async (expires) => {
        now.mockReturnValue(10_000);
        recorded = expires();

        return {
          id: 'claim',
          owner: { conversation: 'owner', project: 'project' },
          references: ['task:shared'],
          summary: 'Shared work',
          createdAt: 0,
          transfer: {
            to: { conversation: 'requester', project: 'project' },
            activation: 'activation',
            process: { pid: 1, started: 'then' },
            expires: recorded,
          },
        };
      },
      title: async () => 'Owner',
      admit: () => {},
      read: async () => {
        reads++;

        return { ledger: { claims: [], selections: [] } };
      },
      withdraw: async () => undefined,
    }),
    /task:shared was released/,
  );

  assert.equal(recorded, 18_000);
  assert.equal(reads, 1);
});

test('an owner whose handover fails shows why until one succeeds', async (t) => {
  const { a, b, tick, requested } = await transfer(t);
  // each session has its own store; the fixture's `registry` is a third
  const local = a.coordination['registry'];

  const handing = vi
    .spyOn(local, 'handOver')
    .mockRejectedValue(new Error('claims.json could not be written'));

  let settled = false;

  const taking = b.coordination
    .takeTask('task:shared', 8000)
    .finally(() => (settled = true));

  await requested();

  // a tick that lands while the owner's refresh is still running is dropped, so each wait keeps ticking
  await until('the failure', () => {
    tick();

    return a.coordination.snapshot.error !== undefined;
  });

  assert.equal(
    a.coordination.snapshot.error,
    'claims.json could not be written',
  );

  handing.mockRestore();

  await until('the handover', () => {
    tick();

    return settled;
  });

  await taking;
  assert.equal(a.coordination.snapshot.error, undefined);

  assert.equal(
    b.coordination.snapshot.ownClaim?.owner.conversation,
    b.coordinator.snapshot.conversation!.id,
  );
});

test('a failed handover stops showing once its request is gone', async (t) => {
  const { a, b, tick, requested, registry } = await transfer(t);
  const before = await registry.claims();

  vi.spyOn(a.coordination['registry'], 'handOver').mockRejectedValue(
    new Error('claims.json could not be written'),
  );

  // watched from the start, since the request times out during the waits below
  const unanswered = assert.rejects(
    b.coordination.takeTask('task:shared', 3000),
    /did not answer/,
  );

  await requested();

  await until('the failure', () => {
    tick();

    return a.coordination.snapshot.error !== undefined;
  });

  await unanswered;

  await until('the cleared failure', () => {
    tick();

    return a.coordination.snapshot.error === undefined;
  });

  assert.deepEqual(await registry.claims(), before);
});

test('a handover cut short by the owner quiescing is not shown as a failure', async (t) => {
  const { a, b, tick, requested } = await transfer(t);
  const local = a.coordination['registry'];
  let cut = false;

  vi.spyOn(local, 'handOver').mockImplementation(async () => {
    // not awaited: quiesce waits for the operation this runs in
    void a.coordination.quiesce();
    cut = true;

    throw new Error('claims.json could not be written');
  });

  const taking = b.coordination.takeTask('task:shared', 3000);
  await requested();

  await until('the cut handover', () => {
    tick();

    return cut;
  });

  await a.coordination.quiesce();
  assert.equal(a.coordination.snapshot.error, undefined);
  await assert.rejects(taking, /did not answer/);
});

test('a successful withdrawal clears a failed ledger poll', async (t) => {
  const { b, registry } = await transfer(t);
  const before = await registry.claims();
  const local = b.coordination['registry'];
  const request = local.requestTransfer.bind(local);
  const state = local.state.bind(local);
  let pending = false;
  let failed = false;

  const requesting = vi
    .spyOn(local, 'requestTransfer')
    .mockImplementation(async (...args) => {
      const claim = await request(...args);
      pending = true;

      return claim;
    });

  const reading = vi
    .spyOn(local, 'state')
    .mockImplementation(async (...args) => {
      if (!pending) return state(...args);

      args[1]?.();
      failed = true;

      throw new Error('Failed ledger poll');
    });

  try {
    await assert.rejects(
      b.coordination.takeTask('task:shared', 3000),
      /did not answer/,
    );

    assert.equal(failed, true);
    assert.deepEqual(await registry.claims(), before);
    assert.equal(b.coordination.snapshot.error, undefined);
  } finally {
    requesting.mockRestore();
    reading.mockRestore();
  }
});

test('a requester that switches conversations stops waiting and withdraws its request', async (t) => {
  const { b, requested, registry } = await transfer(t);
  const before = await registry.claims();
  const started = Date.now();
  const taking = b.coordination.takeTask('task:shared');
  await requested();
  const switching = b.coordinator.newConversation();
  await assert.rejects(taking, /no longer current/);
  await switching;
  assert.ok(Date.now() - started < 5000, 'the wait ended with the switch');
  assert.deepEqual(await registry.claims(), before);
});

test('an owner that closes while a request is pending reports the release', async (t) => {
  const { a, b, requested } = await transfer(t);
  const taking = b.coordination.takeTask('task:shared');
  await requested();
  await a.coordinator.close();
  await assert.rejects(taking, /task:shared was released\. Claim it again\./);
});

test('an agent control request cannot take a task', async (t) => {
  const { b, registry } = await transfer(t);
  const before = await registry.claims();

  const result = await callControl(await b.binding(), {
    kind: 'take',
    input: { reference: 'task:shared' },
  });

  assert.deepEqual(
    result.kind === 'error' && result.message,
    'Only the user can request an unconditional transfer. Use --claim to request a transfer when the owner is out of usage.',
  );

  assert.deepEqual(await registry.claims(), before);
});

test('a conflict reply names /task take with the reference the agent used', async (t) => {
  const { b, answer } = await transfer(t);

  const [conflict] = await Promise.all([
    b.claim('task:Shared', 'Other work'),
    answer('automaticTransfer'),
  ]);

  assert.equal(conflict.kind, 'conflict');

  assert.match(
    conflict.kind === 'conflict' ? conflict.message : '',
    /The user can move it here with \/task take task:Shared once its owner is idle\.$/,
  );
});

async function automatic(
  t: TestContext,
  ids = ['claude', 'codex'],
  createFixture = unitCoordinationFixture,
) {
  const cleanup = orderedCleanup(t.onTestFinished);
  const ticks = pauseDiscovery(vi.spyOn);
  const f = await createFixture(cleanup);
  const nativeOwner = new FixtureAgent(ids[0]!);
  const nativeRequester = new FixtureAgent(ids[1]!);

  const owner = await f.start('A', {}, [
    { adapter: nativeOwner, executable: nativeOwner.id },
  ]);

  const requester = await f.start('B', {}, [
    { adapter: nativeRequester, executable: nativeRequester.id },
  ]);

  const granted = await callControl(await owner.binding(), {
    kind: 'claim',
    input: {
      reference: 'task:shared',
      aliases: ['task:alias', 'https://github.com/acme/queue/issues/7'],
      summary: 'Original work',
    },
  });

  if (granted.kind !== 'claimed') assert.fail(JSON.stringify(granted));

  const original = (await f.registry.recordAssignment(
    granted.claim.id,
    ['github:acme/queue#7'],
    Date.now() + 5000,
    async () => {},
  ))!;

  const emit = nativeOwner.sessions.at(-1)!.options.onEvent;

  emit({
    type: 'usage',
    usage: {
      account: {
        limits: [
          {
            window: '5H',
            percent: 100,
            resetsAt: Date.now() / 1000 + 3600,
            observedAt: 0,
          },
        ],
      },
    },
  });

  const requested = (field: TransferField = 'automaticTransfer') =>
    until('automatic request', async () =>
      (await f.registry.claims()).some((claim) => claim[field]),
    );

  const answer = async (field: TransferField = 'automaticTransfer') => {
    await requested(field);
    ticks[0]!();
  };

  const attempt = async () => {
    const [result] = await Promise.all([
      requester.claim('task:shared', 'Different requester summary'),
      answer(),
    ]);

    return result;
  };

  return {
    ...f,
    owner,
    requester,
    nativeOwner,
    original,
    emit,
    requested,
    answer,
    attempt,
  };
}

for (const ids of [
  ['claude', 'codex'],
  ['codex', 'claude'],
])
  test(`an exhausted ${ids[0]} owner transfers to ${ids[1]} on claim without a model turn`, async (t) => {
    const f = await automatic(t, ids);
    f.nativeOwner.failNext = true;
    await f.owner.coordinator.send('turn that fails');
    assert.equal(f.owner.coordinator.snapshot.phase, 'idle');
    const turns = f.nativeOwner.inputs.length;
    const result = await f.attempt();

    if (result.kind !== 'claimed') assert.fail(JSON.stringify(result));

    assert.deepEqual(result.claim, {
      ...f.original,
      owner: {
        ...f.original.owner,
        conversation: f.requester.coordinator.snapshot.conversation!.id,
      },
      movedFrom: f.original.owner,
    });

    assert.deepEqual(await f.registry.claims(), [result.claim]);
    assert.deepEqual(f.requester.coordination.snapshot.ownClaim, result.claim);
    assert.equal(f.nativeOwner.inputs.length, turns);
    const context = (await f.owner.coordination.context()).context;

    assert.ok(
      context.includes(
        `Task ${f.original.references.join(', ')} moved to conversation ${result.claim.owner.conversation}. Do not continue that task.`,
      ),
    );
  });

test('merged credits veto automatic transfer after a sparse reconnect, while manual transfer still moves the claim', async (t) => {
  const f = await automatic(t, ['codex', 'claude']);
  const account = f.owner.coordinator.snapshot.accounts.codex!;

  f.owner.coordinator.accountUsage.report('codex', {
    ...account,
    funding: {
      kind: 'credits',
      balance: '123.456',
      unlimited: false,
      available: true,
      observedAt: Date.now(),
    },
    creditAccess: { state: 'available', observedAt: Date.now() },
  });

  assert.equal(f.owner.coordinator.snapshot.usage.account!.funding, undefined);
  const result = await f.attempt();
  assert.equal(result.kind, 'conflict');

  assert.match(
    transferRefusal(f.owner.coordinator.snapshot, true)!,
    /current usable credits/,
  );

  assert.equal(
    (await f.registry.claims())[0]!.owner.conversation,
    f.original.owner.conversation,
  );

  await Promise.all([
    f.requester.coordination.takeTask('task:shared'),
    f.answer('transfer'),
  ]);

  assert.equal(
    (await f.registry.claims())[0]!.owner.conversation,
    f.requester.coordinator.snapshot.conversation!.id,
  );
});

test('another runtime credits cannot veto an exhausted owner transfer', async (t) => {
  const f = await automatic(t);

  f.owner.coordinator.accountUsage.report('codex', {
    limits: [],
    funding: {
      kind: 'credits',
      balance: '321',
      unlimited: false,
      available: true,
      observedAt: Date.now(),
    },
    creditAccess: { state: 'available', observedAt: Date.now() },
  });

  assert.equal((await f.attempt()).kind, 'claimed');

  assert.equal(
    (await f.registry.claims())[0]!.owner.conversation,
    f.requester.coordinator.snapshot.conversation!.id,
  );
});

test('expired funding cannot veto automatic transfer while its access observation is current', async (t) => {
  const f = await automatic(t, ['codex', 'claude']);
  const now = Date.now();

  f.owner.coordinator.accountUsage.report('codex', {
    ...f.owner.coordinator.snapshot.accounts.codex!,
    funding: {
      kind: 'credits',
      balance: '123.456',
      unlimited: false,
      available: true,
      observedAt: now - USAGE_CURRENT_MS - 1,
    },
    creditAccess: { state: 'available', observedAt: now },
  });

  assert.equal((await f.attempt()).kind, 'claimed');

  assert.equal(
    (await f.registry.claims())[0]!.owner.conversation,
    f.requester.coordinator.snapshot.conversation!.id,
  );
});

test('automatic transfer requires an exhausted window whose reported reset is still ahead', async (t) => {
  const f = await automatic(t);
  const now = 2_000_000_000_000;

  for (const [limits, allowed] of [
    [undefined, false],
    [[], false],
    [[{ window: '5H', percent: 100, observedAt: 0 }], false],
    [
      [{ window: '5H', percent: 99, resetsAt: 2_000_000_001, observedAt: 0 }],
      false,
    ],
    [
      [{ window: '5H', percent: 100, resetsAt: 1_999_999_999, observedAt: 0 }],
      false,
    ],
    [
      [{ window: '5H', percent: 100, resetsAt: 2_000_000_000, observedAt: 0 }],
      false,
    ],
    [
      [{ window: '5H', percent: 100, resetsAt: 2_000_000_001, observedAt: 0 }],
      true,
    ],
    [
      [{ window: '5H', percent: 101, resetsAt: 2_000_000_001, observedAt: 0 }],
      true,
    ],
    [
      [
        { window: '5H', percent: 0, resetsAt: 2_000_000_001, observedAt: 0 },
        { window: '7D', percent: 100, resetsAt: 2_000_086_400, observedAt: 0 },
      ],
      true,
    ],
  ] as const) {
    const state: Snapshot = {
      ...f.owner.coordinator.snapshot,
      error: 'Usage limit reached',
      usage: limits ? { account: { limits: [...limits] } } : {},
    };

    assert.equal(
      transferRefusal(state, true, now) === undefined,
      allowed,
      JSON.stringify(limits),
    );

    assert.equal(transferRefusal(state, false, now), undefined);
  }

  const state = {
    ...f.owner.coordinator.snapshot,
    phase: 'error' as const,
    error: 'Restart Witch',
  };

  assert.match(transferRefusal(state, true)!, /stopped with an error/);
  f.emit({ type: 'usage', usage: {} });
  f.owner.coordinator.report('Usage limit reached');
  assert.equal((await f.attempt()).kind, 'conflict');
  assert.deepEqual(await f.registry.claims(), [f.original]);
});

test('automatic transfer keeps running turns, familiars, brews and recovery with their owner', async (t) => {
  const f = await automatic(t, undefined, coordinationFixture);

  const refuses = async () => {
    assert.equal((await f.attempt()).kind, 'conflict');
    assert.deepEqual(await f.registry.claims(), [f.original]);
  };

  const gate = new TurnGate();
  f.nativeOwner.gate = gate;
  const sending = f.owner.coordinator.send('Held work');
  await within(gate.entered, 5000, 'held owner');

  try {
    await refuses();
  } finally {
    gate.open();
    await sending;
  }

  f.emit({
    type: 'subagent',
    subagent: {
      id: 'familiar',
      name: 'Worker',
      kind: 'review',
      status: 'running',
    },
  });

  await refuses();

  f.emit({
    type: 'subagent',
    subagent: {
      id: 'familiar',
      name: 'Worker',
      kind: 'review',
      status: 'completed',
    },
  });

  f.emit({
    type: 'command',
    command: { id: 'brew', description: 'Work', status: 'running' },
  });

  await refuses();

  f.emit({
    type: 'command',
    command: { id: 'brew', description: 'Work', status: 'completed' },
  });

  f.nativeOwner.interruptNext = true;
  await f.owner.coordinator.send('remember-port');
  assert.equal(f.owner.coordinator.snapshot.phase, 'recovery');
  await refuses();
});

for (const change of ['report', 'reset'] as const)
  test(`automatic handover checks the ${change} after verification under the lock`, async (t) => {
    const f = await automatic(t);
    const resetsAt = Date.now() / 1000 + 1;

    f.emit({
      type: 'usage',
      usage: {
        account: {
          limits: [{ window: '5H', percent: 100, resetsAt, observedAt: 0 }],
        },
      },
    });

    const original = CoordinationStore.prototype.handOver;

    vi.spyOn(CoordinationStore.prototype, 'handOver').mockImplementation(
      function (
        this: CoordinationStore,
        owner,
        id,
        deadline,
        verify,
        refusal,
        field,
      ) {
        return original.call(
          this,
          owner,
          id,
          deadline,
          async (ledger) => {
            await verify(ledger);

            if (change === 'report')
              f.emit({
                type: 'usage',
                usage: {
                  account: {
                    limits: [
                      { window: '5H', percent: 20, resetsAt, observedAt: 0 },
                    ],
                  },
                },
              });
            else vi.spyOn(Date, 'now').mockReturnValue(resetsAt * 1000);
          },
          refusal,
          field,
        );
      },
    );

    assert.equal((await f.attempt()).kind, 'conflict');
    assert.deepEqual(await f.registry.claims(), [f.original]);
  });

test('an alias conflict transfers the original claim without reserving the caller metadata', async (t) => {
  const f = await automatic(t);

  const [result] = await Promise.all([
    callControl(await f.requester.binding(), {
      kind: 'claim',
      input: {
        reference: 'task:different',
        aliases: ['task:alias'],
        summary: 'Other summary',
      },
    }),
    f.answer(),
  ]);

  if (result.kind !== 'claimed') assert.fail(JSON.stringify(result));

  assert.equal(result.claim.id, f.original.id);
  assert.deepEqual(result.claim.references, f.original.references);
  assert.equal(result.claim.summary, 'Original work');
  assert.deepEqual(result.claim.assigned, ['github:acme/queue#7']);
});

for (const alias of ['task:ALIAS', 'https://github.com/acme/queue/pull/7'])
  test(`a refused alias conflict supplies a usable manual command for ${alias}`, async (t) => {
    const f = await automatic(t);

    f.emit({
      type: 'usage',
      usage: {
        account: {
          limits: [
            {
              window: '5H',
              percent: 25,
              resetsAt: Date.now() / 1000 + 3600,
              observedAt: 0,
            },
          ],
        },
      },
    });

    const [result] = await Promise.all([
      callControl(await f.requester.binding(), {
        kind: 'claim',
        input: {
          reference: 'task:different',
          aliases: [alias],
          summary: 'Other work',
        },
      }),
      f.answer(),
    ]);

    if (result.kind !== 'conflict') assert.fail(JSON.stringify(result));

    const reference = /with \/task take (.+) once its owner is idle\.$/.exec(
      result.message,
    )?.[1];

    assert.equal(reference, alias);

    await Promise.all([
      f.requester.coordination.takeTask(reference!),
      f.answer('transfer'),
    ]);

    const [owned] = await f.registry.claims();
    assert.equal(owned!.id, f.original.id);

    assert.equal(
      owned!.owner.conversation,
      f.requester.coordinator.snapshot.conversation!.id,
    );

    assert.equal(owned!.summary, 'Original work');
  });

test('an automatic request times out without granting ownership or leaving a request', async (t) => {
  const f = await automatic(t);

  const result = await callControl(
    await f.requester.binding(),
    {
      kind: 'claim',
      input: { reference: 'task:shared', summary: 'Other work' },
    },
    Date.now() + 3000,
  );

  assert.equal(result.kind, 'conflict');
  assert.deepEqual(await f.registry.claims(), [f.original]);
  assert.equal(f.requester.coordination.snapshot.error, undefined);
});

test('an automatic requester that switches conversations withdraws without admission', async (t) => {
  const f = await automatic(t);
  const claiming = f.requester.claim();
  await f.requested();
  const switching = f.requester.coordinator.newConversation();
  const result = await claiming;
  await switching;
  assert.equal(result.kind, 'error');
  assert.deepEqual(await f.registry.claims(), [f.original]);
});

test('a handover during withdrawal returns the actual automatic ownership', async (t) => {
  const f = await automatic(t);
  const state = CoordinationStore.prototype.state;
  // every read until withdrawal misses the request, so the requester's first poll gives up, whichever read comes first
  let hidden = true;

  vi.spyOn(CoordinationStore.prototype, 'state').mockImplementation(
    async function (this: CoordinationStore, ...args) {
      const ledger = await state.apply(this, args);

      if (!hidden) return ledger;

      return {
        ...ledger,
        claims: ledger.claims.map((claim) => ({
          ...claim,
          automaticTransfer: undefined,
        })),
      };
    },
  );

  const original = CoordinationStore.prototype.withdrawTransfer;

  vi.spyOn(CoordinationStore.prototype, 'withdrawTransfer').mockImplementation(
    async function (
      this: CoordinationStore,
      activation,
      id,
      deadline,
      verify,
      field,
    ) {
      hidden = false;

      await this.handOver(
        f.original.owner,
        id,
        deadline,
        verify,
        () => undefined,
        field,
      );

      return original.call(this, activation, id, deadline, verify, field);
    },
  );

  // the default deadline keeps the request from expiring before the hand-over reads it
  const result = await callControl(await f.requester.binding(), {
    kind: 'claim',
    input: { reference: 'task:shared', summary: 'Other' },
  });

  if (result.kind !== 'claimed') assert.fail(JSON.stringify(result));

  assert.equal(
    result.claim.owner.conversation,
    f.requester.coordinator.snapshot.conversation!.id,
  );

  assert.deepEqual(await f.registry.claims(), [result.claim]);
  assert.equal(result.claim.automaticTransfer, undefined);
});

test('unconfirmed automatic withdrawal reports an unknown result instead of a conflict', async (t) => {
  const f = await automatic(t);

  vi.spyOn(CoordinationStore.prototype, 'withdrawTransfer').mockRejectedValue(
    new Error('Read unavailable'),
  );

  const result = await callControl(
    await f.requester.binding(),
    { kind: 'claim', input: { reference: 'task:shared', summary: 'Other' } },
    Date.now() + 3000,
  );

  assert.equal(result.kind, 'error');

  assert.match(
    result.kind === 'error' ? result.message : '',
    /Coordination result unknown/,
  );

  const [claim] = await f.registry.claims();
  assert.deepEqual(claim?.owner, f.original.owner);
});

test('a handover leaves the owner without the claim while its ledger reads run out of time', async (t) => {
  const { a, b, answer, registry } = await transfer(t);
  const local = a.coordination['registry'];
  const handOver = local.handOver.bind(local);
  const state = vi.spyOn(local, 'state');
  assert.ok(a.coordination.snapshot.ownClaim);

  const handing = vi
    .spyOn(local, 'handOver')
    .mockImplementation(async (...args: Parameters<typeof handOver>) => {
      // the tick's own read ends before the commit, so only the refresh after the handover could publish it
      await a.coordination['refreshing']?.promise;
      state.mockRejectedValue(new DeadlineExpired());

      return handOver(...args);
    });

  try {
    await Promise.all([b.coordination.takeTask('task:shared'), answer()]);

    assert.equal(
      (await registry.claims())[0]!.owner.conversation,
      b.coordinator.snapshot.conversation!.id,
    );

    await until(
      'the owner to lose its claim',
      () => a.coordination.snapshot.ownClaim === undefined,
    );

    await until(
      'an expired ledger read',
      () => a.coordination['failures'].get('ledger')?.expired === true,
    );

    assert.equal(a.coordination.snapshot.error, undefined);
  } finally {
    handing.mockRestore();
    state.mockRestore();
  }
});
