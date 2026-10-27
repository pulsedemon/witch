import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test, vi } from 'vitest';
import { promisify } from 'node:util';
import { Coordinator } from '../src/core/coordinator.js';
import { editorEnvironment } from '../src/core/editor.js';
import { main } from '../src/memory/memory.js';
import { FixtureAgent, TurnGate } from './fixtures/agent.js';
import {
  activity,
  readRecord,
  fixture,
  stranded,
  turns,
} from './fixtures/coordinator.js';
import { passThrough } from './fixtures/git.js';
import { until, within } from './fixtures/within.js';

test('a fresh conversation receives committed memory without a handoff', async () => {
  const { coordinator, a, b, root, memory, note } = await fixture();
  const gate = new TurnGate();
  try {
    a.gate = gate;
    const sending = coordinator.send('remember-port');
    await within(gate.entered, 3000, 'the memory-writing turn');
    const id = coordinator.snapshot.conversation!.id;
    const origin = (await readRecord(root, id)).activity!;
    gate.open();
    await sending;
    const [saved] = await memory.history(main, await note());
    assert.equal(
      (
        await memory.git(memory.root, [
          'log',
          '-1',
          '--format=%B',
          saved!.revision,
        ])
      ).trimEnd(),
      `chore(memory): save a notes\n\nconversation: ${id}\nturn: ${origin.id}`,
    );
    await coordinator.newConversation('b');
    await coordinator.send('Which port should this project use?');
    assert.match(b.inputs.at(-1)!.context!, /Use port 4567/);
    assert.doesNotMatch(b.inputs.at(-1)!.context!, /Pending task context/);
    assert.ok(
      b.inputs.at(-1)!.context!.includes(`Put scratch files under ${tmpdir()}`),
    );
    assert.match(
      b.inputs.at(-1)!.context!,
      /preserves this directory across \/restart/,
    );
    assert.match(
      b.inputs.at(-1)!.context!,
      /unless one of your processes works in it/,
    );
    assert.match(
      b.inputs.at(-1)!.context!,
      /hides the environment of system binaries/,
    );
    assert.equal(a.inputs.length, 1);
  } finally {
    gate.open();
    await coordinator.close();
  }
});

test('unfinished memory holds a prompt until recovery, which preserves the original attribution', async () => {
  const { coordinator, memory, a, workspace, note, root } = await fixture();
  try {
    a.interruptNext = true;
    await coordinator.send('remember-port');
    assert.equal(coordinator.snapshot.phase, 'recovery');
    const id = coordinator.snapshot.conversation!.id;
    const origin = (await readRecord(root, id)).activity!;
    await coordinator.send('unrelated task');
    assert.deepEqual(coordinator.snapshot.queue, ['unrelated task']);
    assert.equal(a.inputs.length, 1);
    await coordinator.recoverMemory('accept');
    const [recovered] = await memory.history(main, await note());
    assert.equal(
      (
        await memory.git(memory.root, [
          'log',
          '-1',
          '--format=%B',
          recovered!.revision,
        ])
      ).trimEnd(),
      `chore(memory): recover a changes\n\nconversation: ${id}\nturn: ${origin.id}`,
    );
    assert.equal(await workspace().isDirty(), false);
    await until(
      'the held prompt',
      () => a.inputs.length === 2 && coordinator.snapshot.phase === 'idle',
    );
    assert.equal(a.inputs[1]!.prompt, 'unrelated task');
  } finally {
    await coordinator.close();
  }
});

test('memory recovery without recorded activity uses manual attribution', async () => {
  const f = await fixture();
  let resumed: Coordinator | undefined;
  try {
    await f.coordinator.send('Prepare workspace');
    const id = f.coordinator.snapshot.conversation!.id;
    await f.coordinator.close();
    assert.equal((await readRecord(f.root, id)).activity, undefined);
    const note = await f.note();
    await writeFile(join(f.workspace().root, note), 'Manual notes.');
    resumed = await f.reopen();
    assert.equal(resumed.snapshot.recovery?.kind, 'pending');
    await resumed.recoverMemory('accept');
    assert.equal(await f.memory.read(main, note), 'Manual notes.');
    const [recovered] = await f.memory.history(main, note);
    assert.equal(
      (
        await f.memory.git(f.memory.root, [
          'log',
          '-1',
          '--format=%B',
          recovered!.revision,
        ])
      ).trimEnd(),
      'chore(memory): recover manual changes\n\nconversation: manual\nturn: manual',
    );
  } finally {
    await resumed?.close();
    await f.coordinator.close();
  }
});

test('discarding interrupted-turn memory resumes queued prompts', async () => {
  const f = await fixture();
  const { coordinator, a } = f;
  try {
    await publishOutside(f, {
      'global/MEMORY.md': 'Global preference 17.',
      [await f.note()]: 'Project preference 29.',
    });
    await coordinator.send('Initial task');
    a.interruptNext = true;
    await coordinator.send('remember-port');
    assert.equal(coordinator.snapshot.recovery?.kind, 'pending');
    await coordinator.send('queued followup');
    assert.deepEqual(coordinator.snapshot.queue, ['queued followup']);
    await coordinator.recoverMemory('discard');
    await until(
      'the held prompt completes',
      () => a.inputs.length > 2 && coordinator.snapshot.phase === 'idle',
    );
    assert.deepEqual(turns(a), [
      ['Initial task', undefined],
      ['remember-port', undefined],
      ['queued followup', undefined],
    ]);
    const prompt = a.inputs.at(-1)!.context!;
    assertMemoryBaseline(prompt);
    assert.match(prompt, /Global preference 17/);
    assert.match(prompt, /Project preference 29/);
    assert.doesNotMatch(prompt, /Use port 4567/);
    assert.doesNotMatch(prompt, /You are running inside Witch/);
  } finally {
    await coordinator.close();
  }
});

