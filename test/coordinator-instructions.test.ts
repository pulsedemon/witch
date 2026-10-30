import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { fixture, readRecord } from './fixtures/coordinator.js';

for (const outcome of ['interrupted', 'failed'] as const) {
  test(`a ${outcome} first turn retries fixed instructions before recording delivery`, async () => {
    const f = await fixture();
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
  const f = await fixture();
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
  const f = await fixture();
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

for (const revision of [undefined, '0'.repeat(64)]) {
  test(`a session with ${revision ? 'outdated' : 'missing'} instructions receives them without resending unchanged memory`, async () => {
    const f = await fixture();
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
