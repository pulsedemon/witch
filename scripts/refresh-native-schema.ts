import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateCodexSchema } from '../src/agents/codex/schema.js';
import { nativeExecutable } from '../src/agents/executable.js';

const executable = nativeExecutable('codex');
assert.ok(executable, 'Run pnpm install first: the pinned Codex is missing');
const directory = await mkdtemp(join(tmpdir(), 'witch-codex-schema-'));

try {
  await copyFile(
    await generateCodexSchema(executable, directory),
    fileURLToPath(
      new URL(
        '../test/fixtures/native/codex/protocol.schema.json',
        import.meta.url,
      ),
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
