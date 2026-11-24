import assert from 'node:assert/strict';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { inspectArtifact } from '../../../src/agents/native-check/artifact.js';
import { scratch } from '../../fixtures/scratch.js';

test('an inspected artifact parses its version and digests its content', async () => {
  const directory = await scratch('witch-artifact-');
  const executable = join(directory, 'codex');
  await writeFile(executable, "#!/bin/sh\nprintf 'codex-cli 1.2.3\\n'\n");
  await chmod(executable, 0o755);
  const artifact = await inspectArtifact('codex', executable);
  assert.equal(artifact.version, '1.2.3');
  assert.equal(artifact.runtime, 'codex');

  // `shasum -a 256` of the script above
  assert.equal(
    artifact.digest,
    'b6810f59909f50aa3d57f2652e09b2e7597f8591af396ba930a8336ff34ea656',
  );
});
