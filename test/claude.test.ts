import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ClaudeAdapter } from '../src/agents/claude.js';
import type { AgentEvent } from '../src/agents/types.js';

async function fixture(onEvent: (event: AgentEvent) => void = () => {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'harness-claude-'));
  const adapter = new ClaudeAdapter((options) => {
    assert.ok(options.args.some((arg) => arg.includes('user,project,local')));
    assert.equal(options.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, '1');
    return spawn(process.execPath, [resolve('test/fixtures/claude.mjs')], {
      cwd,
      stdio: 'pipe',
      signal: options.signal,
    });
  });
  const session = await adapter.connect({
    cwd,
    executable: '/fake/claude',
    memoryDirectories: [],
    onEvent,
    onProcess: async () => {},
  });
  return { session, cwd };
}

await test('refresh consumes a fresh native catalog without replacing the default system prompt', async () => {
  const { session, cwd } = await fixture();
  try {
    assert.deepEqual(
      (await session.models()).map((model) => model.id),
      ['claude-a'],
    );
    assert.deepEqual(
      (await session.models(true)).map((model) => model.id),
      ['claude-b'],
    );
    const initialize = JSON.parse(
      await readFile(join(cwd, 'initialize.json'), 'utf8'),
    );
    assert.equal(initialize.systemPrompt, undefined);
  } finally {
    await session.close();
  }
});

await test('a result before native idle does not finish the turn', async () => {
  const { session, cwd } = await fixture();
  try {
    let completed = false;
    const turn = session.send('wait for idle').then((value) => {
      completed = true;
      return value;
    });
    while (
      !(await access(join(cwd, 'prompt.txt')).then(
        () => true,
        () => false,
      ))
    )
      await delay(5);
    await delay(30);
    assert.equal(completed, false);
    await writeFile(join(cwd, 'allow-idle'), 'yes');
    assert.deepEqual(await turn, { status: 'completed', text: 'Finished.' });
  } finally {
    await session.close();
  }
});

for (const decision of ['accept', 'decline'] as const) {
  await test(`Claude approval ${decision} returns the matching tool decision`, async () => {
    const { session, cwd } = await fixture((event) => {
      if (event.type === 'request')
        active.respond(event.request.id, { decision });
    });
    const active = session;
    try {
      assert.equal((await session.send('approval')).status, 'completed');
      if (decision === 'accept')
        assert.equal(
          await readFile(join(cwd, 'approved.txt'), 'utf8'),
          'accepted',
        );
      else await assert.rejects(access(join(cwd, 'approved.txt')));
    } finally {
      await session.close();
    }
  });
}