test('pending discard after a failed turn corrects memory on persisted resume', async () => {
  const f = await fixture();
  const gate = new TurnGate();
  try {
    const note = await f.note();
    await publishOutside(f, {
      'global/MEMORY.md': 'Global preference 17.',
      [note]: 'Project preference 29.',
      'global/reference.md': 'Reference detail 53.',
    });
    await f.coordinator.send('Initial task');
    const native = f.a.inputs.at(-1)!.session;
    const accepted = await f.memory.resolve(main);
    f.a.failNext = true;
    f.a.gate = gate;
    const sending = f.coordinator.send('Write local notes');
    await within(gate.entered, 3000, 'the writing turn');
    for (const [path, text] of Object.entries({
      'global/MEMORY.md': 'Rejected global preference 71.',
      [note]: 'Rejected project preference 83.',
      'global/reference.md': 'Rejected reference detail 97.',
      'global/discarded.md': 'Rejected new note 109.',
    }))
      await writeFile(join(f.workspace().root, path), text);
    gate.open();
    await sending;
    assert.equal(f.coordinator.snapshot.recovery?.kind, 'pending');
    await f.coordinator.recoverMemory('discard');
    assert.equal(await f.memory.resolve(main), accepted);
    assert.equal(
      await readFile(join(f.workspace().root, 'global/reference.md'), 'utf8'),
      'Reference detail 53.',
    );
    await assert.rejects(
      readFile(join(f.workspace().root, 'global/discarded.md')),
      { code: 'ENOENT' },
    );
    await f.coordinator.close();
    const reopened = await f.reopen();
    try {
      await reopened.send('Continue after reopening');
      const prompt = f.a.inputs.at(-1)!.context!;
      assertMemoryBaseline(prompt);
      assert.match(prompt, /Global preference 17/);
      assert.match(prompt, /Project preference 29/);
      assert.doesNotMatch(prompt, /Rejected/);
      assert.equal(f.a.inputs.at(-1)!.session, native);
      await reopened.send('Unchanged memory');
      assert.equal(f.a.inputs.at(-1)!.context, undefined);
    } finally {
      await reopened.close();
    }
  } finally {
    gate.open();
    await f.coordinator.close();
  }
});

for (const decision of ['accept', 'discard'] as const) {
  test(`failed-turn ${decision} recovery holds queued prompts until resubmission`, async () => {
    const { coordinator, a } = await fixture();
    const gate = new TurnGate();
    try {
      a.gate = gate;
      a.failNext = true;
      const sending = coordinator.send('remember-port');
      await within(gate.entered, 3000, 'the gated turn');
      await coordinator.send('/review');
      await coordinator.send('queued followup');
      gate.open();
      await sending;
      assert.equal(coordinator.snapshot.recovery?.kind, 'pending');
      await coordinator.recoverMemory(decision);
      assert.equal(coordinator.snapshot.phase, 'idle');
      assert.equal(coordinator.snapshot.recovery, undefined);
      assert.deepEqual(coordinator.snapshot.queue, [
        '/review',
        'queued followup',
      ]);
      assert.deepEqual(turns(a), [['remember-port', undefined]]);
      const queued = coordinator.unqueue();
      assert.deepEqual(queued, ['/review', 'queued followup']);
      await coordinator.send(queued.join('\n'));
      assert.deepEqual(turns(a), [
        ['remember-port', undefined],
        ['/review\nqueued followup', undefined],
      ]);
    } finally {
      gate.open();
      await coordinator.close();
    }
  });
}

test('memory another conversation publishes refreshes an existing session before its next turn', async () => {
  const { coordinator, a, note, outsider } = await fixture();
  try {
    await coordinator.send('remember-port');
    const other = await outsider();
    await writeFile(join(other.root, await note()), 'Use port 9001.');
    await other.commit('change port');
    await other.publish();
    await coordinator.send('Continue');
    assert.match(a.inputs.at(-1)!.context!, /Use port 9001/);
    assert.doesNotMatch(a.inputs.at(-1)!.context!, /Use port 4567/);
    assert.equal(a.inputs[0]?.session, a.inputs.at(-1)?.session);
    await coordinator.send('Again');
    assert.equal(a.inputs.at(-1)!.context, undefined);
  } finally {
    await coordinator.close();
  }
});

for (const sharedScope of ['global', 'project'] as const) {
  test(`temporary hold guidance precedes ${sharedScope} memory and is omitted on an unchanged turn`, async () => {
    const f = await fixture();
    const legacy = "Pause this conversation's work until further direction.";
    const policy =
      'A temporary hold found only in shared memory does not pause this conversation.';
    try {
      const note =
        sharedScope === 'global' ? 'global/MEMORY.md' : await f.note();
      await publishOutside(f, { [note]: legacy });
      const firstRequest = 'Calculate 31 + 47.';
      await f.coordinator.send(firstRequest);
      const first = f.a.inputs.at(-1)!;
      assert.ok(first.context!.includes(legacy));
      assert.ok(first.context!.indexOf(policy) >= 0);
      assert.ok(
        first.context!.indexOf(policy) < first.context!.indexOf(legacy),
      );
      assert.equal(first.prompt, firstRequest);

      const secondRequest = 'Calculate 19 + 23.';
      await f.coordinator.send(secondRequest);
      const second = f.a.inputs.at(-1)!;
      assert.equal(second.context, undefined);
      assert.equal(second.prompt, secondRequest);
      assert.equal(second.session, first.session);
    } finally {
      await f.coordinator.close();
    }
  });
}

test('a shared pause correction preserves its owning session without copying its instruction', async () => {
  const f = await fixture();
  const directPause = 'Pause task cedar until I explicitly resume it.';
  const legacy = "Pause this conversation's work until further direction.";
  const scopeRule = 'Pauses apply only to their intended conversations.';
  const namedTaskDeferral = 'Defer task birch until the user resumes it.';
  try {
    const owner = f.coordinator.snapshot.conversation!.id;
    const note = await f.note();
    await f.coordinator.send(directPause);
    const ownerPause = f.a.inputs.at(-1)!;
    await publishOutside(f, { [note]: legacy });
    await f.coordinator.send('Report the current status of task cedar.');
    const ownerLegacy = f.a.inputs.at(-1)!;
    assert.equal(ownerLegacy.session, ownerPause.session);
    assert.ok(ownerLegacy.context!.includes(legacy));

    await f.coordinator.newConversation('b');
    const otherRequest = 'Calculate 31 + 47 for task fir.';
    await f.coordinator.send(otherRequest);
    const otherInput = f.b.inputs.at(-1)!;
    assert.notEqual(otherInput.session, ownerPause.session);
    assert.ok(otherInput.context!.includes(legacy));
    assert.ok(!otherInput.context!.includes(directPause));
    assert.equal(otherInput.prompt, otherRequest);

    await publishOutside(f, {
      [note]: `${scopeRule}\n${namedTaskDeferral}`,
    });
    await f.coordinator.selectConversation(owner);
    const statusRequest = 'Report whether task cedar is still paused.';
    await f.coordinator.send(statusRequest);
    const ownerStatus = f.a.inputs.at(-1)!;
    assert.equal(ownerStatus.session, ownerPause.session);
    assert.equal(ownerPause.prompt, directPause);
    assert.equal(ownerStatus.prompt, statusRequest);
    assert.match(ownerStatus.context!, /replace only their named scopes/);
    assert.match(
      ownerStatus.context!,
      /Removed index facts and deleted notes are no longer active/,
    );

    await f.coordinator.newConversation('a');
    const freshRequest = 'Calculate 19 + 23 for task elm.';
    await f.coordinator.send(freshRequest);
    const freshInput = f.a.inputs.at(-1)!;
    assert.notEqual(freshInput.session, ownerPause.session);
    assert.notEqual(freshInput.session, otherInput.session);
    assert.ok(!freshInput.context!.includes(directPause));
    assert.equal(freshInput.prompt, freshRequest);
    for (const input of [ownerStatus, freshInput]) {
      assert.ok(input.context!.includes(scopeRule));
      assert.ok(input.context!.includes(namedTaskDeferral));
      assert.ok(!input.context!.includes(legacy));
    }
  } finally {
    await f.coordinator.close();
  }
});

