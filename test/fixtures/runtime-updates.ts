import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  realpath,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  artifactDigest,
  earlierArtifact,
} from '../../src/agents/runtime-updates.js';
import type {
  RuntimeInstallation,
  RuntimeUpdateCheck,
} from '../../src/agents/runtime-updates.js';
import {
  verificationProfile,
  requiredNativeChecks,
} from '../../src/agents/native-verification.js';
import { RuntimeUpdates } from '../../src/core/runtime-updates.js';
import type { NativeUpdateOperations } from '../../src/core/runtime-updates.js';
import { RuntimeUpdateStore } from '../../src/persistence/runtime-updates.js';
import { FixtureAgent } from './agent.js';
import { scratch } from './scratch.js';

export async function runtimeUpdateFixture(
  host?: ConstructorParameters<typeof RuntimeUpdates>[0],
  installed: '1.0.0' | '2.0.0' = '1.0.0',
) {
  const directory = await scratch('witch-native-update-');

  const root = join(directory, 'packages', 'standalone');

  const launcher = join(directory, 'codex');

  const artifacts = new Map<string, RuntimeInstallation>();

  for (const version of ['1.0.0', '2.0.0']) {
    const release = join(root, 'releases', `${version}-aarch64-apple-darwin`);

    const executable = join(release, 'bin', 'codex');

    await mkdir(dirname(executable), { recursive: true });

    await writeFile(
      executable,
      `#!/bin/sh\nprintf 'codex-cli ${version}\\n'\n`,
    );

    await chmod(executable, 0o755);

    await writeFile(
      join(release, 'codex-package.json'),
      JSON.stringify({ version }),
    );

    artifacts.set(version, {
      runtime: 'codex',
      root,
      launcher,
      executable,
      version,
      digest: await artifactDigest('codex', executable),
      channel: 'latest',
      automatic: false,
    });
  }

  await symlink(artifacts.get(installed)!.executable, launcher);

  const registration = {
    adapter: new FixtureAgent('codex', 'Fixture Codex'),
    executable: launcher,
  };

  const store = new RuntimeUpdateStore(join(directory, 'updates'));

  const notices: string[] = [];

  const installs: string[] = [];

  const policy: Partial<RuntimeInstallation> = {};

  const build = { current: 'fixture-build' };

  let checks = 0;

  const inspect = async (selection?: { executable?: string }) => {
    const executable = await realpath(selection?.executable ?? launcher);

    const selected = [...artifacts.values()].find(
      (artifact) => artifact.executable === executable,
    );

    assert.ok(selected, 'the fixture selects one of its native artifacts');

    return { ...selected, ...policy };
  };

  const native: NativeUpdateOperations = {
    inspect,
    earlier: earlierArtifact,
    check: async (installation) => {
      checks++;

      return {
        installation,
        target: '2.0.0',
        source: 'https://releases.openai.com/codex/channels/latest',
        checkedAt: Date.now(),
        available: installation.version === '1.0.0',
        blocked: installation.blocked,
      };
    },
    users: async () => [],
    install: async (installation, target) => {
      assert.equal(installation.root, root);

      installs.push(target);

      const artifact = artifacts.get(target);

      assert.ok(artifact);

      await unlink(launcher);

      await symlink(artifact.executable, launcher);
    },
    prepare: async (previous, options) => ({
      directory: options.directory,
      runtime: 'codex',
      previous,
      sessionId: randomUUID(),
      model: 'fixture',
      marker: 'PREVIOUS_CONTEXT',
    }),
    verify: async (prepared, candidate, options) => ({
      profile: verificationProfile,
      build: options.build,
      runtime: 'codex',
      previous: prepared.previous,
      candidate,
      sdkVersion: 'fixture-sdk',
      evidenceDirectory: options.directory,
      model: 'fixture',
      completed: requiredNativeChecks(candidate.runtime),
      passed: true,
    }),
    startup: async (installation) => {
      assert.equal((await inspect()).digest, installation.digest);
    },
  };

  const updates = new RuntimeUpdates(
    host ?? {
      maintain: async (_runtime, run) => run(new AbortController().signal),
      notice: (message) => notices.push(message),
    },
    store,
    native,
    async () => [registration],
    async () => build.current,
  );

  await updates.check();

  const check = updates.snapshot.entries[0]!.check! as RuntimeUpdateCheck;

  return {
    updates,
    store,
    native,
    registration,
    root,
    directory,
    launcher,
    artifacts,
    notices,
    installs,
    policy,
    build,
    check,
    inspect,
    checks: () => checks,
  };
}
