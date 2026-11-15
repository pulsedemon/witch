import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { constants, promises as files } from 'node:fs';
import { chmod, open, readdir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { onTestFinished, test, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { refreshInstall } from '../../../src/core/repository/merged.js';
import type { MergeCleanup } from '../../../src/core/repository/merged.js';
import { sharedRebuild } from '../../../src/core/repository/shared-rebuild.js';
import { openLocked } from '../../../src/persistence/lock.js';
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
  const later = worker(install);
  await later.stage('waiting');
  builder.child.send('finish');
  const result = await builder.result;
  assert.equal(result.text, rebuilt);
  assert.equal((await later.result).text, rebuilt);
  assert.deepEqual((await later.result).calls, []);
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

for (const outcome of ['rebuilt', 'failed', 'interrupted'])
  for (const failure of ['completion admission', 'receipt write'])
    test(`a failed ${failure} after ${outcome} releases its waiter and allows a later rebuild`, async () => {
      const root = await scratch('witch-rebuild-receipt-');
      const sample = await open(join(root, 'sample'), 'w');
      const prototype = Object.getPrototypeOf(sample) as FileHandle;
      const write = prototype.writeFile;
      await sample.close();

      const publish = vi
        .spyOn(prototype, 'writeFile')
        .mockImplementation(async function (this: FileHandle, data, options) {
          if (
            failure === 'receipt write' &&
            typeof data === 'string' &&
            /^\{"(?:result|error)":/.test(data)
          )
            throw new Error('ENOSPC: receipt publication failed');

          return write.call(this, data, options);
        });

      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const waiting = Promise.withResolvers<void>();
      const abort = new AbortController();
      const builderAbort = new AbortController();

      const reason = new Error(
        outcome === 'failed'
          ? 'build failed\ncompiler diagnostic'
          : 'build cancelled',
      );

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

          if (outcome === 'failed') throw reason;

          builderAbort.signal.throwIfAborted();

          return { text: 'rebuilt', built: true };
        },
        { ...options, signal: builderAbort.signal },
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

        if (failure === 'completion admission')
          await chmod(join(root, 'witch-rebuild.lock'), 0);

        if (outcome === 'interrupted') builderAbort.abort(reason);

        release.resolve();

        if (outcome === 'rebuilt')
          await assert.rejects(
            builder,
            failure === 'completion admission' ? /EACCES/ : /ENOSPC/,
          );
        else await assert.rejects(builder, (error) => error === reason);

        await assert.rejects(
          within(waiter, 5000, 'the failed publication'),
          /without reporting a result.*unconfirmed/,
        );

        publish.mockRestore();
        await chmod(join(root, 'witch-rebuild.lock'), 0o600);

        assert.deepEqual(
          await sharedRebuild(
            root,
            async () => ({ text: 'later rebuild', built: true }),
            options,
          ),
          { text: 'later rebuild', built: true },
        );
      } finally {
        await chmod(join(root, 'witch-rebuild.lock'), 0o600);
        publish.mockRestore();
        release.resolve();
        abort.abort();
        builderAbort.abort();
        await Promise.allSettled([builder, waiter]);
      }
    });

test('failed attempt setup removes its receipt and permits another rebuild', async () => {
  const root = await scratch('witch-rebuild-setup-');
  const sample = await open(join(root, 'sample'), 'w');
  const prototype = Object.getPrototypeOf(sample) as FileHandle;
  const write = prototype.writeFile;
  const failure = new Error('ENOSPC: state publication failed');
  await sample.close();

  const publish = vi
    .spyOn(prototype, 'writeFile')
    .mockImplementation(async function (this: FileHandle, data, options) {
      if (typeof data === 'string' && /^\{\s*"id":/.test(data)) throw failure;

      return write.call(this, data, options);
    });

  const options = {
    waiting: () => assert.fail('a failed setup must not be joined'),
    failure: (error: unknown) => error as Error,
  };

  try {
    await assert.rejects(
      sharedRebuild(
        root,
        async () => assert.fail('setup must succeed before building'),
        options,
      ),
      (error) => error === failure,
    );

    assert.deepEqual((await readdir(root)).sort(), [
      'sample',
      'witch-rebuild.lock',
    ]);
  } finally {
    publish.mockRestore();
  }

  assert.deepEqual(
    await sharedRebuild(
      root,
      async () => ({ text: 'later rebuild', built: true }),
      options,
    ),
    { text: 'later rebuild', built: true },
  );
});

for (const mode of ['state', 'all', 'unpublished', 'all-unpublished'])
  test(`a ${mode} removal failure releases waiters and permits a fresh attempt after recovery`, async () => {
    const root = await scratch('witch-rebuild-removal-');
    const state = join(root, 'witch-rebuild.json');
    const sample = await open(join(root, 'sample'), 'w');
    const prototype = Object.getPrototypeOf(sample) as FileHandle;
    const write = prototype.writeFile;
    const remove = files.rm;
    const removalError = new Error('EACCES: state removal failed');
    const publicationError = new Error('ENOSPC: publication failed');
    let blocked = false;
    await sample.close();

    const removing = vi
      .spyOn(files, 'rm')
      .mockImplementation(async (path, options) => {
        if (
          blocked &&
          (String(path) === state ||
            ((mode === 'all' || mode === 'all-unpublished') &&
              String(path).startsWith(join(root, 'witch-rebuild-'))))
        )
          throw removalError;

        return remove(path, options);
      });

    syncBuiltinESMExports();

    const publishing = vi
      .spyOn(prototype, 'writeFile')
      .mockImplementation(async function (this: FileHandle, data, options) {
        if (
          blocked &&
          (mode === 'unpublished' || mode === 'all-unpublished') &&
          typeof data === 'string' &&
          data.startsWith('{"')
        )
          throw publicationError;

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

        return { text: 'first rebuild', built: true };
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
    let second: typeof waiter | undefined;
    let probe: FileHandle | undefined;

    try {
      await waiting.promise;

      if (mode === 'all-unpublished') {
        const joined = Promise.withResolvers<void>();

        second = sharedRebuild(
          root,
          async () => assert.fail('the second waiter must not rebuild'),
          { ...options, waiting: () => joined.resolve() },
        );

        void second.catch(() => {});
        await within(joined.promise, 5000, 'the second waiter');
      }

      blocked = true;
      release.resolve();

      await assert.rejects(
        builder,
        (error) =>
          error ===
          (mode.includes('unpublished') ? publicationError : removalError),
      );

      if (mode.includes('unpublished'))
        await assert.rejects(
          within(waiter, 5000, 'the unpublished receipt'),
          /without reporting a result.*unconfirmed/,
        );
      else
        assert.deepEqual(await within(waiter, 5000, 'the published receipt'), {
          text: 'first rebuild',
          built: true,
        });

      if (second)
        await assert.rejects(
          within(second, 5000, 'the second unpublished receipt'),
          /without reporting a result.*unconfirmed/,
        );

      assert.equal((await readdir(root)).includes('witch-rebuild.json'), true);

      if (mode !== 'all' && mode !== 'all-unpublished')
        assert.deepEqual(
          (await readdir(root)).filter((name) =>
            name.startsWith('witch-rebuild-'),
          ),
          [],
        );

      blocked = false;

      if (mode === 'all' || mode === 'all-unpublished') {
        const name = (await readdir(root)).find((name) =>
          name.startsWith('witch-rebuild-'),
        );

        assert.ok(name);

        probe = await openLocked(join(root, name), constants.O_RDONLY, {
          shared: true,
        });
      }

      assert.deepEqual(
        await sharedRebuild(
          root,
          async () => ({ text: 'later rebuild', built: true }),
          options,
        ),
        { text: 'later rebuild', built: true },
      );

      assert.deepEqual((await readdir(root)).sort(), [
        'sample',
        'witch-rebuild.lock',
      ]);
    } finally {
      await probe?.close();
      removing.mockRestore();
      publishing.mockRestore();
      syncBuiltinESMExports();
      release.resolve();
      abort.abort();
      await Promise.allSettled([builder, waiter, second]);
    }
  });

for (const point of ['initial', 'completion', 'receipt', 'lifetime'])
  test(`a ${point} close failure preserves the operation error and releases every descriptor`, async () => {
    const root = await scratch('witch-rebuild-close-');
    const actual = files.open;
    const handles: FileHandle[] = [];
    const closing: MockInstance<FileHandle['close']>[] = [];
    const order: string[] = [];
    const fault = new Error('close failed');

    const reason = new Error(
      point === 'completion'
        ? 'build failed\ncompiler diagnostic'
        : 'cancelled',
    );

    const abort = new AbortController();
    let admissions = 0;
    let injected = false;
    let built = false;

    const opening = vi
      .spyOn(files, 'open')
      .mockImplementation(async (...args) => {
        const handle = await actual(...args);
        const path = String(args[0]);

        if (!path.startsWith(root)) return handle;

        handles.push(handle);
        const receipt = path.startsWith(join(root, 'witch-rebuild-'));

        const label =
          path === join(root, 'witch-rebuild.lock')
            ? `admission-${++admissions}`
            : receipt
              ? typeof args[1] === 'string'
                ? 'receipt'
                : 'lifetime'
              : 'state';

        const close = handle.close.bind(handle);

        closing.push(
          vi.spyOn(handle, 'close').mockImplementation(async () => {
            await close();
            order.push(label);

            const target =
              point === 'initial'
                ? label === 'admission-1'
                : point === 'completion'
                  ? label === 'admission-2'
                  : point === label;

            if (target && !injected) {
              injected = true;

              throw fault;
            }
          }),
        );

        return handle;
      });

    syncBuiltinESMExports();

    const options = {
      signal: abort.signal,
      waiting: () => assert.fail('the request must start fresh'),
      failure: (error: unknown) => error as Error,
    };

    try {
      await assert.rejects(
        sharedRebuild(
          root,
          async () => {
            built = true;

            if (point === 'completion') throw reason;

            if (point === 'lifetime') {
              abort.abort(reason);
              abort.signal.throwIfAborted();
            }

            return { text: 'first rebuild', built: true };
          },
          options,
        ),
        (error) =>
          error ===
          (point === 'completion' || point === 'lifetime' ? reason : fault),
      );

      assert.equal(injected, true);
      assert.equal(built, point !== 'initial');
      assert.ok(handles.every((handle) => handle.fd === -1));

      if (point === 'completion')
        assert.ok(order.indexOf('lifetime') < order.indexOf('admission-2'));

      assert.deepEqual(await readdir(root), ['witch-rebuild.lock']);
    } finally {
      opening.mockRestore();

      for (const close of closing) close.mockRestore();

      syncBuiltinESMExports();
    }

    assert.deepEqual(
      await sharedRebuild(
        root,
        async () => ({ text: 'later rebuild', built: true }),
        { ...options, signal: undefined },
      ),
      { text: 'later rebuild', built: true },
    );
  });

for (const outcome of ['failure', 'cancel', 'success'])
  test(`a checkout close failure after ${outcome} preserves error priority and releases the lock`, async () => {
    const { install, rebuilt } = await installation();
    const actual = files.open;
    const fault = new Error('checkout close failed');

    const reason = Object.assign(new Error('build failed'), {
      stdout: 'distinct compiler diagnostic',
    });

    const abort = new AbortController();
    let closed = false;
    let closing: MockInstance | undefined;

    const opening = vi
      .spyOn(files, 'open')
      .mockImplementation(async (...args) => {
        const handle = await actual(...args);

        if (String(args[0]) === join(install, '.git')) {
          const close = handle.close.bind(handle);

          closing = vi.spyOn(handle, 'close').mockImplementation(async () => {
            await close();
            closed = true;

            throw fault;
          });
        }

        return handle;
      });

    syncBuiltinESMExports();

    try {
      await assert.rejects(
        refreshInstall(
          install,
          'main',
          async (_, args) => {
            if (args[0] === 'build') {
              if (outcome === 'failure') throw reason;

              if (outcome === 'cancel') {
                abort.abort(reason);

                throw reason;
              }
            }

            return { stdout: '' };
          },
          { signal: abort.signal },
        ),
        (error) => {
          if (outcome === 'cancel') return error === reason;

          assert.ok(error instanceof Error);
          assert.equal(error.cause, outcome === 'failure' ? reason : fault);

          if (outcome === 'failure')
            assert.match(error.message, /distinct compiler diagnostic/);

          return true;
        },
      );

      assert.equal(closed, true);
    } finally {
      opening.mockRestore();
      closing?.mockRestore();
      syncBuiltinESMExports();
    }

    assert.equal(
      await refreshInstall(install, 'main', async () => ({ stdout: '' })),
      rebuilt,
    );
  });

for (const mode of ['acquisition', 'collision'])
  test(`receipt ${mode} failure removes only exclusively owned artifacts`, async () => {
    const root = await scratch('witch-rebuild-create-');
    const actual = files.open;
    const handles: FileHandle[] = [];
    const fault = new Error('ENOLCK: lifetime lock failed');
    let injected = false;
    let collision = '';

    const opening = vi
      .spyOn(files, 'open')
      .mockImplementation(async (...args) => {
        const path = String(args[0]);
        const receipt = path.startsWith(join(root, 'witch-rebuild-'));

        if (!injected && receipt) {
          if (mode === 'acquisition' && typeof args[1] === 'number') {
            injected = true;

            throw fault;
          }

          if (mode === 'collision' && args[1] === 'wx+') {
            injected = true;
            collision = path;
            const existing = await actual(...args);
            await existing.writeFile('must stay');
            await existing.close();
          }
        }

        const handle = await actual(...args);

        if (path.startsWith(root)) handles.push(handle);

        return handle;
      });

    syncBuiltinESMExports();

    const options = {
      waiting: () => assert.fail('the request must start fresh'),
      failure: (error: unknown) => error as Error,
    };

    try {
      await assert.rejects(
        sharedRebuild(
          root,
          async () => assert.fail('setup must complete before building'),
          options,
        ),
        (error) =>
          mode === 'collision'
            ? (error as NodeJS.ErrnoException).code === 'EEXIST'
            : error === fault,
      );

      assert.equal(injected, true);
      assert.ok(handles.every((handle) => handle.fd === -1));

      if (mode === 'collision')
        assert.equal(await files.readFile(collision, 'utf8'), 'must stay');
      else assert.deepEqual(await readdir(root), ['witch-rebuild.lock']);
    } finally {
      opening.mockRestore();
      syncBuiltinESMExports();
    }

    assert.deepEqual(
      await sharedRebuild(
        root,
        async () => ({ text: 'later rebuild', built: true }),
        options,
      ),
      { text: 'later rebuild', built: true },
    );

    if (collision)
      assert.equal(await files.readFile(collision, 'utf8'), 'must stay');
  });
