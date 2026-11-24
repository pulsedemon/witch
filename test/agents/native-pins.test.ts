import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { test } from 'vitest';
import { generateCodexSchema } from '../../src/agents/codex/schema.js';
import { nativeExecutable } from '../../src/agents/executable.js';
import { scratch } from '../fixtures/scratch.js';

const execute = promisify(execFile);

const manifest = async (name: string) =>
  JSON.parse(
    await readFile(
      new URL(`../../node_modules/${name}/package.json`, import.meta.url),
      'utf8',
    ),
  ) as {
    version: string;
    claudeCodeVersion?: string;
  };

test('the pinned Claude Code binary is the version its SDK declares', async () => {
  const executable = nativeExecutable('claude', { environment: {} });

  assert.ok(
    executable,
    'the pinned SDK has no Claude Code binary for this platform',
  );

  const { stdout } = await execute(executable, ['--version']);

  const { claudeCodeVersion } = await manifest(
    '@anthropic-ai/claude-agent-sdk',
  );

  assert.equal(stdout.trim().split(' ')[0], claudeCodeVersion);
});

test('the pinned Codex binary is the version of its package', async () => {
  const executable = nativeExecutable('codex', { environment: {} });

  assert.ok(
    executable,
    'the pinned Codex package has no binary for this platform',
  );

  const { stdout } = await execute(executable, ['--version']);
  const { version } = await manifest('@openai/codex');
  assert.equal(stdout.trim(), `codex-cli ${version}`);
});

test('the pinned Codex protocol schema is the committed one', async () => {
  const executable = nativeExecutable('codex', { environment: {} });

  assert.ok(
    executable,
    'the pinned Codex package has no binary for this platform',
  );

  const generated = await readFile(
    await generateCodexSchema(executable, await scratch('witch-codex-schema-')),
  );

  const committed = await readFile(
    new URL('../fixtures/native/codex/protocol.schema.json', import.meta.url),
  );

  assert.ok(
    generated.equals(committed),
    'The pinned Codex protocol schema changed. Run pnpm native:schema and review the diff against the README interface table.',
  );
});