test('a successful irrelevant memory update advances its delivery cursor without a snapshot', async () => {
  const f = await fixture();
  try {
    await f.coordinator.send('Initial task');
    const id = f.coordinator.snapshot.conversation!.id;
    const previous = (await readRecord(f.root, id)).sessions.a!
      .deliveredRevision;
    await publishOutside(f, {
      'projects/unrelated/note.md': 'Other project 71.',
    });
    const accepted = await f.memory.resolve(main);
    assert.notEqual(accepted, previous);
    await f.coordinator.send('Continue');
    assert.equal(f.a.inputs.at(-1)!.context, undefined);
    assert.equal(
      (await readRecord(f.root, id)).sessions.a!.deliveredRevision,
      accepted,
    );
    await f.coordinator.close();
    const reopened = await f.reopen();
    try {
      await reopened.send('Continue after reopening');
      assert.equal(f.a.inputs.at(-1)!.context, undefined);
      assert.equal(
        (await readRecord(f.root, id)).sessions.a!.deliveredRevision,
        accepted,
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await f.coordinator.close();
  }
});

for (const result of ['interrupted', 'failed'] as const) {
  test(`a reversed scoped update is corrected after the ${result} turn`, async () => {
    const f = await fixture();
    try {
      const note = await f.note();
      await publishOutside(f, { [note]: 'Project preference 29.' });
      await f.coordinator.send('Initial task');
      const id = f.coordinator.snapshot.conversation!.id;
      const previous = (await readRecord(f.root, id)).sessions.a!
        .deliveredRevision!;
      const native = f.a.inputs.at(-1)!.session;
      await publishOutside(f, { [note]: 'Intermediate preference 41.' });
      if (result === 'interrupted') f.a.interruptNext = true;
      else f.a.failNext = true;
      await f.coordinator.send('Attempt task');
      assert.match(f.a.inputs.at(-1)!.context!, /Intermediate preference 41/);
      assert.equal(
        (await readRecord(f.root, id)).sessions.a!.deliveredRevision,
        previous,
      );
      await f.coordinator.restoreMemory(note, previous);
      const restored = await f.memory.resolve(main);
      assert.notEqual(restored, previous);
      assert.equal(
        (await readRecord(f.root, id)).sessions.a!.deliveredRevision,
        previous,
      );
      await f.coordinator.send('Retry task');
      assert.match(f.a.inputs.at(-1)!.context!, /Project preference 29/);
      assert.doesNotMatch(
        f.a.inputs.at(-1)!.context!,
        /Intermediate preference 41/,
      );
      assert.equal(f.a.inputs.at(-1)!.session, native);
      assert.equal(
        (await readRecord(f.root, id)).sessions.a!.deliveredRevision,
        restored,
      );
    } finally {
      await f.coordinator.close();
    }
  });
}

test('compaction rehydrates both scopes and invalidates references after partial updates', async () => {
  const f = await fixture();
  try {
    const note = await f.note();
    await publishOutside(f, {
      'global/MEMORY.md': 'Global preference 17.',
      [note]: 'Project preference 29.',
      'global/reference.md': 'Reference detail 53.',
    });
    await f.coordinator.send('Initial task');
    assert.match(f.a.inputs.at(-1)!.context!, /Global preference 17/);
    assert.match(f.a.inputs.at(-1)!.context!, /Project preference 29/);
    const native = f.a.inputs.at(-1)!.session;
    await publishOutside(f, { [note]: 'Project preference 41.' });
    await f.coordinator.send('Partial update');
    assert.match(f.a.inputs.at(-1)!.context!, /Project preference 41/);
    assert.doesNotMatch(f.a.inputs.at(-1)!.context!, /Global preference 17/);
    const other = await f.outsider();
    await unlink(join(other.root, 'global/reference.md'));
    await other.commit('remove reference');
    await other.publish();
    await f.coordinator.compact();
    const id = f.coordinator.snapshot.conversation!.id;
    assert.equal(
      (await readRecord(f.root, id)).sessions.a!.deliveredRevision,
      undefined,
    );
    await f.coordinator.close();
    const reopened = await f.reopen();
    try {
      await reopened.send('Continue after compaction');
      const prompt = f.a.inputs.at(-1)!.context!;
      assert.match(prompt, /Global preference 17/);
      assert.match(prompt, /Project preference 41/);
      assert.match(
        prompt,
        /This baseline supersedes all earlier shared-memory snapshots/,
      );
      assert.match(
        prompt,
        /Treat all previously read reference notes as stale/,
      );
      assert.match(prompt, /missing notes no longer apply/);
      assert.equal(f.a.inputs.at(-1)!.session, native);
      await reopened.send('Unchanged memory');
      assert.equal(f.a.inputs.at(-1)!.context, undefined);
    } finally {
      await reopened.close();
    }
  } finally {
    await f.coordinator.close();
  }
});

test('overflow and concise writing guidance reach the active native prompt', async () => {
  const f = await fixture();
  try {
    const note = await f.note();
    const body = 'é'.repeat(3001);
    await publishOutside(f, {
      'global/MEMORY.md': 'Global preference 17.',
      [note]: body,
    });
    const request = 'Calculate 17 + 29.';
    await f.coordinator.send(request);
    const prompt = f.a.inputs.at(-1)!.context!;
    assert.ok(
      prompt.includes(`${join(f.workspace().root, note)}\n(6002 bytes)`),
    );
    assert.match(
      prompt,
      /Read the complete file at the path above before acting/,
    );
    assert.match(prompt, /Global preference 17/);
    assert.ok(!prompt.includes(body.slice(0, 100)));
    assert.equal(await readFile(join(f.workspace().root, note), 'utf8'), body);
    assert.match(prompt, /When nothing durable changed, write nothing/);
    assert.match(prompt, /MEMORY\.md within 6000 UTF-8 bytes/);
    assert.match(
      prompt,
      /Keep planning, test, commit, publication and review progress out of the indexes/,
    );
    assert.equal(f.a.inputs.at(-1)!.prompt, request);
  } finally {
    await f.coordinator.close();
  }
});

test("a turn after an origin moves the project key resumes the session with the new key's memory and its snapshot", async () => {
  const { coordinator, memory, a, notes, git } = await fixture();
  try {
    await git('init', '--quiet');
    await coordinator.send('Start');
    const before = await notes();
    await git('remote', 'add', 'origin', 'https://github.com/owner/repo.git');
    assert.notEqual(await notes(), before);
    await coordinator.send('remember:moved');
    assert.equal(await memory.read(main, await notes()), 'moved');
    assert.match(a.inputs.at(-1)!.context!, /Accepted shared memory/);
    assert.equal(a.inputs.at(-1)!.session, a.inputs[0]!.session);
    await coordinator.send('Again');
    assert.equal(a.sessions.length, 2);
  } finally {
    await coordinator.close();
  }
});

test('a turn back on a project key gets its snapshot after an interrupted turn on another key', async () => {
  const { coordinator, a, git } = await fixture();
  try {
    await git('init', '--quiet');
    await coordinator.send('Start');
    await git('remote', 'add', 'origin', 'https://github.com/owner/repo.git');
    a.interruptNext = true;
    await coordinator.send('Moved');
    await git('remote', 'remove', 'origin');
    await coordinator.send('Back');
    assert.match(a.inputs.at(-1)!.context!, /Accepted shared memory/);
  } finally {
    await coordinator.close();
  }
});

test('a reopened conversation skips the snapshot it was sent, unless its marker was saved without a project', async () => {
  const { coordinator, a, root, reopen } = await fixture();
  const resend = async (prompt: string) => {
    const reopened = await reopen();
    try {
      await reopened.send(prompt);
    } finally {
      await reopened.close();
    }
    return a.inputs.at(-1)!.context!;
  };
  await coordinator.send('Start');
  const id = coordinator.snapshot.conversation!.id;
  await coordinator.close();
  assert.equal(await resend('Same'), undefined);
  const file = join(root, 'state', 'conversations', id, 'state.json');
  const saved = await readRecord(root, id);
  delete saved.sessions.a!.deliveredProject;
  await writeFile(file, JSON.stringify(saved));
  assert.match(await resend('Older'), /Accepted shared memory/);
});

test("opening Witch moves the notes keyed by its checkout's path to the origin's project before a turn", async () => {
  const { coordinator, memory, a, note, git, reopen } = await fixture();
  await git('init', '--quiet');
  await coordinator.send('remember-port');
  await coordinator.close();
  await git('remote', 'add', 'origin', 'https://github.com/owner/repo.git');
  const reopened = await reopen();
  try {
    assert.equal(await memory.read(main, await note()), 'Use port 4567.');
    assert.equal(a.inputs.length, 1);
  } finally {
    await reopened.close();
  }
});

test('opening Witch on memory that conflicts with main leaves the move to recovery', async () => {
  const context = await fixture();
  const { coordinator, a, notes, reopen, git, memory, workspace } = context;
  await git('init', '--quiet');
  const originalNote = await notes();
  const gate = new TurnGate();
  try {
    await coordinator.send('Start');
    a.gate = gate;
    const sending = coordinator.send('remember:mine');
    await within(gate.entered, 2000, 'the gated turn');
    await publishOutside(context, { [originalNote]: 'theirs' });
    gate.open();
    await sending;
    assert.equal(coordinator.snapshot.recovery?.kind, 'conflict');
  } finally {
    gate.open();
    await coordinator.close();
  }
  await git('remote', 'add', 'origin', 'https://github.com/owner/repo.git');
  const migratedNote = await notes();
  const inputs = a.inputs.length;
  const reopened = await reopen();
  try {
    assert.equal(reopened.snapshot.recovery?.kind, 'conflict');
    assert.equal(reopened.snapshot.error, undefined);
    assert.equal(await memory.read(main, originalNote), 'theirs');
    assert.equal(
      await readFile(join(workspace().root, originalNote), 'utf8'),
      'mine',
    );
    await assert.rejects(memory.read(main, migratedNote));
    assert.equal(a.inputs.length, inputs);
    await reopened.recoverMemory('keep');
    await reopened.send('Continue');
    assert.equal(await memory.read(main, migratedNote), 'mine');
    await assert.rejects(memory.read(main, originalNote));
  } finally {
    await reopened.close();
  }
});

test('a git read that fails as Witch opens is reported once and leaves the conversation open', async () => {
  const { coordinator, project, git, reopen } = await fixture();
  await git('init', '--quiet');
  await coordinator.send('Start');
  const id = coordinator.snapshot.conversation!.id;
  await coordinator.close();
  await writeFile(join(project, '.git', 'config'), '[remote "origin"\n', {
    flag: 'a',
  });
  const reopened = await reopen();
  try {
    assert.equal(reopened.snapshot.conversation!.id, id);
    assert.equal(reopened.snapshot.phase, 'idle');
    assert.equal(reopened.snapshot.error?.match(/bad config/g)?.length, 1);
  } finally {
    await reopened.close();
  }
});

describe('an interrupted moved-project reconnect leaves the prompt queued without an error', () => {
  for (const abort of [true, false])
    test(
      abort ? 'adapter rejects' : 'adapter connects after interrupt',
      async () => {
        const { coordinator, a, git } = await fixture();
        const connecting = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        try {
          await git('init', '--quiet');
          await coordinator.send('Start');
          await git(
            'remote',
            'add',
            'origin',
            'https://github.com/owner/repo.git',
          );
          a.beforeConnect = (options) => {
            if (abort)
              options.signal?.addEventListener('abort', () =>
                release.reject(
                  new DOMException('Connect aborted', 'AbortError'),
                ),
              );
            connecting.resolve();
            return release.promise;
          };
          const sending = coordinator.send('Queued');
          await within(connecting.promise, 2000, 'the reconnect');
          await coordinator.interrupt();
          release.resolve();
          await within(sending, 2000, 'the send');
          assert.equal(coordinator.snapshot.phase, 'idle');
          assert.equal(coordinator.snapshot.error, undefined);
          assert.deepEqual(coordinator.snapshot.queue, ['Queued']);
          assert.equal(a.inputs.length, 1);
        } finally {
          release.resolve();
          await coordinator.close();
        }
      },
    );
});

describe('an unrelated reconnect failure after interrupt remains visible', () => {
  for (const interrupt of [true, false])
    test(
      interrupt ? 'ordinary failure after interrupt' : 'unsolicited abort',
      async () => {
        const { coordinator, a, git } = await fixture();
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const failure = interrupt
          ? new Error('connection storage failed')
          : new DOMException('Connection aborted', 'AbortError');
        try {
          await git('init', '--quiet');
          await coordinator.send('Start');
          await git(
            'remote',
            'add',
            'origin',
            'https://github.com/owner/repo.git',
          );
          a.beforeConnect = async () => {
            entered.resolve();
            await release.promise;
            throw failure;
          };
          const sending = coordinator.send('Moved');
          await within(entered.promise, 2000, 'the reconnect');
          if (interrupt) await coordinator.interrupt();
          release.resolve();
          await within(sending, 2000, 'the send');
          assert.equal(coordinator.snapshot.error, failure.message);
          assert.deepEqual(coordinator.snapshot.queue, ['Moved']);
          assert.equal(a.inputs.length, 1);
          assert.equal(coordinator.snapshot.phase, 'idle');
        } finally {
          release.resolve();
          await coordinator.close();
        }
      },
    );
});

test('recovery has one owner and shutdown waits for its accepted commit', async () => {
  const { coordinator, memory, a, workspace, note } = await fixture();
  a.interruptNext = true;
  await coordinator.send('remember-port');
  const recovering = coordinator.recoverMemory('accept');
  await assert.rejects(
    coordinator.recoverMemory('discard'),
    /Stop the current operation/,
  );
  await Promise.all([recovering, coordinator.close()]);
  assert.equal(await workspace().isDirty(), false);
  assert.match(await memory.read(main, await note()), /4567/);
});

test("the editor's environment drops TMPDIR and passes Node options under VS Code's names", () => {
  const environment = editorEnvironment({
    PATH: '/bin',
    TMPDIR: '/scratch',
    NODE_OPTIONS: '--import tsx',
  });
  assert.equal(environment.TMPDIR, undefined);
  assert.equal(environment.VSCODE_NODE_OPTIONS, '--import tsx');
  assert.equal(environment.PATH, '/bin');
});

test('editing a previously committed symlink never opens its external target', async () => {
  let edits = 0;
  const {
    coordinator,
    root,
    project,
    workspace,
    memory: shared,
  } = await fixture(async () => {
    edits++;
  });
  try {
    const memory = workspace();
    await memory.ensureWorktree();
    const scope = await memory.scope(project);
    const target = join(root, 'external.md');
    const note = join(memory.root, scope.project, 'linked.md');
    await writeFile(target, 'External content.');
    await symlink(target, note);
    // Memory's git commits without the checks a workspace commit makes
    await shared.git(memory.root, ['add', '--all']);
    await shared.git(memory.root, ['commit', '-m', 'legacy symlink']);
    assert.equal(await memory.isDirty(), false);
    await assert.rejects(coordinator.editMemory(note), /regular file/);
    assert.equal(edits, 0);
    assert.equal(await readFile(target, 'utf8'), 'External content.');
    assert.equal(coordinator.snapshot.phase, 'idle');
  } finally {
    await coordinator.close();
  }
});

test('memory edit and restore notices resolve their note against the memory worktree', async () => {
  const { coordinator, memory, workspace, note } = await fixture(
    async (path) => {
      await writeFile(path, 'Use port 9001.');
    },
  );
  try {
    await coordinator.editMemory();
    const revision = await memory.resolve(main);
    await coordinator.restoreMemory(await note(), revision);
    assert.deepEqual(
      coordinator.snapshot.items
        .filter((item) => item.kind === 'notice')
        .map(({ text, cwd }) => [text, cwd]),
      [
        [`Memory edit: ${await note()}`, workspace().root],
        [
          `Memory restore: ${await note()} at ${revision.slice(0, 8)}`,
          workspace().root,
        ],
      ],
    );
  } finally {
    await coordinator.close();
  }
});

test('memory notices quote a note name on one line with its brackets escaped', async () => {
  const { coordinator, memory } = await fixture(async (path) => {
    await writeFile(path, 'Use port 9001.');
  });
  try {
    const name = 'global/a\n[b].md';
    await coordinator.editMemory(name);
    const revision = await memory.resolve(main);
    await coordinator.restoreMemory(name, revision);
    assert.deepEqual(
      coordinator.snapshot.items
        .filter((item) => item.kind === 'notice')
        .map(({ text }) => text),
      [
        'Memory edit: global/a\\[b\\].md',
        `Memory restore: global/a\\[b\\].md at ${revision.slice(0, 8)}`,
      ],
    );
  } finally {
    await coordinator.close();
  }
});

for (const action of ['interrupt', 'close'] as const) {
  test(
    `${action} cancels an open memory editor and preserves pending-write provenance`,
    { timeout: 5000 },
    async (t) => {
      const opened = Promise.withResolvers<void>();
      const { coordinator, store, memory, root, project, a, workspace, note } =
        await fixture(async (path, signal) => {
          await writeFile(path, 'Pending manual preference.');
          const stopped = new Promise<void>((_, reject) =>
            signal.addEventListener(
              'abort',
              () =>
                reject(new DOMException('Editing interrupted', 'AbortError')),
              { once: true },
            ),
          );
          opened.resolve();
          await stopped;
        });
      t.onTestFinished(() => coordinator.close());
      const editing = assert.doesNotReject(coordinator.editMemory());
      await opened.promise;
      await Promise.all([coordinator[action](), editing]);
      assert.equal(coordinator.snapshot.error, undefined);
      assert.equal(await workspace().isDirty(), true);
      if (action === 'interrupt')
        assert.equal(coordinator.snapshot.phase, 'recovery');
      await coordinator.close();
      const id = coordinator.snapshot.conversation!.id;
      const recovered = new Coordinator(store, memory, [
        { adapter: a, executable: 'a' },
      ]);
      try {
        const origin = (await readRecord(root, id)).activity;
        assert.ok(origin);
        assert.equal(origin.kind, 'memory-edit');
        await recovered.initialize(project, { continue: true });
        assert.equal(recovered.snapshot.conversation!.id, id);
        assert.equal(recovered.snapshot.phase, 'recovery');
        assert.equal(recovered.snapshot.error, undefined);
        await recovered.recoverMemory('accept');
        const [latest] = await memory.history(main, await note());
        assert.equal(
          (
            await memory.git(memory.root, [
              'log',
              '-1',
              '--format=%B',
              latest!.revision,
            ])
          ).trimEnd(),
          `chore(memory): recover manual changes\n\nconversation: ${id}\nturn: ${origin.id}`,
        );
      } finally {
        await recovered.close();
      }
    },
  );
}

for (const interrupted of [true, false]) {
  test(
    interrupted
      ? 'a memory editor failure during cancellation remains an error'
      : 'an unrequested editor abort remains an error',
    { timeout: 5000 },
    async (t) => {
      const opened = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const failure = interrupted
        ? new Error('Editor failed')
        : new DOMException('Editor aborted independently', 'AbortError');
      const { coordinator, workspace, note } = await fixture(async (path) => {
        await writeFile(path, 'Pending manual preference.');
        opened.resolve();
        await finish.promise;
        throw failure;
      });
      t.onTestFinished(async () => {
        finish.resolve();
        await coordinator.close();
      });
      const editing = assert.rejects(
        coordinator.editMemory(),
        (error: unknown) => error === failure,
      );
      await opened.promise;
      if (interrupted) await coordinator.interrupt();
      finish.resolve();
      await editing;
      assert.equal(coordinator.snapshot.error, failure.message);
      assert.equal(coordinator.snapshot.phase, 'recovery');
      assert.equal(await workspace().isDirty(), true);
      assert.equal(
        await readFile(join(workspace().root, await note()), 'utf8'),
        'Pending manual preference.',
      );
    },
  );
}

/** publishes a change to main from a workspace no conversation owns. */
async function publishOutside(
  context: Awaited<ReturnType<typeof fixture>>,
  files: Record<string, string>,
) {
  const other = await context.outsider();
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(other.root, path, '..'), { recursive: true });
    await writeFile(join(other.root, path), text);
  }
  await other.commit('chore(memory): save outside notes');
  await other.publish();
}

