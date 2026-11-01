import assert from 'node:assert/strict';
import { test } from 'vitest';
import { close, fixture } from './fixtures/codex-adapter.js';

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
