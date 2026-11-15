import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { close, fixture } from '../../fixtures/codex-adapter.js';
import { readContextCatalog } from '../../../src/agents/codex/compaction-policy.js';
import { appears, until } from '../../fixtures/within.js';

test("a model missing from Codex's catalog is refused, while a hidden one passes", async () => {
  const { session, cwd } = await fixture();

  try {
    await assert.rejects(
      session.checkModel!('claude-sonnet-5-5'),
      /Codex has no model claude-sonnet-5-5/,
    );

    await session.checkModel!('model-hidden');
  } finally {
    await close(session, cwd);
  }
});

test('a failed picker refresh leaves no listed model to pass a selection unchecked', async () => {
  const { session, cwd } = await fixture();

  try {
    assert.ok((await session.models()).some(({ id }) => id === 'model-b'));
    await writeFile(join(cwd, 'models-fail'), '');
    await assert.rejects(session.models(), /model\/list failed/);
    await assert.rejects(session.checkModel!('model-b'), /model\/list failed/);
  } finally {
    await close(session, cwd);
  }
});

test('standalone model discovery includes native usable context choices', async () => {
  const f = await fixture(undefined, {
    contextCatalog: async () => ({
      models: [
        {
          slug: 'model-a',
          context_window: 272_000,
          max_context_window: 872_000,
          effective_context_window_percent: 95,
        },
      ],
    }),
  });

  try {
    const models = await f.adapter.models({ cwd: f.cwd, executable: 'codex' });

    assert.deepEqual(
      models.find((model) => model.id === 'model-a')?.contextWindows,
      { default: 258_400, maximum: 828_400 },
    );

    assert.equal(
      models.find((model) => model.id === 'model-b')?.contextWindows,
      undefined,
    );
  } finally {
    await close(f.session, f.cwd);
  }
});

test('failed standalone discovery settles with no catalog read still active', async () => {
  const finished = Promise.withResolvers<void>();
  let active = false;

  const f = await fixture(undefined, {
    contextCatalog: async ({ signal }) => {
      active = true;
      const stop = () => finished.resolve();
      signal?.addEventListener('abort', stop, { once: true });

      try {
        await finished.promise;

        return { models: [] };
      } finally {
        active = false;
        signal?.removeEventListener('abort', stop);
      }
    },
  });

  try {
    await writeFile(join(f.cwd, 'models-fail'), '');

    await assert.rejects(
      f.adapter.models({ cwd: f.cwd, executable: 'codex' }),
      /model\/list failed/,
    );

    assert.equal(active, false);
  } finally {
    finished.resolve();
    await close(f.session, f.cwd);
  }
});

test('canceled discovery joins a catalog child that ignores SIGTERM', async () => {
  const f = await fixture(undefined, { contextCatalog: readContextCatalog });
  const controller = new AbortController();
  let pid: number | undefined;
  let outcome: Promise<unknown> | undefined;

  const exited = (pid: number) => {
    try {
      process.kill(pid, 0);

      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;

      throw error;
    }
  };

  try {
    const executable = join(f.cwd, 'catalog-child');
    const ready = join(f.cwd, 'catalog-ready');

    await writeFile(
      executable,
      `#!${process.execPath}
process.on('SIGTERM', () => {});
require('node:fs').writeFileSync('catalog-ready.tmp', String(process.pid));
require('node:fs').renameSync('catalog-ready.tmp', 'catalog-ready');
setInterval(() => {}, 1000);
`,
      { mode: 0o755 },
    );

    outcome = f.adapter
      .models({ cwd: f.cwd, executable, signal: controller.signal })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    await appears(ready);
    pid = Number(await readFile(ready, 'utf8'));
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    controller.abort();
    const error = await outcome;
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'AbortError');
    assert.equal(exited(pid), true);
  } finally {
    controller.abort();

    if (pid !== undefined && !exited(pid)) process.kill(pid, 'SIGKILL');

    if (pid !== undefined)
      await until('catalog child exits', () => exited(pid!));

    await outcome;
    await close(f.session, f.cwd);
  }
});
