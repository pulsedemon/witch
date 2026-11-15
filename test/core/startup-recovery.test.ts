import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { recoverConversations } from '../../src/core/startup-recovery.js';
import { activity, fixture, stranded } from '../fixtures/coordinator.js';
import { unreadable } from '../fixtures/unreadable.js';

test('the launch sweep says when it cannot look at a directory and still reports the other conversations', async (t) => {
  const context = await fixture();
  const { root, memory, store } = context;
  await context.coordinator.close();
  const blocked = join(root, 'blocked');
  await mkdir(blocked);

  const unfinished = async (cwd: string) => {
    const dirty = await stranded(context, {}, cwd);
    dirty.files.record.activity = activity();
    await dirty.files.save(dirty.files.record);
    await dirty.files.close();
    await writeFile(join(dirty.memory.root, 'global', 'left.md'), 'Left.');

    return dirty.id;
  };

  const hidden = await unfinished(blocked);
  const seen = await unfinished(context.project);
  unreadable(t, blocked);
  const report = (await recoverConversations(store, memory, undefined)) ?? '';

  assert.match(
    report,
    new RegExp(
      `Title ${hidden} in .*blocked \\(can't be checked: EACCES: permission denied, stat '.*blocked'\\): unfinished memory changes`,
    ),
  );

  assert.match(
    report,
    new RegExp(`Title ${seen} in [^(\n]*: unfinished memory changes`),
  );
});
