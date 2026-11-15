import assert from 'node:assert/strict';
import { test } from 'vitest';
import { callControl } from '../../../src/persistence/control.js';
import { TurnGate } from '../../fixtures/agent.js';
import {
  setup as reviewSetup,
  autoReply,
} from '../../fixtures/copilot-reviews.js';
import { setup as repairSetup } from '../../fixtures/pr-repair.js';
import { until, within } from '../../fixtures/within.js';

test('removing side references clears queued reviews without re-binding through the closing issue', async (t) => {
  const x = await reviewSetup(t);
  const releaseDelivery = x.c.holdPromptDelivery();

  try {
    await callControl(await x.a.binding(), {
      kind: 'claim',
      input: {
        reference: x.source.closingIssues[0]!,
        aliases: ['task:main', 'task:unrelated'],
        summary: 'Main and side',
      },
    });

    await x.observe();
    await x.a.query();
    const claim = x.a.coordination.snapshot.ownClaim!;
    assert.ok(x.c.copilot.context());
    assert.equal(x.c.copilot.ready(), true);

    const unrelated = await callControl(await x.a.binding(), {
      kind: 'release-references',
      claim: claim.id,
      references: ['task:unrelated'],
    });

    assert.equal(unrelated.kind, 'references-released');
    assert.ok(x.c.copilot.context());
    assert.equal(x.c.copilot.ready(), true);

    const released = await callControl(await x.a.binding(), {
      kind: 'release-references',
      claim: claim.id,
      references: [x.source.pullRequest.url, ...x.source.closingIssues],
    });

    assert.equal(released.kind, 'references-released');
    assert.equal(x.c.copilot.context(), undefined);
    assert.equal(x.c.copilot.ready(), false);
    assert.equal(await x.observe(), false);
    assert.equal(x.reviews().length, 0);
    assert.equal((await x.a.query()).ownClaim?.id, claim.id);

    assert.deepEqual((await x.a.query()).ownClaim?.references, [
      `task:${claim.owner.project}:main`,
    ]);

    x.c.copilot.activate();
    assert.equal(x.c.copilot.context(), undefined);
    assert.equal(await x.observe(), false);

    const reclaimed = await callControl(await x.a.binding(), {
      kind: 'claim',
      input: {
        reference: 'task:main',
        aliases: [x.source.pullRequest.url],
        summary: 'Resume side review',
      },
    });

    assert.equal(reclaimed.kind, 'claimed');
    autoReply(x.f, x.a, x.source);
    assert.equal(await x.observe(), true);
    assert.equal(x.c.copilot.ready(), true);
  } finally {
    releaseDelivery();
  }

  await x.handled();
  assert.equal(x.reviews().length, 1);
});

test('removing the PR reference interrupts an active review once while retaining the main claim', async (t) => {
  const x = await reviewSetup(t);

  await callControl(await x.a.binding(), {
    kind: 'claim',
    input: {
      reference: x.source.closingIssues[0]!,
      aliases: ['task:main'],
      summary: 'Main and side',
    },
  });

  const gate = new TurnGate();
  x.a.a.gate = gate;

  try {
    await x.observe();
    await within(gate.entered, 5000, 'review started');
    const claim = (await x.a.query()).ownClaim!;

    const result = await callControl(await x.a.binding(), {
      kind: 'release-references',
      claim: claim.id,
      references: [x.source.pullRequest.url, ...x.source.closingIssues],
    });

    assert.equal(result.kind, 'references-released');

    assert.equal(
      (await within(gate.result, 5000, 'review stopped')).status,
      'interrupted',
    );

    await until('review settled', () => x.c.snapshot.phase === 'idle');

    assert.equal(
      x.a.a.stops.filter(({ operation }) => operation === 'interrupt').length,
      1,
    );

    assert.equal((await x.a.query()).ownClaim?.id, claim.id);

    assert.deepEqual((await x.a.query()).ownClaim?.references, [
      `task:${claim.owner.project}:main`,
    ]);

    assert.equal(x.c.copilot.context(), undefined);
    assert.equal(await x.observe(), false);
    assert.equal(x.reviews().length, 1);
  } finally {
    gate.open();
  }
});

test('persisted review state cannot regain a released PR when the main claim survives restart', async (t) => {
  const x = await reviewSetup(t);
  const releaseDelivery = x.c.holdPromptDelivery();
  const id = x.c.snapshot.conversation!.id;

  await callControl(await x.a.binding(), {
    kind: 'claim',
    input: {
      reference: x.source.closingIssues[0]!,
      aliases: ['task:main'],
      summary: 'Main and side',
    },
  });

  await x.observe();
  const claim = (await x.a.query()).ownClaim!;
  assert.equal(x.c.copilot.ready(), true);

  const released = await callControl(await x.a.binding(), {
    kind: 'release-references',
    claim: claim.id,
    references: [x.source.pullRequest.url, ...x.source.closingIssues],
  });

  assert.equal(released.kind, 'references-released');
  await x.c.close({ restart: true });
  releaseDelivery();
  const reopened = await x.f.start('A', { conversation: id });
  const hold = reopened.coordinator.holdPromptDelivery();

  try {
    reopened.coordination.updateRepository(x.repository);
    reopened.coordinator.copilot.updateRepository(x.repository);
    assert.equal((await reopened.query()).ownClaim?.id, claim.id);
    assert.equal(reopened.coordinator.copilot.context(), undefined);
    assert.equal(await reopened.coordinator.copilot.observe(x.source), false);
    assert.equal(reopened.coordinator.copilot.ready(), false);
    assert.equal(reopened.a.inputs.length, 0);

    assert.deepEqual((await reopened.query()).ownClaim?.references, [
      `task:${claim.owner.project}:main`,
    ]);
  } finally {
    hold();
  }
});

for (const failure of ['conflict', 'checks'] as const)
  test(`removing the PR reference revokes an active ${failure} repair with the same claim ID`, async (t) => {
    const x = await repairSetup(t);
    const url = x.pullRequest().url;

    await callControl(await x.x.binding(), {
      kind: 'claim',
      input: {
        reference: url,
        aliases: ['task:main'],
        summary: 'Main and side',
      },
    });

    const repository =
      failure === 'conflict'
        ? x.read()
        : x.read({
            mergeable: 'MERGEABLE',
            checks: 'failing',
            failed: [
              {
                name: 'verify',
                url: 'https://github.com/o/r/actions/runs/1/job/2',
              },
            ],
          });

    const gate = new TurnGate();
    x.x.a.gate = gate;

    try {
      x.observe(repository);
      await within(gate.entered, 5000, 'repair started');
      const claim = (await x.x.query()).ownClaim!;

      const result = await callControl(await x.x.binding(), {
        kind: 'release-references',
        claim: claim.id,
        references: [url],
      });

      assert.equal(result.kind, 'references-released');

      assert.equal(
        (await within(gate.result, 5000, 'repair stopped')).status,
        'interrupted',
      );

      await x.idle();

      assert.equal(
        x.x.a.stops.filter(({ operation }) => operation === 'interrupt').length,
        1,
      );

      assert.equal((await x.x.query()).ownClaim?.id, claim.id);

      assert.deepEqual((await x.x.query()).ownClaim?.references, [
        `task:${claim.owner.project}:main`,
      ]);

      x.observe(repository);
      assert.equal(x.c.repair.ready(), false);

      assert.equal(
        x.x.a.inputs.filter(({ author }) => author === 'witch').length,
        1,
      );
    } finally {
      gate.open();
    }
  });
