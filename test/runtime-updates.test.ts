import assert from 'node:assert/strict';
import {
  access,
  chmod,
  mkdir,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'vitest';
import { CodexAdapter } from '../src/agents/codex.js';
import {
  checkRuntimeUpdate,
  earlierArtifact,
  inspectRuntime,
} from '../src/agents/runtime-updates.js';
import type { RuntimeInstallation } from '../src/agents/runtime-updates.js';
import { scratch } from './fixtures/scratch.js';

const installation: RuntimeInstallation = {
  runtime: 'claude',
  launcher: '/native/bin/claude',
  executable: '/native/versions/2.1.9',
  version: '2.1.9',
  digest: 'original',
  root: '/native',
  channel: 'stable',
  automatic: false,
};

test('release checks use the selected channel and compare numeric versions', async () => {
  let requested: string | undefined;

  const result = await checkRuntimeUpdate(
    installation,
    new AbortController().signal,
    async (url) => {
      requested = String(url);

      return new Response('2.1.10\n');
    },
  );

  assert.equal(
    requested,
    'https://downloads.claude.ai/claude-code-releases/stable',
  );

  assert.equal(result.source, requested);

  assert.equal(result.target, '2.1.10');

  assert.equal(result.available, true);

  assert.equal(result.blocked, undefined);
});

test('native version limits prevent offering an otherwise available update', async () => {
  const result = await checkRuntimeUpdate(
    { ...installation, maximum: '2.1.10' },
    new AbortController().signal,
    async () => new Response('2.1.11'),
  );

  assert.equal(result.available, true);

  assert.equal(result.blocked, 'Native maximum version is 2.1.10.');
});

test('a lower channel release does not become a downgrade', async () => {
  const result = await checkRuntimeUpdate(
    installation,
    new AbortController().signal,
    async () => new Response('2.1.8'),
  );

  assert.equal(result.available, false);
});

test('failed metadata does not report a runtime as current', async () => {
  await assert.rejects(
    checkRuntimeUpdate(
      installation,
      new AbortController().signal,
      async () => new Response('unavailable', { status: 503 }),
    ),
    /HTTP 503/,
  );
});

test('Codex checks parse the native release source and preserve unsupported-installation diagnostics', async () => {
  const result = await checkRuntimeUpdate(
    { ...installation, runtime: 'codex', blocked: 'Use the native installer.' },
    new AbortController().signal,
    async (url) => {
      assert.equal(url, 'https://releases.openai.com/codex/channels/latest');

      return Response.json({ tag_name: 'rust-v3.0.0' });
    },
  );

  assert.equal(result.target, '3.0.0');

  assert.equal(result.available, true);

  assert.equal(result.blocked, 'Use the native installer.');
});

test('inventory follows the selected launcher and changes artifact identity after an external update', async () => {
  const root = await scratch('witch-runtime-inventory-');

  const previous = process.env.CODEX_HOME;

  process.env.CODEX_HOME = root;

  try {
    const releases = join(root, 'packages', 'standalone', 'releases');

    const launcher = join(root, 'codex');

    const executables: string[] = [];

    for (const version of ['1.2.3', '1.2.4']) {
      const release = join(releases, `${version}-aarch64-apple-darwin`);

      const executable = join(release, 'bin', 'codex');

      await mkdir(dirname(executable), { recursive: true });

      await writeFile(
        join(release, 'codex-package.json'),
        JSON.stringify({ version }),
      );

      await writeFile(
        executable,
        `#!/bin/sh\nprintf 'codex-cli ${version}\\n'\n`,
      );

      await chmod(executable, 0o755);

      executables.push(executable);
    }

    await symlink(executables[0]!, launcher);

    const registration = { adapter: new CodexAdapter(), executable: launcher };

    const before = await inspectRuntime(registration);

    await unlink(launcher);

    await symlink(executables[1]!, launcher);

    const after = await inspectRuntime(registration);

    assert.equal(before.version, '1.2.3');

    assert.equal(after.version, '1.2.4');

    assert.equal(after.executable, executables[1]);

    assert.equal(after.root, before.root);

    assert.notEqual(after.digest, before.digest);

    assert.equal(after.blocked, undefined);

    await writeFile(
      join(after.root, 'auto-update-version'),
      '1.2.4-aarch64-apple-darwin',
    );

    const automatic = await inspectRuntime(registration);

    assert.equal(automatic.automatic, true);

    assert.match(automatic.blocked!, /would disable them/);

    process.env.CODEX_HOME = join(root, 'another-home');

    const foreign = await inspectRuntime(registration);

    assert.equal(foreign.root, after.root);

    assert.equal(foreign.executable, after.executable);

    assert.match(foreign.blocked!, /native Codex installer/);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});

test('an unsupported PATH executable is diagnosed without running it or selecting an installation to replace', async () => {
  const root = await scratch('witch-runtime-custom-');

  const executable = join(root, 'codex');

  await writeFile(
    executable,
    '#!/bin/sh\nprintf ran > "$0.ran"\nprintf "codex-cli 1.2.3\\n"\n',
  );

  await chmod(executable, 0o755);

  await assert.rejects(
    inspectRuntime({ adapter: new CodexAdapter(), executable }),
    (error) => {
      assert.ok(
        error instanceof Error &&
          error.message.includes(executable) &&
          error.message.includes('native codex installer'),
      );

      return true;
    },
  );

  await assert.rejects(access(`${executable}.ran`), { code: 'ENOENT' });
});

test('the earlier artifact is the newest older sibling in either native layout', async () => {
  const root = await scratch('witch-runtime-earlier-');

  const releases = join(root, 'standalone', 'releases');

  for (const name of [
    '1.2.3-aarch64-apple-darwin',
    '1.9.0-aarch64-apple-darwin',
    '1.9.5-x86_64-apple-darwin',
    '1.10.0-aarch64-apple-darwin',
    '2.0.0-aarch64-apple-darwin',
    'notes',
  ])
    await mkdir(join(releases, name, 'bin'), { recursive: true });

  const codex = (version: string): RuntimeInstallation => ({
    ...installation,
    runtime: 'codex',
    root: join(root, 'standalone'),
    executable: join(
      releases,
      `${version}-aarch64-apple-darwin`,
      'bin',
      'codex',
    ),
    version,
  });

  assert.deepEqual(await earlierArtifact(codex('1.10.0')), {
    version: '1.9.0',
    executable: join(releases, '1.9.0-aarch64-apple-darwin', 'bin', 'codex'),
  });

  assert.equal(await earlierArtifact(codex('1.2.3')), undefined);

  const unversioned = join(releases, 'notes', 'bin', 'codex');

  await assert.rejects(
    earlierArtifact({ ...codex('1.10.0'), executable: unversioned }),
    /Unrecognized Codex release directory notes for version 1\.10\.0/,
  );

  // outside a native releases directory the name promises nothing
  assert.equal(
    await earlierArtifact({
      ...codex('1.10.0'),
      root: join(releases, 'notes'),
      executable: unversioned,
    }),
    undefined,
  );

  const versions = join(root, 'claude', 'versions');

  await mkdir(versions, { recursive: true });

  for (const name of [
    '2.1.296',
    '2.1.299',
    '2.1.300.partial',
    '2.1.322',
    '2.1.400',
    '.DS_Store',
  ])
    await writeFile(join(versions, name), '');

  const claude = (version: string): RuntimeInstallation => ({
    ...installation,
    root: join(root, 'claude'),
    executable: join(versions, version),
    version,
  });

  assert.deepEqual(await earlierArtifact(claude('2.1.322')), {
    version: '2.1.299',
    executable: join(versions, '2.1.299'),
  });

  assert.equal(await earlierArtifact(claude('2.1.296')), undefined);

  assert.equal(
    await earlierArtifact({ ...claude('2.1.322'), root: join(root, 'gone') }),
    undefined,
  );
});