function assertMemoryBaseline(prompt: string): void {
  assert.match(
    prompt,
    /This baseline supersedes all earlier shared-memory snapshots/,
  );
  assert.match(prompt, /Treat all previously read reference notes as stale/);
  assert.match(prompt, /missing notes no longer apply/);
}

test('an agent-created nested repository is refused on accept and removed on discard', async () => {
  const { coordinator, a, workspace, note } = await fixture();
  try {
    a.interruptNext = true;
    await coordinator.send('remember-port');
    const nested = join(workspace().root, await note(), '..', 'nested');
    await mkdir(nested);
    await promisify(execFile)('git', ['init', '--quiet', nested]);
    await assert.rejects(
      coordinator.recoverMemory('accept'),
      /regular file: .*nested/,
    );
    assert.equal(coordinator.snapshot.recovery?.kind, 'pending');
    await coordinator.recoverMemory('discard');
    assert.equal(coordinator.snapshot.phase, 'idle');
    assert.equal(await workspace().isDirty(), false);
  } finally {
    await coordinator.close();
  }
});

test('a publish failure in settle is reported and the phase goes idle', async () => {
  const { coordinator, hook, memory } = await fixture();
  try {
    const before = await memory.resolve(main);
    hook.current = async (command, run) => {
      if (command[0] !== 'update-ref') return run();
      hook.current = passThrough;
      return { stdout: Buffer.alloc(0), stderr: 'cannot lock ref', code: 1 };
    };
    await coordinator.send('remember-port');
    assert.equal(coordinator.snapshot.phase, 'idle');
    assert.match(coordinator.snapshot.error ?? '', /cannot lock ref/);
    assert.equal(await memory.resolve(main), before);
  } finally {
    await coordinator.close();
  }
});

