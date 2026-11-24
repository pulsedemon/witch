import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import {
  prepareNativeCheck,
  runNativeCheck,
} from '../../../src/agents/native-check/native-verification.js';
import { verificationAdapter } from '../../../src/agents/native-check/native-verification-profile.js';
import { nativeScenario } from '../../../src/agents/native-check/native-scenario.js';
import { inspectArtifact } from '../../../src/agents/native-check/artifact.js';
import { scratch } from '../../fixtures/scratch.js';
import { FixtureAgent } from '../../fixtures/agent.js';
import { until, within } from '../../fixtures/within.js';
import { checkNativeAnswer } from '../../../src/agents/native-check/native-answer-check.js';
import { checkCodexAnswerSandbox } from '../../../src/agents/native-check/native-sandbox-check.js';
import { unlessGone } from '../../../src/persistence/json.js';

/** two versioned fake Codex executables, inspected as the check reads them. */
async function artifacts() {
  const directory = await scratch('witch-native-check-');

  const artifact = async (version: string) => {
    const executable = join(directory, `codex-${version}`);

    await writeFile(
      executable,
      `#!/bin/sh\nprintf 'codex-cli ${version}\\n'\n`,
    );

    await chmod(executable, 0o755);

    return inspectArtifact('codex', executable);
  };

  return {
    directory,
    previous: await artifact('1.0.0'),
    candidate: await artifact('2.0.0'),
  };
}

for (const [mode, expected] of [
  ['lost-context', /lost the previous conversation context/],
  ['exhausted', /Usage limit reached/],
  ['bypass', /did not request approval/],
  ['declined-write', /Declined write changed/],
  ['extra-tool', /unexpected tool/],
  ['other-command', /Unexpected probe command: node other\.mjs/],
  ['timeout', /aborted|stop requested/i],
] as const) {
  test(`qualification refuses ${mode} and retains its incomplete report`, async () => {
    const f = await artifacts();
    const abort = new AbortController();
    let preparing = true;

    const options = {
      directory: f.directory,
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
            new URL('../../fixtures/native-qualification.mjs', import.meta.url)
              .pathname,
            preparing ? 'prepare' : mode,
          ],
          { cwd, env, signal, stdio: 'pipe' },
        ),
    };

    const prepared = await prepareNativeCheck(f.previous, options);
    preparing = false;
    const candidate = f.candidate;
    const verified = runNativeCheck(prepared, candidate, options);
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
  });
}

test('controlled Claude launches keep hooks and user MCP out while preserving isolated sessions', async () => {
  const f = await artifacts();
  let observed: { args: string[]; env: NodeJS.ProcessEnv } | undefined;

  const adapter = await verificationAdapter('claude', f.directory, {
    start: (_command, args, _cwd, env) => {
      observed = { args, env };

      throw new Error('Launch observed');
    },
  });

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
});

test('Claude allow rules travel in flag settings beside disabled hooks', async () => {
  const f = await artifacts();
  let observed: string[] | undefined;

  const adapter = await verificationAdapter('claude', f.directory, {
    allow: ["Bash('/bin/node' '/project/helper.mjs':*)"],
    start: (_command, args) => {
      observed = args;

      throw new Error('Launch observed');
    },
  });

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

  assert.deepEqual(JSON.parse(observed[observed.indexOf('--settings') + 1]!), {
    disableAllHooks: true,
    permissions: { allow: ["Bash('/bin/node' '/project/helper.mjs':*)"] },
  });
});

test('a failed control turn reports its native diagnostic without waiting for a nonexistent tool', async () => {
  const f = await artifacts();
  const adapter = new FixtureAgent('codex');
  adapter.failNext = true;

  await assert.rejects(
    nativeScenario(
      adapter,
      { cwd: f.directory, executable: 'fixture', memoryDirectories: [] },
      'control',
    ),
    /Overloaded/,
  );

  assert.ok(adapter.sessions.every(({ session }) => session.closed));
});

for (const kind of ['answer', 'sandbox'] as const) {
  test(`${kind} qualification cancellation stops the restricted child and retains evidence`, async () => {
    const f = await artifacts();
    const executable = join(f.directory, 'fake-codex.mjs');

    await copyFile(
      new URL('../../fixtures/native-qualification.mjs', import.meta.url),
      executable,
    );

    await chmod(executable, 0o700);
    const abort = new AbortController();

    const directory =
      kind === 'answer' ? f.directory : join(f.directory, 'builtin');

    const running =
      kind === 'answer'
        ? checkNativeAnswer(
            { ...f.previous, executable },
            'fixture',
            f.directory,
            abort.signal,
          )
        : checkCodexAnswerSandbox(executable, f.directory, abort.signal);

    const refused = assert.rejects(running, /aborted/i);

    try {
      await until(
        'restricted native answer starts',
        async () =>
          (await unlessGone(readFile(join(directory, 'answer-started')))) !==
          undefined,
      );

      const children = (
        await readFile(join(directory, 'children.jsonl'), 'utf8')
      )
        .trim()
        .split('\n')
        .map(Number);

      assert.equal(children.length, 2);
      abort.abort(new Error('Qualification cancelled'));
      await within(refused, 3000, 'qualification cancellation');

      const evidence = JSON.parse(
        await readFile(
          join(
            directory,
            kind === 'answer'
              ? 'boundary-evidence.json'
              : 'sandbox-evidence.json',
          ),
          'utf8',
        ),
      );

      if (kind === 'sandbox') assert.match(evidence.error, /aborted/i);
      else assert.ok(Array.isArray(evidence.answerEvents));

      for (const pid of children)
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    } finally {
      abort.abort();

      const recorded = await unlessGone(
        readFile(join(directory, 'children.jsonl'), 'utf8'),
      );

      for (const pid of recorded?.trim().split('\n').map(Number) ?? []) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (error) {
          assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH');
        }
      }

      await running.catch(() => {});
      await refused.catch(() => {});
    }
  });
}
