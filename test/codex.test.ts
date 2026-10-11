import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { CodexAdapter } from '../src/agents/codex.js';
import type { AgentEvent, AgentSession } from '../src/agents/types.js';

const codex = fileURLToPath(new URL('fixtures/codex.mjs', import.meta.url));

async function fixture(
  onEvent: (event: AgentEvent) => void = () => {},
  effort?: string,
) {
  const cwd = await mkdtemp(join(tmpdir(), 'witch-codex-'));
  const adapter = new CodexAdapter((_, directory) =>
    spawn(process.execPath, [codex], { cwd: directory, stdio: 'pipe' }),
  );
  const session = await adapter.connect({
    cwd,
    executable: 'codex',
    effort,
    memoryDirectories: ['/shared/global', '/shared/project'],
    onEvent,
    onProcess: async () => {},
  });
  return { session, cwd };
}

/** lets a held fixture event go, so a reverted guard can't hang cleanup. */
async function close(session: AgentSession, cwd: string) {
  await writeFile(join(cwd, 'release'), 'yes');
  await session.close();
}

async function within<T>(promise: Promise<T>, milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no result within ${milliseconds} ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function appears(path: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (
      await access(path).then(
        () => true,
        () => false,
      )
    )
      return;
    await delay(10);
  }
  assert.fail(`${path} never appeared`);
}

function settled(promise: Promise<unknown>) {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  return () => done;
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
    await close(session, cwd);
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
      await close(session, cwd);
    }
  });
}

await test('interrupt waits for the native turn to complete', async () => {
  const { session, cwd } = await fixture();
  try {
    const turn = session.send('hold');
    await appears(join(cwd, 'prompt.json'));
    const interrupting = session.interrupt();
    const done = settled(interrupting);
    await appears(join(cwd, 'replied'));
    await delay(50);
    assert.equal(done(), false);
    await writeFile(join(cwd, 'release'), 'yes');
    await within(interrupting, 2000);
    assert.equal((await turn).status, 'interrupted');
  } finally {
    await close(session, cwd);
  }
});

await test('model selection waits for the settings notification', async () => {
  const { session, cwd } = await fixture();
  try {
    const selecting = session.selectModel('held');
    const done = settled(selecting);
    await appears(join(cwd, 'replied'));
    await delay(50);
    assert.equal(done(), false);
    await writeFile(join(cwd, 'release'), 'yes');
    await within(selecting, 2000);
  } finally {
    await close(session, cwd);
  }
});

await test('malformed notifications post one notice per method and the turn completes', async () => {
  const notices: string[] = [];
  const { session, cwd } = await fixture((event) => {
    if (event.type === 'notice') notices.push(event.text);
  });
  try {
    assert.equal(
      (await within(session.send('malformed'), 2000)).status,
      'completed',
    );
    assert.equal(notices.length, 1);
    assert.match(notices[0]!, /item\/agentMessage\/delta/);
  } finally {
    await close(session, cwd);
  }
});

await test('a malformed settings notification fails the model change', async () => {
  const { session, cwd } = await fixture();
  try {
    await assert.rejects(within(session.selectModel('bad-settings'), 2000));
  } finally {
    await close(session, cwd);
  }
});

for (const [prompt, error] of [
  ['null-turn', /turn\/completed/],
  ['in-progress', /status inProgress/],
  ['failed', /^native failure$/],
] as const) {
  await test(`a turn completed as ${prompt} fails only that turn`, async () => {
    const { session, cwd } = await fixture();
    try {
      const result = await within(session.send(prompt), 2000);
      assert.equal(result.status, 'failed');
      assert.match(result.error ?? '', error);
      assert.equal(session.closed, false);
    } finally {
      await close(session, cwd);
    }
  });
}

await test('an unparseable native request gets an error reply and the turn continues', async () => {
  const { session, cwd } = await fixture();
  try {
    assert.equal(
      (await within(session.send('bad-request'), 2000)).status,
      'completed',
    );
    assert.match(
      await readFile(join(cwd, 'error-90.json'), 'utf8'),
      /requestUserInput/,
    );
  } finally {
    await close(session, cwd);
  }
});

await test('a grandchild holding the native pipes cannot keep a dead turn open', async () => {
  const { session, cwd } = await fixture();
  try {
    const result = await within(session.send('grandchild'), 1000);
    assert.equal(result.status, 'failed');
  } finally {
    const pid = Number(
      await readFile(join(cwd, 'grandchild.pid'), 'utf8').catch(() => '0'),
    );
    if (pid) process.kill(pid, 'SIGKILL');
    await close(session, cwd).catch(() => {});
  }
});

await test('selecting a model without an effort keeps the effort in force', async () => {
  const { session, cwd } = await fixture();
  try {
    assert.equal(session.info.effort, 'low');
    await session.selectModel('model-a', 'high');
    await session.selectModel('model-b');
    assert.equal(session.info.effort, 'high');
  } finally {
    await close(session, cwd);
  }
});

await test('a fresh thread reports the requested effort over the native default', async () => {
  const { session, cwd } = await fixture(() => {}, 'high');
  try {
    assert.equal(session.info.effort, 'high');
  } finally {
    await close(session, cwd);
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
    await close(session, cwd);
  }
});
