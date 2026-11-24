import assert from 'node:assert/strict';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { inspectArtifact } from '../../../src/agents/native-check/artifact.js';
import { scratch } from '../../fixtures/scratch.js';

test('an inspected artifact parses its version and digests its content', async () => {
  const directory = await scratch('witch-artifact-');
  const executable = join(directory, 'codex');

  const write = async (body: string) => {
    await writeFile(executable, `#!/bin/sh\nprintf '${body}\\n'\n`);
    await chmod(executable, 0o755);

    return inspectArtifact('codex', executable);
  };

  const first = await write('codex-cli 1.2.3');
  assert.equal(first.version, '1.2.3');
  assert.equal(first.runtime, 'codex');
  const changed = await write('codex-cli 1.2.3 ');
  assert.equal(changed.version, '1.2.3');
  assert.notEqual(changed.digest, first.digest);
});
