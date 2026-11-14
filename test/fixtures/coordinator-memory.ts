import assert from 'node:assert/strict';

import { mkdir, writeFile } from 'node:fs/promises';

import { join } from 'node:path';

import type { fixture } from './coordinator.js';

/** publishes a change to main from a workspace no conversation owns. */
export async function publishOutside(
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

export function assertMemoryBaseline(prompt: string): void {
  assert.match(
    prompt,
    /This baseline supersedes all earlier shared-memory snapshots/,
  );

  assert.match(prompt, /Treat all previously read reference notes as stale/);

  assert.match(prompt, /missing notes no longer apply/);
}
