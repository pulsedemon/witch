import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { onTestFinished, test, vi } from 'vitest';
import { refreshInstall } from '../../../src/core/repository/merged.js';
import type { MergeCleanup } from '../../../src/core/repository/merged.js';
import { sharedRebuild } from '../../../src/core/repository/shared-rebuild.js';
import { git } from '../../fixtures/git.js';
import { merged } from '../../fixtures/merged.js';
import { configureGitEnvironment } from '../../fixtures/merged-environment.js';
import { scratch } from '../../fixtures/scratch.js';
import { until, within } from '../../fixtures/within.js';

configureGitEnvironment();

interface WorkerResult {
  text?: string;
  error?: string;
  originalReason?: boolean;
  calls: string[][];
}

function worker(install: string, failing = false) {
  const child = fork(
    new URL('../../fixtures/shared-rebuild.mts', import.meta.url),
    [install, failing ? 'fail' : 'ok'],
    {
      cwd: install,
      execArgv: ['--import', import.meta.resolve('tsx')],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );

  const stages = new Set<string>();
  const result = Promise.withResolvers<WorkerResult>();
  const closed = Promise.withResolvers<void>();
  let stderr = '';

  child.stderr!.on('data', (data: Buffer) => (stderr += data.toString()));

  child.on('message', (message: { kind: string } & WorkerResult) => {
    stages.add(message.kind);

    if (message.kind === 'result') result.resolve(message);
  });

  child.once('error', result.reject);

  child.once('close', (code, signal) => {
    result.reject(
      new Error(`rebuild worker exited ${code ?? signal}: ${stderr}`),
    );

    closed.resolve();
  });

  void result.promise.catch(() => {});

  const outcome = within(result.promise, 10_000, 'the shared rebuild result');

  void outcome.catch(() => {});

  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');

    await closed.promise;
  });

  return {
    child,
    closed: closed.promise,
    result: outcome,
    stage: (stage: string) => until(stage, () => stages.has(stage), 500),
  };
}

async function installation() {
  const fixture = await merged();
  const install = join(fixture.root, 'install');

  await git(fixture.root, 'clone', fixture.origin, install);

  const head = await git(install, 'rev-parse', 'HEAD');

  return {
    ...fixture,
    install,
    head,
    rebuilt: `Rebuilt Witch at ${head.slice(0, 7)}, for its next start.`,
  };
}

test('a waiting process retains the failed attempt after a later rebuild succeeds', async () => {
  const { install, rebuilt } = await installation();
  const builder = worker(install, true);

  await builder.stage('build');

  const waiter = worker(install);

  await waiter.stage('waiting');

  waiter.child.kill('SIGSTOP');

  builder.child.send('finish');

  const failed = await builder.result;

  assert.match(failed.error!, /build failed\nsrc\/probe.ts: build diagnostic$/);

  const later = worker(install);

  await later.stage('build');

  later.child.send('finish');

  assert.equal((await later.result).text, rebuilt);

  waiter.child.kill('SIGCONT');

  const joined = await waiter.result;

  assert.equal(joined.error, failed.error);

  assert.deepEqual(joined.calls, []);

  assert.deepEqual(failed.calls, [['install', '--frozen-lockfile'], ['build']]);
});

test('cancelling a waiter leaves the builder running and reports the original reason', async () => {
  const { install, rebuilt } = await installation();
  const builder = worker(install);

  await builder.stage('build');

  const waiter = worker(install);

  await waiter.stage('waiting');

  waiter.child.send('cancel');

  const cancelled = await waiter.result;

  assert.equal(cancelled.error, 'rebuild cancelled');

  assert.equal(cancelled.originalReason, true);

  assert.deepEqual(cancelled.calls, []);

  assert.equal(builder.child.exitCode, null);

  builder.child.send('finish');

  const result = await builder.result;

  assert.equal(result.text, rebuilt);

  assert.deepEqual(result.calls, [['install', '--frozen-lockfile'], ['build']]);
});