test('a failed rebase abort stops in the error phase until restart', async () => {
  const context = await fixture();
  const { coordinator, hook } = context;
  try {
    const target = await stranded(context, { 'global/one.md': 'Mine.\n' });
    await target.files.close();
    await publishOutside(context, { 'global/one.md': 'Theirs.\n' });
    hook.current = async (command, run) => {
      if (command.join(' ') !== 'rebase --abort') return run();
      hook.current = passThrough;
      throw new Error('abort failed');
    };
    await assert.rejects(
      coordinator.selectConversation(target.id),
      /Restart Witch/,
    );
    assert.equal(coordinator.snapshot.phase, 'error');
    await assert.rejects(coordinator.recoverMemory('accept'), /Restart Witch/);
  } finally {
    await coordinator.close().catch(() => {});
  }
});

for (const decision of ['keep', 'discard'] as const) {
  test(`recovery shows the blocked commit after a later local revert (${decision})`, async () => {
    const f = await fixture();
    try {
      await publishOutside(f, { 'global/n.md': 'one\n' });
      const target = await stranded(f, { 'global/n.md': 'a-change\n' });
      try {
        await writeFile(join(target.memory.root, 'global/n.md'), 'one\n');
        await target.memory.commit('revert');
      } finally {
        await target.files.close();
      }
      await publishOutside(f, { 'global/n.md': 'b-change\n' });
      await f.coordinator.selectConversation(target.id);
      const recovery = f.coordinator.snapshot.recovery;
      assert.equal(recovery?.kind, 'conflict');
      assert.deepEqual(recovery.paths, ['global/n.md']);
      assert.match(recovery.diff, /^-one$/m);
      assert.match(recovery.diff, /^\+a-change$/m);
      await f.coordinator.recoverMemory(decision);
      assert.equal(f.coordinator.snapshot.phase, 'idle');
      assert.equal(await f.memory.read(main, 'global/n.md'), 'b-change\n');
    } finally {
      await f.coordinator.close();
    }
  });
}

