import assert from 'node:assert/strict';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { test } from 'vitest';
import { installedAgents } from '../../src/agents/registry.js';
import { scratch } from '../fixtures/scratch.js';

test('an agent is installed when a later PATH directory holds an executable of its name, and a file without execute permission or a directory of that name does not count', async () => {
  const empty = await scratch('witch-registry-');
  await mkdir(join(empty, 'codex'));
  const bin = await scratch('witch-registry-');
  await writeFile(join(bin, 'codex'), '');
  await chmod(join(bin, 'codex'), 0o755);
  await writeFile(join(bin, 'claude'), '');
  const path = process.env.PATH;
  process.env.PATH = [empty, bin].join(delimiter);

  try {
    assert.deepEqual(
      (await installedAgents()).map(({ adapter, executable }) => [
        adapter.id,
        executable,
      ]),
      [
        ['codex', join(bin, 'codex')],
        ['claude', undefined],
      ],
    );
  } finally {
    process.env.PATH = path;
  }
});
