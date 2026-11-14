import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { close, fixture } from '../../fixtures/codex-adapter.js';

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
