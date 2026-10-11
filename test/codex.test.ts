import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { CodexAdapter } from '../src/agents/codex.js';
import type { AgentEvent } from '../src/agents/types.js';

async function fixture(onEvent: (event: AgentEvent) => void = () => {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'witch-codex-'));
  const adapter = new CodexAdapter((_, directory) =>
    spawn(process.execPath, [resolve('test/fixtures/codex.mjs')], {
      cwd: directory,
      stdio: 'pipe',
    }),
  );
  const session = await adapter.connect({
    cwd,
    executable: 'codex',
    memoryDirectories: ['/shared/global', '/shared/project'],
    onEvent,
    onProcess: async () => {},
  });
  return { session, cwd };
}

await test('loads every model page and preserves native roots without overriding instructions', async () => {
  const { session, cwd } = await fixture();
  try {
    assert.deepEqual(
      (await session.models()).map((model) => [model.id, model.efforts]),
      [
        ['model-a', ['low']],
        ['model-b', ['high']],
      ],
    );
    const start = JSON.parse(await readFile(join(cwd, 'start.json'), 'utf8'));
    assert.equal(start.params.baseInstructions, undefined);
    assert.equal(start.params.developerInstructions, undefined);
    assert.deepEqual(
      start.params.config['sandbox_workspace_write.writable_roots'],
      ['/already-allowed', '/shared/global', '/shared/project'],
    );
  } finally {
    await session.close();
  }
});

for (const decision of ['accept', 'decline'] as const) {
  await test(`native approval ${decision} controls the requested side effect`, async () => {
    const { session, cwd } = await fixture((event) => {
      if (event.type === 'request')
        active.respond(event.request.id, { decision });
    });
    const active = session;
    try {
      await session.selectModel('model-b', 'high');
      assert.equal(session.info.model, 'model-b');
      assert.deepEqual(await session.send('do the task'), {
        status: 'completed',
        text: 'Finished.',
      });
      const prompt = JSON.parse(
        await readFile(join(cwd, 'prompt.json'), 'utf8'),
      );
      assert.equal(prompt.params.effort, 'high');
      assert.equal(prompt.params.input[0].text, 'do the task');
      if (decision === 'accept')
        assert.equal(
          await readFile(join(cwd, 'approved.txt'), 'utf8'),
          'approved',
        );
      else await assert.rejects(access(join(cwd, 'approved.txt')));
    } finally {
      await session.close();
    }
  });
}

await test('interrupt waits for a native terminal state before returning', async () => {
  const { session } = await fixture();
  try {
    const turn = session.send('wait');
    await session.interrupt();
    assert.equal((await turn).status, 'interrupted');
  } finally {
    await session.close();
  }
});

await test('native secret questions and MCP form answers reach their protocol consumers unchanged', async () => {
  const { session, cwd } = await fixture((event) => {
    if (event.type !== 'request') return;
    if (event.request.kind === 'question') {
      assert.equal(event.request.questions?.[0]?.secret, true);
      session.respond(event.request.id, {
        decision: 'accept',
        answers: { value: ['red, green'] },
      });
    } else if (event.request.kind === 'elicitation') {
      assert.deepEqual(event.request.schema, {
        type: 'object',
        properties: { label: { type: 'string' } },
      });
      session.respond(event.request.id, {
        decision: 'accept',
        content: { label: 'violet' },
      });
    }
  });
  try {
    await session.send('question');
    assert.deepEqual(
      JSON.parse(await readFile(join(cwd, 'response-88.json'), 'utf8')),
      { answers: { value: { answers: ['red, green'] } } },
    );
    await session.send('elicitation');
    assert.deepEqual(
      JSON.parse(await readFile(join(cwd, 'response-89.json'), 'utf8')),
      { action: 'accept', content: { label: 'violet' }, _meta: null },
    );
  } finally {
    await session.close();
  }
});
