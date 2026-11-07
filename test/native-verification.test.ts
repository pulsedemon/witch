import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import {
  prepareNativeUpdate,
  verifyNativeUpdate,
} from '../src/agents/native-verification.js';
import { verificationAdapter } from '../src/agents/native-verification-profile.js';
import { nativeScenario } from '../src/agents/native-scenario.js';
import { runtimeUpdateFixture } from './fixtures/runtime-updates.js';
import { FixtureAgent } from './fixtures/agent.js';
import { until } from './fixtures/within.js';
import { unlessGone } from '../src/persistence/json.js';

for (const [mode, expected] of [
  ['lost-context', /lost the previous conversation context/],
  ['exhausted', /Usage limit reached/],
  ['bypass', /did not request approval/],
  ['declined-write', /Declined write changed/],
  ['extra-tool', /unexpected tool/],
  ['timeout', /aborted|stop requested/i],
] as const) {
  test(`qualification refuses ${mode} and retains its incomplete report`, async () => {
    const f = await runtimeUpdateFixture();
    const abort = new AbortController();
    let preparing = true;
    const options = {
      directory: f.directory,
      build: 'checked-build',
      model: 'fixture',
      allowAccountUsage: true,
      signal: abort.signal,
      progress: () => {},
      launch: (
        _command: string,
        _args: string[],
        cwd: string,
        env: NodeJS.ProcessEnv,
        signal?: AbortSignal,
      ) =>
        spawn(
          process.execPath,
          [
            new URL('./fixtures/native-qualification.mjs', import.meta.url)
              .pathname,
            preparing ? 'prepare' : mode,
          ],
          { cwd, env, signal, stdio: 'pipe' },
        ),
    };
    try {
      const prepared = await prepareNativeUpdate(await f.inspect(), options);
      preparing = false;
      const candidate = f.artifacts.get('2.0.0')!;
      const verified = verifyNativeUpdate(prepared, candidate, options);
      const refused = assert.rejects(verified, expected);
      if (mode === 'timeout') {
        await until(
          'native recall waits',
          async () =>
            (await unlessGone(
              readFile(join(f.directory, 'resume/project/waiting')),
            )) !== undefined,
        );
        abort.abort();
      }
      await refused;
      const report = JSON.parse(
        await readFile(join(f.directory, 'qualification.json'), 'utf8'),
      );
      assert.equal(report.passed, false);
      assert.equal(report.build, 'checked-build');
      assert.equal(report.previous.digest, prepared.previous.digest);
      assert.equal(report.candidate.digest, candidate.digest);
      assert.match(report.error, expected);
      assert.ok(report.diagnostic);
      assert.equal(
        report.completed.includes('native approval and denial'),
        false,
      );
      const events = JSON.parse(
        await readFile(join(prepared.directory, 'recall-events.json'), 'utf8'),
      );
      assert.ok(events.length > 0);
    } finally {
      f.updates.close();
    }
  });
}

test('controlled Claude launches keep hooks and user MCP out while preserving isolated sessions', async () => {
  const f = await runtimeUpdateFixture();
  let observed: { args: string[]; env: NodeJS.ProcessEnv } | undefined;
  const adapter = await verificationAdapter(
    'claude',
    f.directory,
    (_command, args, _cwd, env) => {
      observed = { args, env };
      throw new Error('Launch observed');
    },
  );
  try {
    await assert.rejects(
      adapter.connect({
        cwd: f.directory,
        executable: '/native/claude',
        memoryDirectories: [],
        onEvent: () => {},
        onProcess: async () => {},
      }),
      /Launch observed/,
    );
    assert.ok(observed);
    assert.ok(observed.args.includes('--setting-sources=project'));
    assert.ok(observed.args.includes('--strict-mcp-config'));
    assert.ok(observed.args.includes('{"disableAllHooks":true}'));
    assert.equal(observed.env.CLAUDE_CONFIG_DIR, join(f.directory, 'config'));
    assert.equal(observed.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, '');
    assert.equal(observed.env.DISABLE_AUTOUPDATER, '1');
  } finally {
    f.updates.close();
  }
});

test('a failed control turn reports its native diagnostic without waiting for a nonexistent tool', async () => {
  const f = await runtimeUpdateFixture();
  const adapter = new FixtureAgent('codex');
  adapter.failNext = true;
  try {
    await assert.rejects(
      nativeScenario(
        adapter,
        { cwd: f.directory, executable: 'fixture', memoryDirectories: [] },
        'control',
      ),
      /Overloaded/,
    );
    assert.ok(adapter.sessions.every(({ session }) => session.closed));
  } finally {
    f.updates.close();
  }
});
