import assert from 'node:assert/strict';
import { test } from 'vitest';
import { close, fixture } from './fixtures/codex-adapter.js';

test("a model missing from Codex's catalog is refused and kept off the thread, while a hidden one applies", async () => {
  const { session, cwd } = await fixture();
  try {
    await assert.rejects(
      session.selectModel('claude-sonnet-5-5'),
      /Codex has no model claude-sonnet-5-5/,
    );
    assert.equal(session.info.model, 'model-a');
    await session.selectModel('model-hidden');
    assert.equal(session.info.model, 'model-hidden');
  } finally {
    await close(session, cwd);
  }
});