test('an interrupted builder publishes interruption to its waiter', async () => {
  const { install } = await installation();
  const builder = worker(install);

  await builder.stage('build');

  const waiter = worker(install);

  await waiter.stage('waiting');

  builder.child.send('cancel');

  const cancelled = await builder.result;
  const joined = await waiter.result;

  assert.equal(cancelled.originalReason, true);

  assert.equal(joined.error, "Another Witch's rebuild was interrupted.");

  assert.deepEqual(joined.calls, []);
});

test('a killed builder cannot leave a prior success for its waiter and a later request can rebuild', async () => {
  const { install, rebuilt } = await installation();

  assert.equal(
    await refreshInstall(install, 'main', async () => ({ stdout: '' })),
    rebuilt,
  );

  const builder = worker(install);

  await builder.stage('build');

  const waiter = worker(install);

  await waiter.stage('waiting');

  builder.child.kill('SIGKILL');

  await builder.closed;

  const joined = await waiter.result;

  assert.match(joined.error!, /without reporting a result.*unconfirmed/);

  assert.deepEqual(joined.calls, []);

  assert.equal(
    await refreshInstall(install, 'main', async () => ({ stdout: '' })),
    rebuilt,
  );
});

test('a completed joined rebuild resumes without fetching or reporting an intervening revision', async () => {
  const { install, other, head, rebuilt } = await installation();
  const builder = worker(install);

  await builder.stage('build');

  const progress: NonNullable<MergeCleanup['install']> = {};
  const waiting = Promise.withResolvers<void>();
  const calls: string[][] = [];

  const run = async (_: string, args: string[]) => {
    calls.push(args);

    return { stdout: '' };
  };

  const joined = refreshInstall(install, 'main', run, {
    progress,
    notice: () => waiting.resolve(),
  });

  void joined.catch(() => {});

  await within(waiting.promise, 5000, 'joining the builder');

  builder.child.send('finish');

  assert.equal((await builder.result).text, rebuilt);

  assert.equal(await joined, rebuilt);

  assert.equal(progress.built, true);

  await git(other, 'commit', '--allow-empty', '-m', 'later');

  await git(other, 'push');

  assert.notEqual(await git(other, 'rev-parse', 'HEAD'), head);

  assert.equal(
    await refreshInstall(install, 'main', run, { progress }),
    rebuilt,
  );

  assert.equal(await git(install, 'rev-parse', 'HEAD'), head);

  assert.deepEqual(calls, []);
});

test('a failed receipt write releases its waiter and allows a later rebuild', async () => {
  const root = await scratch('witch-rebuild-receipt-');
  const sample = await open(join(root, 'sample'), 'w');
  const prototype = Object.getPrototypeOf(sample) as FileHandle;
  const write = prototype.writeFile;

  await sample.close();

  const publish = vi
    .spyOn(prototype, 'writeFile')
    .mockImplementation(async function (this: FileHandle, data, options) {
      if (typeof data === 'string' && data.startsWith('{"result":'))
        throw new Error('ENOSPC: receipt publication failed');

      return write.call(this, data, options);
    });

  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const waiting = Promise.withResolvers<void>();
  const abort = new AbortController();

  const options = {
    signal: abort.signal,
    waiting: () => waiting.resolve(),
    failure: (error: unknown) => error as Error,
  };

  const builder = sharedRebuild(
    root,
    async () => {
      entered.resolve();

      await release.promise;

      return { text: 'rebuilt', built: true };
    },
    options,
  );

  void builder.catch(() => {});

  await entered.promise;

  const waiter = sharedRebuild(
    root,
    async () => assert.fail('the waiter must not rebuild'),
    options,
  );

  void waiter.catch(() => {});

  try {
    await waiting.promise;

    release.resolve();

    await assert.rejects(builder, /ENOSPC/);

    await assert.rejects(
      within(waiter, 5000, 'the failed publication'),
      /without reporting a result.*unconfirmed/,
    );

    publish.mockRestore();

    assert.deepEqual(
      await sharedRebuild(
        root,
        async () => ({ text: 'later rebuild', built: true }),
        options,
      ),
      { text: 'later rebuild', built: true },
    );
  } finally {
    publish.mockRestore();

    release.resolve();

    abort.abort();

    await Promise.allSettled([builder, waiter]);
  }
});
