import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, vi } from 'vitest';
import type { FamiliarAction } from '../src/agents/familiar-report.js';
import { callControl, ControlHost } from '../src/persistence/control.js';
import { checkDeadline } from '../src/persistence/coordination.js';
import {
  coordinationFixture,
  pauseDiscovery,
} from './fixtures/coordination.js';
import { orderedCleanup } from './fixtures/cleanup.js';
import { scratch } from './fixtures/scratch.js';
import { within } from './fixtures/within.js';

test('familiar reports bypass a blocked task mailbox and preserve active-session admission', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  pauseDiscovery(vi.spyOn);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const f = await coordinationFixture(cleanup, async () => {
    entered.resolve();
    await release.promise;
  });
  const client = await f.start();
  client.a.sessions[0]!.session.reportFamiliar = async (action) => {
    if (action.kind === 'familiar-update') {
      client.a.sessions[0]!.options.onEvent({
        type: 'subagent',
        subagent: {
          id: 'review',
          name: 'Claude review',
          kind: '',
          ...action.progress,
        },
      });
      return { kind: 'familiar-updated' };
    }
    return { kind: 'familiar-registered' };
  };
  const binding = client.coordination.familiarBinding();
  const claiming = client.claim('https://github.com/acme/widget/issues/42');
  try {
    await within(entered.promise, 5000, 'claim assignment');
    const action: FamiliarAction = {
      kind: 'familiar-update',
      run: randomUUID(),
      sequence: 0,
      progress: { status: 'running', model: 'observed-model', tools: 7 },
    };
    assert.equal(
      (await within(callControl(binding, action), 3000, 'independent report'))
        .kind,
      'familiar-updated',
    );
    assert.equal(client.coordinator.snapshot.subagents[0]!.tools, 7);
    const stale = await callControl(
      { ...binding, activation: randomUUID() },
      { ...action, sequence: 1, progress: { status: 'failed', tools: 99 } },
    );
    assert.equal(stale.kind, 'error');
    assert.equal(client.coordinator.snapshot.subagents[0]!.tools, 7);
    const wrongMailbox = await callControl(binding, { kind: 'peers' });
    assert.equal(wrongMailbox.kind, 'error');
  } finally {
    release.resolve();
    assert.equal((await claiming).kind, 'claimed');
  }
});

test('an explicit control deadline reaches the host and prevents late report acceptance', async () => {
  const binding = {
    directory: await scratch('familiar-deadline-'),
    conversation: 'conversation',
    activation: randomUUID(),
  };
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const deadline = Date.now() + 10_000;
  let accepted = false;
  let received = 0;
  const host = await ControlHost.open(
    binding.directory,
    async (request) => {
      received = request.deadline;
      entered.resolve();
      await release.promise;
      checkDeadline(request.deadline);
      accepted = true;
      return { kind: 'familiar-registered' };
    },
    (error) => {
      throw error;
    },
  );
  const calling = callControl(
    binding,
    { kind: 'familiar-register', run: randomUUID(), name: 'review' },
    deadline,
  );
  const rejected = assert.rejects(calling, /result unknown/);
  let now: ReturnType<typeof vi.spyOn> | undefined;
  try {
    await within(entered.promise, 3000, 'report arrival');
    assert.equal(received, deadline);
    now = vi.spyOn(Date, 'now').mockReturnValue(deadline + 1);
    release.resolve();
    await rejected;
    await host.drain();
    assert.equal(accepted, false);
  } finally {
    release.resolve();
    await host.close();
    now?.mockRestore();
  }
});

test('only a supporting session receives familiar instructions and the exact user prompt stays separate', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  pauseDiscovery(vi.spyOn);
  const f = await coordinationFixture(cleanup);
  const client = await f.start();
  const prompt = 'Review this\n  exact user input.';
  await client.coordinator.send(prompt);
  assert.doesNotMatch(client.a.inputs.at(-1)!.context!, /--familiar-claude/);
  client.a.sessions[0]!.session.reportFamiliar = async () => ({
    kind: 'familiar-registered',
  });
  await client.coordinator.send(prompt);
  const input = client.a.inputs.at(-1)!;
  assert.equal(input.prompt, prompt);
  assert.ok(!input.context!.includes(prompt));
  assert.ok(input.context!.includes(client.coordination.familiarCommand()));
  assert.match(input.context!, /--familiar-claude <task-name> --report-file/);
  assert.match(input.context!, /--permission-prompts none/);
  assert.match(input.context!, /keep its stdout connected/);
});