test('keep mine publishes with the attribution of the conversation that kept its side', async () => {
  const context = await fixture();
  const { coordinator, a, memory, notes } = context;
  const gate = new TurnGate();
  try {
    await coordinator.send('Start');
    a.gate = gate;
    const sending = coordinator.send('remember:mine');
    await within(gate.entered, 2000, 'the gated turn');
    await publishOutside(context, { [await notes()]: 'theirs' });
    gate.open();
    await sending;
    assert.equal(coordinator.snapshot.recovery?.kind, 'conflict');
    await coordinator.recoverMemory('keep');
    assert.equal(coordinator.snapshot.phase, 'idle');
    assert.equal(await memory.read(main, await notes()), 'mine');
    assert.match(
      await memory.git(memory.root, ['log', '-1', '--format=%b', main]),
      new RegExp(`conversation: ${coordinator.snapshot.conversation!.id}`),
    );
  } finally {
    gate.open();
    await coordinator.close();
  }
});

test('two coordinators in two directories run turns at once and both publish', async () => {
  const context = await fixture();
  const { root, store, memory } = context;
  const other = join(root, 'other');
  await mkdir(other);
  const agents = [context.a, new FixtureAgent('a')];
  const gates = agents.map((agent) => (agent.gate = new TurnGate()));
  const coordinators = [
    context.coordinator,
    new Coordinator(store, memory, [{ adapter: agents[1]!, executable: 'a' }]),
  ];
  try {
    await coordinators[1]!.initialize(other);
    const sends = coordinators.map((coordinator, index) =>
      coordinator.send(`remember:note-${index}`),
    );
    await within(
      Promise.all(gates.map((gate) => gate.entered)),
      5000,
      'both turns',
    );
    for (const coordinator of coordinators)
      assert.equal(coordinator.snapshot.phase, 'running');
    for (const gate of gates) gate.open();
    await Promise.all(sends);
    for (const [index, cwd] of [context.project, other].entries()) {
      const path = `${(await memory.scopePaths(cwd)).project}/notes.md`;
      assert.equal(await memory.read(main, path), `note-${index}`);
      assert.match(
        await memory.git(memory.root, [
          'log',
          '-1',
          '--format=%b',
          main,
          '--',
          path,
        ]),
        new RegExp(
          `conversation: ${coordinators[index]!.snapshot.conversation!.id}`,
        ),
      );
    }
  } finally {
    for (const gate of gates) gate.open();
    for (const coordinator of coordinators) await coordinator.close();
  }
});

