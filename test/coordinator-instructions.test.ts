import assert from 'node:assert/strict';

import { writeFile } from 'node:fs/promises';

import { join } from 'node:path';

import { test } from 'vitest';

import { unitFixture, readRecord } from './fixtures/coordinator.js';

for (const outcome of ['interrupted', 'failed'] as const) {
  test(`a ${outcome} first turn retries fixed instructions before recording delivery`, async () => {
    const f = await unitFixture();

    try {
      if (outcome === 'interrupted') f.a.interruptNext = true;
      else f.a.failNext = true;

      await f.coordinator.send('Attempt task');

      assert.match(f.a.inputs.at(-1)!.context!, /You are running inside Witch/);

      const id = f.coordinator.snapshot.conversation!.id;

      assert.equal(
        (await readRecord(f.root, id)).sessions.a!
          .deliveredInstructionsRevision,
        undefined,
      );

      await f.coordinator.send('Retry task');

      assert.match(f.a.inputs.at(-1)!.context!, /You are running inside Witch/);

      assert.ok(
        (await readRecord(f.root, id)).sessions.a!
          .deliveredInstructionsRevision,
      );

      await f.coordinator.send('Continue');

      assert.equal(f.a.inputs.at(-1)!.context, undefined);
    } finally {
      await f.coordinator.close();
    }
  });
}

test("the fixed instructions use Witch's names for native skills, subagents and background commands, saying skill only where they map them", async () => {
  const f = await unitFixture();

  try {
    await f.coordinator.send('Initial task');

    const context = f.a.inputs.at(-1)!.context!;

    const mapping =
      'Witch calls native skills spells, subagents familiars and background commands brews';

    assert.ok(context.includes(mapping), context);

    assert.ok(context.includes('source=<file or spell>'), context);

    assert.doesNotMatch(context.replace(mapping, ''), /skill|subagent/i);
  } finally {
    await f.coordinator.close();
  }
});

