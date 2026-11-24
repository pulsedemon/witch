import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { chmod, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { nativeExecutable } from '../../src/agents/executable.js';
import { nativeLaunch } from '../../src/agents/native-launch.js';
import { installedAgents } from '../../src/agents/registry.js';
import { scratch } from '../fixtures/scratch.js';

const platform = `${process.platform}-${process.arch}`;

/** a Witch root laid out as pnpm installs it: each package links into a store directory beside its platform package. */
async function pinnedRoot() {
  const root = await scratch('witch-pinned-');
  const store = join(root, 'store');

  const binary = async (path: string) => {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, '#!/bin/sh\n');
    await chmod(path, 0o755);
  };

  await mkdir(join(store, '@openai/codex'), { recursive: true });

  await binary(
    join(store, `@openai/codex-${platform}/vendor/triple/bin/codex`),
  );

  await mkdir(join(store, '@anthropic-ai/claude-agent-sdk'), {
    recursive: true,
  });

  await binary(
    join(store, `@anthropic-ai/claude-agent-sdk-${platform}/claude`),
  );

  await mkdir(join(root, 'node_modules/@openai'), { recursive: true });
  await mkdir(join(root, 'node_modules/@anthropic-ai'), { recursive: true });

  await symlink(
    join(store, '@openai/codex'),
    join(root, 'node_modules/@openai/codex'),
  );

  await symlink(
    join(store, '@anthropic-ai/claude-agent-sdk'),
    join(root, 'node_modules/@anthropic-ai/claude-agent-sdk'),
  );

  return { root, store };
}

test('a pinned runtime resolves through its package link, keeping the `..` that follows a refreshed link', async () => {
  const { root } = await pinnedRoot();

  assert.equal(
    nativeExecutable('codex', { environment: {}, root }),
    `${root}/node_modules/@openai/codex/../codex-${platform}/vendor/triple/bin/codex`,
  );

  assert.equal(
    nativeExecutable('claude', { environment: {}, root }),
    `${root}/node_modules/@anthropic-ai/claude-agent-sdk/../claude-agent-sdk-${platform}/claude`,
  );

  assert.equal(nativeExecutable('other', { environment: {}, root }), undefined);
});

test('a runtime whose platform package is missing is not installed', async () => {
  const root = await scratch('witch-pinned-');

  for (const name of ['@openai/codex', '@anthropic-ai/claude-agent-sdk']) {
    await mkdir(join(root, 'store', name), { recursive: true });
    await mkdir(join(root, 'node_modules', name, '..'), { recursive: true });
    await symlink(join(root, 'store', name), join(root, 'node_modules', name));
  }

  assert.equal(nativeExecutable('codex', { environment: {}, root }), undefined);

  assert.equal(
    nativeExecutable('claude', { environment: {}, root }),
    undefined,
  );
});

test('a set override wins without falling back to the pin, and counts only as an executable regular file', async () => {
  const { root } = await pinnedRoot();
  const fakes = await scratch('witch-override-');
  const fake = join(fakes, 'codex');
  await writeFile(fake, '#!/bin/sh\n');
  await chmod(fake, 0o755);
  const plain = join(fakes, 'plain');
  await writeFile(plain, '');
  await mkdir(join(fakes, 'directory'));

  const resolve = (override: string) =>
    nativeExecutable('codex', {
      environment: { WITCH_CODEX_EXECUTABLE: override },
      root,
    });

  assert.equal(resolve(fake), fake);
  assert.equal(resolve(plain), undefined);
  assert.equal(resolve(join(fakes, 'directory')), undefined);
  assert.equal(resolve(join(fakes, 'missing')), undefined);
});

test('a native launch starts the real path, since Codex started through the `..` fails its turns', async () => {
  const { root, store } = await pinnedRoot();
  const executable = nativeExecutable('codex', { environment: {}, root })!;
  let started: string | undefined;

  nativeLaunch(executable, (path) => {
    started = path;

    return { once: () => {} } as unknown as ChildProcess;
  });

  assert.equal(
    started,
    await realpath(
      join(store, `@openai/codex-${platform}/vendor/triple/bin/codex`),
    ),
  );
});

test('installed agents register the executables the overrides name', async () => {
  const fakes = await scratch('witch-registry-');

  for (const name of ['claude', 'codex']) {
    await writeFile(join(fakes, name), '#!/bin/sh\n');
    await chmod(join(fakes, name), 0o755);
  }

  const saved = {
    claude: process.env.WITCH_CLAUDE_EXECUTABLE,
    codex: process.env.WITCH_CODEX_EXECUTABLE,
  };

  process.env.WITCH_CLAUDE_EXECUTABLE = join(fakes, 'claude');
  process.env.WITCH_CODEX_EXECUTABLE = join(fakes, 'missing');

  try {
    assert.deepEqual(
      (await installedAgents()).map(({ adapter, executable }) => [
        adapter.id,
        executable,
      ]),
      [
        ['codex', undefined],
        ['claude', join(fakes, 'claude')],
      ],
    );
  } finally {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined)
        delete process.env[`WITCH_${name.toUpperCase()}_EXECUTABLE`];
      else process.env[`WITCH_${name.toUpperCase()}_EXECUTABLE`] = value;
  }
});