test('discard mine after a conflict between two coordinators keeps the other side', async () => {
  const context = await fixture();
  const { store, memory, project, notes } = context;
  const agents = [context.a, new FixtureAgent('a')];
  const gates = agents.map(() => new TurnGate());
  const coordinators = [
    context.coordinator,
    new Coordinator(store, memory, [{ adapter: agents[1]!, executable: 'a' }]),
  ];
  try {
    await coordinators[1]!.initialize(project);
    const note = await context.note();
    await publishOutside(context, {
      'global/MEMORY.md': 'Global preference 17.',
      [note]: 'Project preference 29.',
    });
    await Promise.all(
      coordinators.map((coordinator) => coordinator.send('Initial task')),
    );
    for (const [index, agent] of agents.entries()) agent.gate = gates[index];
    const sends = coordinators.map((coordinator, index) =>
      coordinator.send(`remember:text-${index}`),
    );
    await within(
      Promise.all(gates.map((gate) => gate.entered)),
      5000,
      'both turns',
    );
    const second = coordinators[1]!;
    const losing = context.workspace(second.snapshot.conversation!.id);
    for (const [path, text] of Object.entries({
      'global/MEMORY.md': 'Rejected global preference 71.',
      [note]: 'Rejected project preference 83.',
      'global/discarded.md': 'Rejected new note 109.',
    }))
      await writeFile(join(losing.root, path), text);
    gates[0]!.open();
    await sends[0];
    gates[1]!.open();
    await sends[1];
    assert.equal(second.snapshot.recovery?.kind, 'conflict');
    await second.recoverMemory('discard');
    assert.equal(second.snapshot.phase, 'idle');
    assert.equal(await memory.read(main, await notes()), 'text-0');
    assert.equal(
      await context.workspace(second.snapshot.conversation!.id).revision(),
      await memory.resolve(main),
    );
    await assert.rejects(readFile(join(losing.root, 'global/discarded.md')), {
      code: 'ENOENT',
    });
    await second.send('Continue after discard');
    const prompt = agents[1]!.inputs.at(-1)!.context!;
    assertMemoryBaseline(prompt);
    assert.match(prompt, /Global preference 17/);
    assert.match(prompt, /Project preference 29/);
    assert.doesNotMatch(prompt, /Rejected/);
  } finally {
    for (const gate of gates) gate.open();
    for (const coordinator of coordinators) await coordinator.close();
  }
});

test('discard after an activated handoff corrects both native sessions', async () => {
  const f = await fixture();
  try {
    await publishOutside(f, {
      'global/MEMORY.md': 'Global preference 17.',
      [await f.note()]: 'Project preference 29.',
      'global/reference.md': 'Reference detail 53.',
    });
    await f.coordinator.send('Initial task');
    const source = f.a.sessions.at(-1)!;
    const sourceId = source.session.info.id;
    const send = source.session.send.bind(source.session);
    const writing = vi
      .spyOn(source.session, 'send')
      .mockImplementation(async (...args: Parameters<typeof send>) => {
        await writeFile(
          join(f.workspace().root, 'global/MEMORY.md'),
          'Rejected global preference 71.',
        );
        await writeFile(
          join(f.workspace().root, 'global/reference.md'),
          'Rejected reference detail 97.',
        );
        await publishOutside(f, {
          'global/reference.md': 'Winning reference detail 127.',
        });
        return send(...args);
      });
    await assert.rejects(
      f.coordinator.selectModel({ agent: 'b', id: 'b-model' }),
      /memory changes conflict/,
    );
    writing.mockRestore();
    assert.equal(f.coordinator.snapshot.conversation?.agent, 'b');
    assert.equal(f.coordinator.snapshot.recovery?.kind, 'conflict');
    assert.equal(f.b.inputs.length, 0);
    const destinationId = f.b.sessions.at(-1)!.session.info.id;
    await f.coordinator.recoverMemory('discard');
    await f.coordinator.send('Continue after discard');
    assert.equal(f.b.inputs.at(-1)!.session, destinationId);
    const destinationPrompt = f.b.inputs.at(-1)!.context!;
    await f.coordinator.selectModel({ agent: 'a', id: 'a-model' });
    assert.equal(f.a.inputs.at(-1)!.session, sourceId);
    for (const prompt of [destinationPrompt, f.a.inputs.at(-1)!.context!]) {
      assertMemoryBaseline(prompt);
      assert.match(prompt, /Global preference 17/);
      assert.match(prompt, /Project preference 29/);
      assert.doesNotMatch(prompt, /Rejected/);
    }
  } finally {
    vi.restoreAllMocks();
    await f.coordinator.close();
  }
});

for (const kind of ['pending', 'conflict'] as const) {
  test(`a failed ${kind} discard preserves memory delivery until retry`, async () => {
    const f = await fixture();
    const gate = new TurnGate();
    try {
      await publishOutside(f, {
        'global/MEMORY.md': 'Global preference 17.',
        [await f.note()]: 'Project preference 29.',
      });
      await f.coordinator.send('Initial task');
      const id = f.coordinator.snapshot.conversation!.id;
      f.a.failNext = kind === 'pending';
      f.a.gate = gate;
      const sending = f.coordinator.send('remember:mine');
      await within(gate.entered, 3000, 'the writing turn');
      if (kind === 'conflict')
        await publishOutside(f, { [await f.notes()]: 'theirs' });
      gate.open();
      await sending;
      assert.equal(f.coordinator.snapshot.recovery?.kind, kind);
      const before = (await readRecord(f.root, id)).sessions;
      f.hook.current = (command, run) => {
        if (command[0] === 'reset') throw new Error('Discard reset failed');
        return run();
      };
      await assert.rejects(
        f.coordinator.recoverMemory('discard'),
        /Discard reset failed/,
      );
      assert.equal(f.coordinator.snapshot.recovery?.kind, kind);
      assert.deepEqual((await readRecord(f.root, id)).sessions, before);
      f.hook.current = passThrough;
      await f.coordinator.recoverMemory('discard');
      await f.coordinator.send('Continue after retry');
      const prompt = f.a.inputs.at(-1)!.context!;
      assertMemoryBaseline(prompt);
      assert.match(prompt, /Global preference 17/);
      assert.match(prompt, /Project preference 29/);
    } finally {
      f.hook.current = passThrough;
      gate.open();
      await f.coordinator.close();
    }
  });
}