test('the fixed instructions lay out transcript replies for scanning and leave voice and text posted elsewhere alone', async () => {
  const f = await unitFixture();

  try {
    await f.coordinator.send('Initial task');

    const context = f.a.inputs.at(-1)!.context!;

    const rule = context
      .split('\n\n')
      .find((paragraph) =>
        paragraph.startsWith('Lay out replies shown in the Witch transcript'),
      );

    assert.ok(rule, context);

    assert.match(rule, /Open with the outcome in one sentence/);

    assert.match(
      rule,
      /one-line bullets under a short bold label, even when there is only one group/,
    );

    assert.match(rule, /don't bold the start of each bullet/);

    assert.match(rule, /Keep each bullet to one line/);

    assert.match(rule, /Answer a single question or point in prose/);

    assert.match(
      rule,
      /layout only; voice comes from the user's own instructions/,
    );

    assert.match(
      rule,
      /does not apply to text you write or post outside the transcript/,
    );

    assert.match(rule, /or to drafts of that text/);
  } finally {
    await f.coordinator.close();
  }
});

test('the fixed instructions take the recommended route past a blocked step and keep working on a runtime with usage', async () => {
  const f = await unitFixture();

  try {
    await f.coordinator.send('Initial task');

    const context = f.a.inputs.at(-1)!.context!;

    const rule = context
      .split('\n\n')
      .find((paragraph) => paragraph.startsWith('When a step is blocked'));

    assert.ok(rule, context);

    assert.match(
      rule,
      /recommended route that stays within the task's authorization, take it instead of asking the user to choose/,
    );

    assert.match(rule, /report what you did and what remains pending/);

    assert.match(
      rule,
      /works around a Witch refusal, a claim conflict or a native permission denial is outside that authorization/,
    );

    assert.match(rule, /not a reason to stop or to wait for its reset/);

    assert.match(
      rule,
      /continue the work, verification included, on a runtime that has usage/,
    );

    assert.match(rule, /request a new route for delegated work/);

    assert.match(
      rule,
      /leave pending only the steps that need the exhausted runtime/,
    );

    assert.match(rule, /a run on it is refused for its usage limit/);

    assert.match(
      rule,
      /a reading shown at 100% doesn't establish that by itself, and neither do request-rate throttling or unrelated errors/,
    );

    assert.match(
      rule,
      /Ask the user only for product or scope decisions the request and evidence can't settle/,
    );

    assert.match(
      rule,
      /confirmations that native or user rules require, such as before irreversible actions/,
    );
  } finally {
    await f.coordinator.close();
  }
});

test('the fixed instructions fix discovered bugs and file only blocked follow-ups', async () => {
  const f = await unitFixture();

  try {
    await f.coordinator.send('Initial task');

    const context = f.a.inputs.at(-1)!.context!;

    const rule = context
      .split('\n\n')
      .find((paragraph) =>
        paragraph.startsWith('When you find a concrete bug'),
      );

    assert.ok(rule, context);

    assert.match(
      rule,
      /concrete bug in the current repository's code, including a failing test outside your original change, fix it in the current task instead of only filing an issue/,
    );

    assert.match(
      rule,
      /Make the smallest sufficient fix, confirm it end to end, then add or update its regression test/,
    );

    assert.match(
      rule,
      /Name each incidental fix in one line in the pr description/,
    );

    assert.match(
      rule,
      /If you cannot complete the fix within authorized work, such as code claimed by another session or a fix that needs a product decision, report the blocker and file an issue at once/,
    );

    assert.match(
      rule,
      /Preserve ownership and approval boundaries, ask only for the missing decision or required approval, and continue independent task work/,
    );

    assert.match(
      rule,
      /Filing it needs no further confirmation from the user, even where user rules ask for one/,
    );

    assert.match(
      rule,
      /Search the current repository's open and closed issues before every creation, including after a repeated observation/,
    );

    assert.match(
      rule,
      /Reuse a matching issue, commenting on it only when your evidence adds something/,
    );

    assert.match(rule, /evidence, impact and a checkable completion condition/);

    assert.match(rule, /reconcile it against existing issues before retrying/);

    assert.match(rule, /clickable Markdown link using its full URL/);

    assert.match(rule, /A bug your current task fixes needs no issue/);

    assert.match(
      rule,
      /The post-pr follow-up audit still files work deliberately deferred outside the pr by decision; it does not defer a newly discovered fixable bug or a blocker belonging to the current pr/,
    );

    assert.match(
      rule,
      /Tell the user about a bug in another project's code instead of filing it in that project's tracker/,
    );

    assert.match(
      rule,
      /An intermittently failing test outside your change is a bug/,
    );

    assert.match(
      rule,
      /Fix errors introduced by your own change without filing separate issues/,
    );

    assert.match(
      rule,
      /Environmental failures, transient external-service failures, speculative improvements and warnings that show no broken behavior are not bugs to file/,
    );

    assert.match(
      rule,
      /If a search or write is blocked, report the bug and the blocked step instead/,
    );

    assert.match(rule, /Native approval rules still apply/);

    const audit = context
      .split('\n\n')
      .find((paragraph) =>
        paragraph.startsWith('After successfully opening a pull request'),
      );

    assert.ok(audit, context);

    assert.match(audit, /Check recorded deferred work, review findings/);

    assert.match(
      audit,
      /Do not file already-fixed findings, accepted tradeoffs or speculative improvements; keep blockers belonging to the current pull request in that work/,
    );
  } finally {
    await f.coordinator.close();
  }
});

for (const revision of [undefined, '0'.repeat(64)]) {
  test(`a session with ${revision ? 'outdated' : 'missing'} instructions receives them without resending unchanged memory`, async () => {
    const f = await unitFixture();

    try {
      await f.coordinator.send('Initial task');

      const id = f.coordinator.snapshot.conversation!.id;

      const native = f.a.inputs.at(-1)!.session;

      await f.coordinator.close();

      const record = await readRecord(f.root, id);

      record.sessions.a!.deliveredInstructionsRevision = revision;

      await writeFile(
        join(f.root, 'state', 'conversations', id, 'state.json'),
        JSON.stringify(record),
      );

      const reopened = await f.reopen();

      try {
        await reopened.send('Continue after upgrade');

        const input = f.a.inputs.at(-1)!;

        assert.equal(input.prompt, 'Continue after upgrade');

        assert.equal(input.session, native);

        assert.match(input.context!, /You are running inside Witch/);

        assert.doesNotMatch(input.context!, /Accepted shared memory/);

        await reopened.send('Again');

        assert.equal(f.a.inputs.at(-1)!.context, undefined);
      } finally {
        await reopened.close();
      }
    } finally {
      await f.coordinator.close();
    }
  });
}
