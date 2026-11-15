import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'vitest';
import { callControl } from '../../../src/persistence/control.js';
import { unitCoordinationFixture } from '../../fixtures/coordination.js';
import { orderedCleanup } from '../../fixtures/cleanup.js';
import { compiledCli } from '../../fixtures/compiled-cli.js';
import { TurnGate } from '../../fixtures/agent.js';
import { selectionTurn } from '../../fixtures/task-selection.js';
import { within } from '../../fixtures/within.js';

const execute = promisify(execFile);

test('the CLI releases completed side work across projects while the original foreground task continues', async (t) => {
  const entry = await compiledCli();
  const f = await unitCoordinationFixture(orderedCleanup(t.onTestFinished));
  const a = await f.start();
  const c = await f.start('C');
  const binding = await a.binding();
  const pr = 'https://github.com/acme/side/pull/692';
  const issue = 'https://github.com/acme/side/issues/691';

  const initial = await callControl(binding, {
    kind: 'claim',
    input: {
      reference: 'task:main',
      aliases: [pr, issue, 'task:side'],
      summary: 'Main and side work',
    },
  });

  if (initial.kind !== 'claimed') assert.fail(JSON.stringify(initial));

  const original = initial.claim;

  const expected = {
    ...original,
    references: [`task:${original.owner.project}:main`],
  };

  const gate = new TurnGate();
  a.a.gate = gate;
  const sending = a.coordinator.send('continue original task');

  try {
    await within(gate.entered, 5000, 'original foreground task');
    const before = await f.registry.claims();
    assert.equal((await c.claim(pr, 'Review side PR')).kind, 'conflict');
    assert.deepEqual(await f.registry.claims(), before);

    const { stdout, stderr } = await execute(process.execPath, [
      entry,
      '--control-dir',
      binding.directory,
      '--control-conversation',
      binding.conversation,
      '--control-activation',
      binding.activation,
      '--release',
      original.id,
      '--reference',
      pr,
      '--reference',
      issue,
      '--reference',
      'task:side',
      '--json',
    ]);

    assert.equal(stderr, '');
    const released = JSON.parse(stdout);
    assert.equal(released.kind, 'references-released');

    assert.deepEqual(released.references, [
      'github:acme/side#692',
      'github:acme/side#691',
      `task:${original.owner.project}:side`,
    ]);

    assert.deepEqual(released.claim, expected);
    assert.deepEqual(await f.registry.claims(), [expected]);
    assert.equal(a.coordinator.snapshot.phase, 'running');
    const claimed = await c.claim(pr, 'Review side PR');

    if (claimed.kind !== 'claimed') assert.fail(JSON.stringify(claimed));

    assert.notEqual(claimed.claim.owner.project, original.owner.project);
    assert.deepEqual((await a.query()).ownClaim, expected);
    assert.equal(a.coordinator.snapshot.phase, 'running');
  } finally {
    gate.open();
    await sending;
  }

  assert.equal(a.a.inputs[0]!.prompt, 'continue original task');
  assert.equal(a.coordinator.snapshot.phase, 'idle');

  assert.match(
    a.a.inputs[0]!.context!,
    /An open PR or having authored it is not a reason to retain ownership/,
  );

  assert.match(a.a.inputs[0]!.context!, /--release <claim-id> --reference/);
});

test('selective release rejects a suggestion without canceling its reservation', async (t) => {
  const cleanup = orderedCleanup(t.onTestFinished);
  const f = await unitCoordinationFixture(cleanup);
  const a = await f.start();
  const choosing = await selectionTurn(cleanup, a);
  const { ticket } = await choosing.select();
  const claim = await choosing.recommend(ticket.id);
  await choosing.finish();
  const before = await f.registry.claims();

  const result = await callControl(await a.binding(), {
    kind: 'release-references',
    claim: claim.id,
    references: ['https://github.com/acme/queue/issues/17'],
  });

  assert.equal(result.kind, 'error');

  if (result.kind === 'error')
    assert.match(result.message, /whole suggested task/);

  assert.deepEqual(await f.registry.claims(), before);
});

for (const activity of ['familiar', 'brew'] as const)
  test(`selective release waits for a running ${activity}`, async (t) => {
    const f = await unitCoordinationFixture(orderedCleanup(t.onTestFinished));
    const a = await f.start();

    const claimed = await callControl(await a.binding(), {
      kind: 'claim',
      input: {
        reference: 'task:main',
        aliases: ['task:side'],
        summary: 'Main and side',
      },
    });

    if (claimed.kind !== 'claimed') assert.fail(JSON.stringify(claimed));

    const emit = a.a.sessions[0]!.options.onEvent;

    const event = (status: 'running' | 'completed') => {
      if (activity === 'familiar')
        emit({
          type: 'subagent',
          subagent: {
            id: 'worker',
            name: 'Side worker',
            kind: 'review',
            status,
          },
        });
      else
        emit({
          type: 'command',
          command: { id: 'brew', description: 'Side command', status },
        });
    };

    event('running');
    const before = await f.registry.claims();

    const action = {
      kind: 'release-references' as const,
      claim: claimed.claim.id,
      references: ['task:side'],
    };

    const refused = await callControl(await a.binding(), action);
    assert.equal(refused.kind, 'error');

    if (refused.kind === 'error')
      assert.match(refused.message, /Stop the running familiars and brews/);

    assert.deepEqual(await f.registry.claims(), before);
    event('completed');
    const released = await callControl(await a.binding(), action);
    assert.equal(released.kind, 'references-released');

    assert.deepEqual((await a.query()).ownClaim?.references, [
      `task:${claimed.claim.owner.project}:main`,
    ]);
  });