test('the launch sweep publishes what it can and reports the rest in one message', async () => {
  const context = await fixture();
  const { root, memory, store } = context;
  await context.coordinator.close();
  const conflict = await stranded(
    context,
    { 'global/one.md': 'Mine.\n' },
    join(root, 'deleted-project'),
  );
  await conflict.files.close();
  await publishOutside(context, { 'global/one.md': 'Theirs.\n' });
  const unpublished = await stranded(
    context,
    { 'global/two.md': 'Two.' },
    join(root, 'deleted-project'),
  );
  await unpublished.files.close();
  const dirty = await stranded(context, {});
  dirty.files.record.activity = activity();
  await dirty.files.save(dirty.files.record);
  await dirty.files.close();
  await writeFile(join(dirty.memory.root, 'global', 'three.md'), 'Three.');
  const stateless = randomUUID();
  const orphan = await context.outsider(stateless);
  await writeFile(join(orphan.root, 'global', 'four.md'), 'Four.');
  await orphan.commit('chore(memory): save outside notes');
  const fresh = join(root, 'fresh');
  await mkdir(fresh);
  for (const launch of [1, 2]) {
    const coordinator = new Coordinator(store, memory, [
      { adapter: context.a, executable: 'a' },
    ]);
    const reports: (string | undefined)[] = [];
    coordinator.subscribe(() => {
      if (coordinator.snapshot.phase !== 'starting')
        reports.push(coordinator.snapshot.error);
    });
    try {
      await coordinator.initialize(fresh);
      if (launch === 1)
        assert.equal(await memory.read(main, 'global/two.md'), 'Two.');
      assert.ok(reports.length > 0);
      for (const report of reports) {
        assert.match(report ?? '', /Open each from \/sessions/);
        assert.match(
          report ?? '',
          new RegExp(
            `Title ${conflict.id} in .*deleted-project \\(recover this directory first\\): memory conflicts`,
          ),
        );
        assert.match(
          report ?? '',
          new RegExp(`Title ${dirty.id} in [^(\n]*: unfinished`),
        );
        assert.doesNotMatch(
          report ?? '',
          new RegExp(`Title ${unpublished.id}`),
        );
        assert.match(
          report ?? '',
          new RegExp(`conversations/${stateless} has unpublished memory`),
        );
      }
    } finally {
      await coordinator.close();
    }
  }
});

test('a sweep failure after the claim is reported and releases the claim', async () => {
  const context = await fixture();
  const { root, store, memory } = context;
  await context.coordinator.close();
  const broken = await stranded(context, { 'global/x.md': 'X.' });
  broken.files.record.activity = activity();
  await broken.files.save(broken.files.record);
  await broken.files.close();
  await writeFile(join(broken.memory.root, '.git'), 'not a worktree\n');
  const fresh = join(root, 'fresh');
  await mkdir(fresh);
  const coordinator = new Coordinator(store, memory, [
    { adapter: context.a, executable: 'a' },
  ]);
  try {
    await coordinator.initialize(fresh);
    assert.match(
      coordinator.snapshot.error ?? '',
      new RegExp(`Title ${broken.id}`),
    );
    await (await store.claim(broken.id)).close();
  } finally {
    await coordinator.close();
  }
});

test('a switch target with a broken worktree leaves the current conversation untouched', async () => {
  const context = await fixture();
  const { coordinator, store, a } = context;
  try {
    await coordinator.send('Start');
    const current = coordinator.snapshot.conversation!.id;
    const target = await stranded(context, { 'global/x.md': 'X.' });
    await target.files.close();
    await writeFile(join(target.memory.root, '.git'), 'not a worktree\n');
    await assert.rejects(coordinator.selectConversation(target.id));
    assert.equal(coordinator.snapshot.conversation!.id, current);
    assert.equal(a.sessions.at(-1)!.session.closed, false);
    await assert.rejects(
      store.claim(current),
      /open in another Witch instance/,
    );
  } finally {
    await coordinator.close();
  }
});

test('opening a conversation aborts its stopped rebase before classifying it', async () => {
  const context = await fixture();
  const { coordinator } = context;
  try {
    const target = await stranded(context, { 'global/one.md': 'Mine.\n' });
    await target.files.close();
    await publishOutside(context, { 'global/one.md': 'Theirs.\n' });
    await promisify(execFile)(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'rebase', main],
      { cwd: target.memory.root },
    ).catch(() => {});
    assert.equal(await target.memory.rebaseStopped(), true);
    await coordinator.selectConversation(target.id);
    assert.equal(await target.memory.rebaseStopped(), false);
    assert.equal(coordinator.snapshot.recovery?.kind, 'conflict');
  } finally {
    await coordinator.close();
  }
});

test('a native session that replaces the stored one gets the memory snapshot again', async () => {
  const { coordinator, a } = await fixture();
  try {
    await coordinator.send('remember-port');
    await coordinator.send('Again');
    const previousSession = a.inputs.at(-1)!.session;
    // the native agent starts a fresh session instead of resuming
    a.beforeConnect = async (options) => {
      options.resume = undefined;
    };
    await a.sessions.at(-1)!.session.close();
    await coordinator.send('Next');
    assert.match(a.inputs.at(-1)!.context!, /Use port 4567/);
    assert.match(a.inputs.at(-1)!.context!, /You are running inside Witch/);
    assert.notEqual(a.inputs.at(-1)!.session, previousSession);
  } finally {
    await coordinator.close();
  }
});

test('the memory view reads accepted memory, and links into the worktree only while it holds that revision', async () => {
  const { coordinator, memory, workspace, notes, outsider } = await fixture();
  try {
    const other = await outsider();
    await writeFile(join(other.root, await notes()), 'Published elsewhere.');
    await other.commit('save elsewhere');
    await other.publish();
    const behind = await coordinator.memoryView();
    assert.equal(behind.revision, await memory.resolve(main));
    assert.equal(behind.root, undefined);
    await coordinator.send('Next');
    assert.equal((await coordinator.memoryView()).root, workspace().root);
  } finally {
    await coordinator.close();
  }
});
